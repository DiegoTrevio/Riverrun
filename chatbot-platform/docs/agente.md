# El agente: cómo funciona y reglas generales

Este documento describe cómo decide el asistente qué responder, qué garantiza el sistema y qué depende del modelo de IA, y las reglas generales que aplican a **todos** los agentes, sin importar el negocio.

## Principio

El modelo **propone**; el backend **decide**. La IA devuelve una decisión en JSON (acción, mensajes, datos, etapa del recorrido). El backend la valida, la corrige o la rechaza antes de enviar nada. Por eso hay tres niveles de garantía:

- **Determinista (backend):** se cumple siempre, con o sin IA. Ejemplos: no enviar una foto que no existe, no guardar un dato que el cliente no dijo, pasar a una persona ante una emergencia.
- **Verificado (validador):** la IA puede proponer algo incorrecto; el validador lo detecta, pide otra propuesta y, si vuelve a fallar, aplica una respuesta segura.
- **Instrucción (prompt):** la IA lo sigue porque se le pide. Sin verificación, depende del modelo; por eso las reglas de este tipo se miden con las evaluaciones en vivo (ver «Límites»).

## Cómo funciona, de punta a punta

1. **Entrada** (`service.ts → handleIncoming`). El mensaje llega por el canal, se normaliza y se guarda con su contacto y conversación. Los duplicados se ignoran. Los mensajes viejos (reconexiones, reenvíos) se guardan pero no se contestan. Un cliente que vuelve a escribir reabre la conversación y el recorrido empieza de nuevo. Las automatizaciones (bajas, reglas por mensaje) corren antes que la IA. Después, las compuertas de activación (palabras que encienden o apagan al asistente, pausas).
2. **Cola** (`queue.ts`). Agrupa los mensajes seguidos del cliente (`debounce_seconds`), procesa una conversación a la vez y vuelve a empezar si llegan mensajes mientras la IA piensa. Si la IA falla, reintenta una vez; si vuelve a fallar, avisa al equipo.
3. **Compuertas previas a la IA** (`engine.ts → process`, pasos 0 a 2). Se revisan antes de gastar una llamada:
   - riesgo para la vida o emergencia → mensaje fijo, transferencia y aviso prioritario;
   - contestadores con marca de «respuesta automática» → no se contestan;
   - el mismo texto repetido varias veces → el asistente se pausa 4 horas y el equipo se entera;
   - palabra clave de transferencia (configurada por el negocio) → transferencia.
4. **Contexto** (`context.ts`). El prompt tiene, en orden: el papel y el estilo; las **reglas generales**; las reglas de oro (cero invenciones); la información del negocio (seleccionada por palabras o por significado, dentro de un presupuesto); el catálogo de fotos; las reglas del negocio; el recorrido; las instrucciones para guardar datos; el formato de respuesta; la memoria del cliente (datos conocidos, datos que faltan, resumen); el horario (abierto o cerrado y cuándo abre); la agenda; y el momento actual.
5. **IA** (`ai/`). Salida en JSON estricto. Si el validador rechaza la propuesta, se pide una segunda con la corrección.
6. **Validador** (`validator.ts`). Revisa formato, longitud, trato (tú/usted), frases prohibidas, temas prohibidos, fotos (solo del catálogo), datos verificables (precios, números, enlaces, correos y teléfonos deben existir en el contexto), afirmaciones sin respaldo, datos del cliente (solo los que él dijo), acción coherente, intenciones, agenda, recorrido, datos sensibles, respuestas repetidas y preguntas sin respuesta. Si en el último intento sigue habiendo un dato no verificable, responde con el mensaje de respaldo o transfiere, según la configuración. Si la propuesta no es válida, no se envía nada.
7. **Ejecución** (`engine.ts`). Guarda los datos y la memoria, valida y ejecuta la agenda, decide las fotos (las de reglas, las de la IA y las pendientes), envía (cada mensaje se guarda antes de enviarse y queda como fallido si la plataforma lo rechaza), transfiere si corresponde, avanza el recorrido, aplica los desactivadores, emite eventos para reglas y webhooks, y actualiza el resumen en segundo plano. Si el asistente prometió que el equipo dará seguimiento, el equipo recibe un aviso.

