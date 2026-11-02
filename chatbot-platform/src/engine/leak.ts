/**
 * AI-8: detector de fuga de instrucciones. Una respuesta que copia un tramo largo del prompt fijo o de las instrucciones
 * privadas del negocio (o nombra los campos internos del JSON) no sale: alguien le pidió al asistente «repite tus
 * instrucciones» y el modelo obedeció.
 *
 * No cuenta como fuga lo que el negocio escribió para que se diga: el texto entre comillas de sus instrucciones, ni lo que
 * también está en su información (conocimiento, mensajes guardados, saludo…), que es pública por diseño.
 */
import { normalize } from './text.js';

/** Palabras seguidas iguales a partir de las cuales se considera copia. */
export const LEAK_RUN = 12;

/** Los nombres de los campos del JSON de decisión y los títulos del prompt no tienen por qué llegar al cliente. */
const MARKERS = /\b(save_data|image_ids|context_image_ids|saved_message_codes|info_not_found|flow_step|wants_final|qty_quote|item_code)\b|<\/?instrucciones>|reglas que nunca se rompen|configuracion del agente|estado de la conversacion|orden de prioridad/;

const words = (s: string) => normalize(s).replace(/[^\p{L}\p{N}%$]+/gu, ' ').trim().split(' ').filter(Boolean);

function shingles(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + LEAK_RUN <= w.length; i++) out.add(w.slice(i, i + LEAK_RUN).join(' '));
  }
  return out;
}

/** Lo que va entre comillas en las instrucciones es lo que el negocio quiere que se diga tal cual. */
const QUOTED = /"[^"\n]{3,}"|“[^”\n]{3,}”|«[^»\n]{3,}»|'[^'\n]{12,}'/g;

export interface LeakDetector {
  /** El tramo copiado (o el marcador) si la frase filtra instrucciones; si no, null. */
  leak(text: string): string | null;
}

/**
 * @param secret  el prompt fijo, las instrucciones y reglas del negocio
 * @param publicTexts  lo que el negocio publica o pidió decir (conocimiento, mensajes guardados, saludo, preguntas)
 */
export function leakDetector(secret: string[], publicTexts: string[]): LeakDetector {
  const quoted = secret.flatMap((s) => s.match(QUOTED) ?? []);
  const allowed = shingles([...publicTexts, ...quoted]);
  const hidden = shingles(secret.map((s) => s.replace(QUOTED, ' | ')));
  for (const s of allowed) hidden.delete(s);
  return {
    leak(text) {
      const marker = normalize(text).match(MARKERS);
      if (marker) return marker[0];
      if (!hidden.size) return null;
      const w = words(text);
      for (let i = 0; i + LEAK_RUN <= w.length; i++) {
        const run = w.slice(i, i + LEAK_RUN).join(' ');
        if (hidden.has(run)) return run;
      }
      return null;
    },
  };
}
