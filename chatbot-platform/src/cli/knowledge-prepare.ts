import { OpenAiProvider } from '../ai/provider.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { prepareKnowledge, type KnowledgeScope } from '../engine/knowledge-preparation.js';
import { knowledgeReadiness } from '../engine/knowledge-readiness.js';

try {
  const args = process.argv.slice(2);
  let scope: KnowledgeScope | undefined;
  let apply = false;
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (arg === '--apply') { apply = true; continue; }
    if (scope) throw new Error('scope');
    if (arg === '--all') scope = { all: true };
    else if (arg === '--account' || arg === '--chatbot') {
      const id = args[++i];
      if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('id');
      scope = arg === '--account' ? { accountId: id } : { chatbotId: id };
    } else throw new Error('argument');
  }
  if (!scope) throw new Error('scope');
  if (apply) {
    const readiness = await knowledgeReadiness();
    if (!readiness.database_ready || !config.knowledgeSearch.enabled || !config.openai.apiKey) {
      console.log(JSON.stringify({ type: 'not_ready', issues: readiness.issues }));
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) {
    const result = await prepareKnowledge(scope, { apply, ai: new OpenAiProvider(), onProgress: (progress) => console.log(JSON.stringify({ type: 'agent', ...progress })) });
    console.log(JSON.stringify({ type: 'summary', ...result, results: undefined }));
    if (apply && !result.complete) process.exitCode = 1;
  }
} catch {
  console.error('Preparación incompleta. Uso: knowledge:prepare -- (--all | --account UUID | --chatbot UUID) [--apply]. Revisa alcance, PostgreSQL y configuración del proveedor. Puedes repetir sin borrar datos.');
  process.exitCode = 1;
} finally { await pool.end(); }