## Reglas generales

Todas aplican a cualquier agente. Dónde se cumplen y cómo se prueban:

| Regla | Cómo se cumple | Dónde | Prueba |
|---|---|---|---|
| **Emergencias y riesgo para la vida.** Una persona atiende de inmediato, con mensaje fijo (911 y Línea de la Vida en México; en inglés se responde en inglés). | Determinista, antes de la IA. Aviso prioritario aunque el asistente esté en pausa o una persona atienda. | `safety.ts` (`detectRisk`), `engine.ts` (paso 0 y `escalateRisk`), `service.ts` (aviso al entrar) | `agent-rules.test.ts` |
| **Contestadores no se contestan.** Solo con marca inequívoca («respuesta automática», «out of office»…); un aviso de ausencia de una persona sí recibe respuesta. | Determinista: solo si todo el lote pendiente es automático. Una pregunta siempre es de una persona. | `safety.ts` (`isAutomatedMessage`), `engine.ts` (0b) | `agent-rules.test.ts` |
| **Bucles.** El mismo texto repetido 3 veces en 30 minutos pausa al asistente 4 horas y avisa al equipo. | Determinista. Lo reactiva una persona o una palabra de activación. | `safety.ts` (`repeatedCustomerText`), `engine.ts` (0c) | `agent-rules.test.ts` |
| **Datos sensibles.** Tarjetas (15 o 16 dígitos con verificación de Luhn), CVV, contraseñas y NIP nunca se guardan como datos del cliente; en el chat solo quedan los últimos 4 dígitos. | Determinista al entrar, al guardar datos y en la respuesta. Además, la IA tiene la regla de no pedirlos. | `safety.ts` (`maskSensitive`), `service.ts`, `validator.ts` | `agent-rules.test.ts` |
| **Una pregunta nunca se queda sin respuesta.** | Verificado: si la IA elige `no_reply` ante una pregunta, reintenta; si sigue sin responder, pasa a una persona. Un «¿Sí?» no cuenta. | `validator.ts` | `agent-rules.test.ts` |
| **No repetir la misma respuesta a un mensaje distinto.** Si el cliente repite exactamente su pregunta, sí puede repetirse. | Verificado: reintenta una vez; en el último intento se acepta para no quedar callado. | `validator.ts` (`recentBotTexts`, `customerRepeats`) | `agent-rules.test.ts` |
| **Lo que el asistente promete, el equipo lo recibe.** «Lo reviso con el equipo», «te aviso en breve». | Determinista: al detectar la promesa se avisa al equipo. Aplica también a la respuesta de respaldo. | `safety.ts` (`promisesFollowUp`), `engine.ts` | `agent-rules.test.ts` |
| **Fuera de horario.** Dice que está cerrado, cuándo abre y que no promete respuesta inmediata. | Instrucción con la hora de apertura calculada por el sistema. | `context.ts`, `service.ts` (`business`) | `agent-rules.test.ts` |
| **Idioma del cliente.** Responde en el idioma en que escribe, salvo que el negocio diga otra cosa. | Instrucción. | `agent-rules.ts` | Presencia en el prompt (`agent-rules.test.ts`). Comportamiento del modelo: pendiente en las evaluaciones en vivo |
| **Transferir en casos universales:** pide una persona con cualquier palabra, reclama algo que no puede resolver, pide borrar o exportar sus datos, o quiere confirmar un pago o reembolso. | Instrucción, además de las reglas de transferencia del negocio. | `agent-rules.ts` | Presencia en el prompt. Comportamiento del modelo: pendiente en las evaluaciones en vivo |
| **No confirmar pagos, depósitos ni reembolsos.** | Instrucción. | `agent-rules.ts` | Presencia en el prompt. Comportamiento del modelo: pendiente en las evaluaciones en vivo |

