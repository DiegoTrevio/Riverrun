/** Importar la información del negocio (web, PDF, foto, CSV o texto) para llenar el conocimiento sin escribirlo a mano. */
import type { FastifyInstance } from 'fastify';
import { HttpError, requireRole, targetAccount } from '../access.js';
import { withTransaction } from '../db.js';
import type { AiProvider } from '../ai/provider.js';
import { checkImportRate, IMPORT_SECTIONS, importKnowledge, MAX_FILE_BYTES, sourceFromFile, sourceFromUrl, type ImportResult, type Source } from '../knowledge-import.js';
import { logEvent } from '../logs.js';
import * as store from '../store/index.js';
import { KNOWLEDGE_TITLES } from './onboarding.js';

/** Lee el formulario (dirección, texto o archivo) y obtiene el material. */
async function readSource(req: any): Promise<{ source: Source; url?: string; hint: string; save: boolean }> {
  let url = '';
  let text = '';
  let hint = '';
  let save = false;
  let file: { buffer: Buffer; mime: string; filename: string } | null = null;
  if (req.isMultipart?.()) {
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(400, 'El archivo pesa más de 8 MB');
        if (buffer.length) file = { buffer, mime: part.mimetype, filename: part.filename || 'archivo' };
      } else if (part.fieldname === 'url') url = String(part.value);
      else if (part.fieldname === 'text') text = String(part.value);
      else if (part.fieldname === 'hint') hint = String(part.value);
      else if (part.fieldname === 'save') save = part.value === 'true';
    }
  } else {
    const b = req.body ?? {};
    url = typeof b.url === 'string' ? b.url : '';
    text = typeof b.text === 'string' ? b.text : '';
    hint = typeof b.hint === 'string' ? b.hint : '';
    save = b.save === true;
  }
  if (file) return { source: sourceFromFile(file), hint, save };
  if (url.trim()) return { source: await sourceFromUrl(url), url: url.trim(), hint, save };
  if (text.trim().length >= 20) return { source: { kind: 'text', text: text.trim(), label: 'texto pegado' }, hint, save };
  throw new HttpError(400, 'Pega la dirección de tu página, sube un archivo o pega el texto con tu información.');
}

export async function knowledgeImportRoutes(api: FastifyInstance, ai: AiProvider) {
  const admins = { preHandler: requireRole('admin') };

  const run = async (req: any, accountId: string, chatbotId: string | null) => {
    checkImportRate(accountId);
    const input = await readSource(req);
    let result: ImportResult;
    try {
      result = await importKnowledge(ai, input.source, input.hint);
    } catch (e: any) {
      await logEvent({ level: 'warn', source: 'ai', message: `No se pudo importar el conocimiento: ${e?.message ?? e}`, accountId, chatbotId: chatbotId ?? undefined });
      throw e;
    }
    await store.insertAiRun({
      account_id: accountId,
      chatbot_id: chatbotId,
      conversation_id: null,
      kind: 'import',
      model: result.model,
      input_tokens: result.usage.input_tokens,
      cached_tokens: result.usage.cached_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
    });
    return { ...input, result };
  };

  const view = (r: ImportResult, url?: string) => ({ description: r.description, sections: r.sections, source: r.source, source_url: url ?? null, truncated: r.truncated });

  /** Durante el asistente de configuración: solo devuelve la propuesta; el cliente la revisa y la guarda con el paso 2. */
  api.post('/api/onboarding/import', admins, async (req: any) => {
    const accountId = await targetAccount(req.user, req.query.account_id);
    const { url, result } = await run(req, accountId, null);
    return view(result, url);
  });

  /**
   * En el conocimiento del chatbot: sin `save` devuelve la propuesta para revisarla;
   * con `save` la guarda (una sección por bloque, reemplazando la anterior) y recuerda la página para re-sincronizar.
   */
  api.post('/api/chatbots/:id/knowledge/import', admins, async (req: any) => {
    const bot = await store.getChatbot(req.params.id);
    if (!bot) throw new HttpError(404, 'No encontrado');
    const accountId = await targetAccount(req.user, bot.account_id);
    if (accountId !== bot.account_id) throw new HttpError(404, 'No encontrado');
    const { url, save, result } = await run(req, bot.account_id, bot.id);
    if (!save) return view(result, url);
    // Dos guardados a la vez (o uno mientras otro guarda) no pueden crear dos secciones con el mismo título:
    // se turnan por asistente con un candado consultivo. No se bloquean filas: el resto del sistema las escribe sin ese candado.
    const saved = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['knowledge:' + bot.id]);
      const items = await store.listKnowledge(bot.id);
      const titles: string[] = [];
      for (const k of IMPORT_SECTIONS) {
        const content = result.sections[k].trim();
        if (!content) continue;
        const [category, title] = KNOWLEDGE_TITLES[k];
        const prev = items.find((i) => i.title === title);
        await store.upsertKnowledge(bot.id, { id: prev?.id, category, title, content, active: true, always_include: k !== 'faq', source_url: url ?? null }, client);
        titles.push(title);
      }
      return titles;
    });
    await logEvent({ level: 'info', source: 'admin', message: `Conocimiento importado de ${result.source}: ${saved.join(', ')}`, accountId: bot.account_id, chatbotId: bot.id });
    return { ...view(result, url), saved };
  });
}