El texto de las reglas de instrucción está en `src/engine/agent-rules.ts`: cambiarlo cambia a todos los agentes. Las pruebas automáticas comprueban que el texto llega al modelo, no que el modelo lo cumpla; eso se mide con evaluaciones en vivo.

## Hallazgos del análisis (antes de estos cambios)

1. **Sin protección ante emergencias.** Todo dependía de las palabras de transferencia que configuraba cada negocio. Una persona que escribía «ya no quiero vivir» en una clínica o un hotel podía recibir una respuesta comercial.
2. **Sin freno a contestadores ni a bots.** El correo ya tenía un freno (más de 12 correos por hora de la misma dirección), pero WhatsApp no. Dos bots o un contestador podían mantener una conversación sin fin, con costo de IA y de mensajes.
3. **Sin control de repeticiones.** El modelo podía copiar la misma respuesta a preguntas distintas. Nada lo detectaba.
4. **Datos sensibles sin regla.** Ninguna instrucción ni verificación trataba tarjetas o contraseñas: el número completo quedaba en la base de datos y en el contexto de la IA.
5. **Preguntas sin respuesta.** Una propuesta `no_reply` ante una pregunta se aceptaba sin verificar.
6. **Promesas sin respaldo operativo.** La respuesta de respaldo y la frase «revisarlo con el equipo» prometían un seguimiento que nadie recibía.
7. **Fuera de horario sin instrucciones.** El prompt sabía que el negocio estaba cerrado, pero no qué hacer ni cuándo abre.
8. **Emergencias con el asistente en pausa.** Si el asistente estaba en pausa o esperaba una palabra de activación, el motor no corría y nadie se enteraba.

## Decisiones y límites

- **Números de emergencia.** Los mensajes fijos citan el 911 y la Línea de la Vida (800 911 2000), que son de México. Un negocio en otro país necesita textos propios; hacerlos configurables por cuenta es el siguiente paso.
- **Idiomas de las listas de riesgo.** Las frases de riesgo están en español e inglés. En otros idiomas la red de seguridad es el equipo: el aviso prioritario solo llega si la frase se detecta.
- **Falsos positivos.** Las expresiones de broma o sentido figurado se excluyen («me quiero morir de la risa»). Una frase de riesgo que aparece en una pregunta informativa sí escala: se prefiere el falso positivo a una emergencia sin atender.
- **Bucles.** La ventana es de 30 minutos y la pausa de 4 horas. Un cliente real que vuelve a escribir después de la pausa sí recibe respuesta; si se repite antes, el equipo ya fue avisado.
- **Avisos de seguimiento.** Llegan a todo el equipo (panel y WhatsApp de quienes lo tengan activado). Si resulta ruidoso, el siguiente paso es filtrarlos por rol.
- **Costo.** Las reglas de repetición y de preguntas pueden pedir un reintento (como máximo uno por turno). Las compuertas previas no gastan IA.
- **Reglas que dependen del modelo.** Idioma, transferencias por reclamos, pagos y no prometer. El backend no puede verificar si un texto «confirma un pago»; por eso se miden con las evaluaciones en vivo antes de cambiar de modelo.
- **Fuera de alcance.** Si la IA no responde dos veces, el cliente espera hasta que el equipo conteste (el equipo ya fue avisado). Enviar un mensaje de espera automático se evaluó y no se añadió: al reintentar más tarde se enviaría una segunda respuesta.

## Cómo verificar

- Reglas generales: `node --import tsx --test test/agent-rules.test.ts`.
- Suite completa: `npm test`.
- Reglas que dependen del modelo: `npm run eval:engine:live` con una clave de OpenRouter, según [escalar y modelos](escalar-y-modelos.md). Conviene agregar casos para pagos, idioma y transferencias por reclamos antes de cambiar de modelo.
