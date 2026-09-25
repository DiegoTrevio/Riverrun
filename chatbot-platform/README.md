# Plataforma de chatbots para WhatsApp (Evolution API + OpenAI)

Plataforma propia para crear, configurar y operar chatbots de WhatsApp. Todo lo que cambia de un negocio a otro (prompt, tono, información, imágenes, reglas, datos a recopilar, flujo) vive en **PostgreSQL** y se edita desde un **panel web**, sin tocar código. Para pasar de un hotel a una inmobiliaria se cambia la configuración, no el sistema.

```
WhatsApp ─► Evolution API ─► Backend (este proyecto) ─► WhatsApp
                              │
                              ├─ Cola por conversación (agrupa mensajes seguidos)
                              ├─ Contexto controlado: prompt + conocimiento relevante + memoria + mensajes recientes
                              ├─ OpenAI PROPONE una acción (JSON estricto)
                              ├─ El backend VALIDA: imágenes, datos, precios/links/teléfonos, frases, formato
                              ├─ Ejecuta: texto · texto+imagen · pregunta · guardar dato · no responder · transferir
                              └─ PostgreSQL: chatbots, conocimiento, imágenes, contactos, conversaciones, mensajes, uso de IA, registros
```

## Lo que resuelve

| Requisito | Cómo se cumple |
|---|---|
| **Conversación natural** | Guía de estilo de WhatsApp en el prompt (frases cortas, una pregunta por turno, no repetir saludo), tono/idioma/longitud/emojis/trato configurables, ejemplos de estilo, formato WhatsApp (`*negritas*`, sin Markdown), división en 1–N mensajes, "escribiendo…" proporcional, y agrupación de mensajes seguidos del cliente (debounce) para contestar una sola vez. |
| **Contexto correcto** | Se envía: prompt + conocimiento (si excede el presupuesto, solo lo relevante + lo marcado como "siempre incluir") + catálogo de imágenes + datos del cliente + notas + resumen + últimos N mensajes. Nunca el historial completo. La parte fija va primero para aprovechar el caché de prompts de OpenAI (más barato). |
| **Cero invenciones** | 1) Instrucción explícita de usar solo la información cargada. 2) El validador extrae **precios, números, URLs, correos y teléfonos** de la respuesta y verifica que existan en el conocimiento/configuración. Los **montos de dinero** solo se aceptan si vienen del negocio (el cliente no puede "dictar" un precio). 3) Si falla, se pide a la IA que corrija; si insiste, se envía un mensaje de respaldo o se transfiere, según la regla configurada. |
| **Imágenes correctas** | La IA solo ve un catálogo con ID, nombre, qué muestra y cuándo usarla. El backend descarta IDs inexistentes o inactivos, evita reenviar la misma imagen, limita cuántas se envían y rechaza respuestas del tipo "te mando la foto" sin imagen válida. Los archivos se validan por su firma real (JPG/PNG/WEBP, máx. 5 MB). |
| **Memoria** | Datos del cliente (campos configurables, validados: correo, teléfono, opciones…), notas de intereses, nombre, y un **resumen acumulado** de lo antiguo que se genera automáticamente. La IA ve qué datos ya tiene y cuáles faltan, así no vuelve a preguntar. |
| **Transferencia a humano** | Por palabras clave (sin gastar IA), por decisión de la IA según reglas, o manualmente desde el panel. Aviso opcional por WhatsApp a un encargado. Si alguien responde desde el teléfono, el bot se pausa en esa conversación. Retoma automática opcional tras X minutos. |
| **Registros** | Cada error/evento de Evolution, IA, validador, webhook y panel queda en `event_logs` y se ve en el panel. Cada llamada a la IA queda en `ai_runs` con tokens (incluidos los cacheados), latencia, decisión y validación. |
| **Multiempresa** | Cada chatbot tiene su instancia/número, prompt, conocimiento, imágenes, reglas y URL de webhook secreta. Se puede duplicar un chatbot como plantilla. |
| **Económico** | Todo corre en un VPS con Docker (Evolution, Postgres, Redis, backend). Solo se paga la API de OpenAI; el contexto acotado, el caché de prompts y el modelo configurable por chatbot mantienen bajo el costo. |

## Instalación en un VPS (Docker)

Requisitos: VPS con Docker y Docker Compose (2 GB de RAM es suficiente para empezar).

```bash
git clone <este repo> && cd Riverrun/chatbot-platform
cp .env.example .env
nano .env        # contraseñas, EVOLUTION_API_KEY, OPENAI_API_KEY, ADMIN_PASSWORD, SESSION_SECRET
docker compose up -d --build
```

- El panel queda en `http://127.0.0.1:3000` del VPS. Para abrirlo desde tu computadora: `ssh -L 3000:127.0.0.1:3000 usuario@tu-vps` y visita `http://localhost:3000`.
- **Con dominio y HTTPS** (recomendado): apunta un dominio al VPS, define `DOMAIN` y `SECURE_COOKIES=true` en `.env` y ejecuta `docker compose --profile https up -d --build`. Caddy obtiene el certificado automáticamente.
- Evolution API solo escucha en `127.0.0.1:8080` (no queda expuesta a internet). El backend y Evolution se hablan por la red interna de Docker (`WEBHOOK_BASE_URL=http://backend:3000`).
- Se recomienda fijar la versión de Evolution con `EVOLUTION_IMAGE=evoapicloud/evolution-api:<versión>`.

## Primeros pasos en el panel

1. **Crear chatbot** → pestaña **General**: nombre y nombre de la instancia de Evolution (p.ej. `hotel_palmas`).
2. **Personalidad**: prompt principal, tono, idioma, longitud, emojis, tú/usted, ejemplos de estilo.
3. **Conocimiento**: agrega la información por categoría (servicios, precios, horarios, ubicaciones, condiciones, FAQ…). Escribe datos concretos: es lo único que el bot puede afirmar.
4. **Imágenes**: sube las imágenes con un **ID** (`habitacion_doble`), qué muestran y **cuándo enviarlas**.
5. **Reglas**: qué hacer si falta un dato, temas prohibidos, reglas propias, cuándo transferir, palabras clave, número de aviso.
6. **Datos a recopilar**: nombre, correo, fechas, presupuesto… con tipo y cuándo pedirlos.
7. **Flujo**: objetivo y etapas sugeridas (guía flexible, no guion).
8. **Probar**: simulador con el mismo motor y validaciones que WhatsApp, con panel de depuración (acción elegida, razonamiento, intentos rechazados, correcciones, datos guardados). Funciona aunque el bot esté inactivo.
9. **WhatsApp**: "Conectar / mostrar QR" crea la instancia en Evolution, configura el webhook y muestra el QR para vincular el teléfono.
10. **General → Activo** para que empiece a responder.

Para ver un ejemplo completo: `npm run seed:demo` (o `docker compose exec backend node dist/cli/seed-demo.js`) crea un chatbot de hotel de demostración.

## Conversaciones

- Lista filtrable por chatbot, estado (bot / humano / cerrada) y búsqueda.
- Detalle con el historial (imágenes incluidas), datos del cliente editables, notas y resumen de memoria.
- **Tomar conversación** (el bot deja de responder), **responder manualmente** desde el panel, **devolver al bot** (los mensajes que llegaron mientras atendía una persona no se contestan en automático) y **borrar memoria**.

## Cómo decide y valida (el núcleo)

La IA responde siempre con este JSON (structured outputs estricto de OpenAI):

```json
{
  "thinking": "análisis interno breve",
  "action": "reply | reply_with_image | ask | no_reply | handoff",
  "messages": ["mensaje 1", "mensaje 2"],
  "image_ids": ["habitacion_doble"],
  "save_data": [{ "field": "correo", "value": "ana@mail.com" }],
  "remember": ["Viaja con dos niños"],
  "handoff_reason": "",
  "info_not_found": false
}
```

El backend (`src/engine/validator.ts`) nunca confía en la propuesta:

- JSON válido y acción conocida.
- Imágenes: solo IDs del catálogo del chatbot, activas, sin repetir, con límite por turno.
- Datos: solo campos configurados; se validan y normalizan (correo, teléfono, nombre, número, opción de lista).
- Hechos: precios/números/links/correos/teléfonos deben existir en las fuentes (dinero: solo fuentes del negocio).
- Estilo: frases prohibidas, temas prohibidos, emojis según configuración, Markdown → formato WhatsApp, longitud y número de mensajes.
- Coherencia: `no_reply` sin mensajes, respuestas vacías, promesas de foto sin imagen.

Problemas corregibles → se reintenta **una vez** con la corrección. Si persiste → respuesta de respaldo o transferencia. Además, si el cliente escribe mientras la IA piensa, la respuesta se descarta y se vuelve a generar con todos los mensajes; si una persona toma la conversación mientras tanto, no se envía nada.

## Desarrollo local

```bash
npm install
cp .env.example .env   # usa las variables de "desarrollo local"
npm run migrate
npm run dev            # http://localhost:3000
```

Pruebas (unitarias + integración de extremo a extremo con PostgreSQL real, IA y WhatsApp simulados):

```bash
TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test npm test
```

> La base de pruebas se borra por completo en cada ejecución. Si no está disponible, las pruebas de integración se omiten.

## Estructura

```
src/
  engine/
    context.ts     construcción del contexto (prompt, conocimiento relevante, memoria, historial)
    decision.ts    esquema de la decisión de la IA
    validator.ts   validación y saneamiento de la propuesta
    engine.ts      pipeline: IA → validar → reintentar → ejecutar → memoria
    memory.ts      resumen acumulado de la conversación
    queue.ts       cola por conversación (agrupar mensajes, sin respuestas cruzadas)
    transport.ts   salida por Evolution o por el simulador
    text.ts        normalización, extracción de hechos, formato WhatsApp
  evolution/       cliente de Evolution API v2 y parser del webhook
  ai/provider.ts   cliente de OpenAI (chat + transcripción de notas de voz)
  routes/          webhook y API del panel
  store/           acceso a PostgreSQL
migrations/        esquema SQL
public/            panel web (HTML/CSS/JS sin build)
test/              pruebas
```

## API del panel (resumen)

Todas bajo `/api`, con sesión (cookie). `POST /api/login`, `GET/POST /api/chatbots`, `GET/PUT/DELETE /api/chatbots/:id`, `POST /api/chatbots/:id/duplicate`, conocimiento (`/api/chatbots/:id/knowledge`, `/api/knowledge/:id`), imágenes (`/api/chatbots/:id/images`, `/api/images/:id`), WhatsApp (`/api/chatbots/:id/whatsapp/{status,connect,webhook,logout,test}`), simulador (`/api/chatbots/:id/playground`), conversaciones (`/api/conversations`, `/:id/{takeover,release,close,send,reset-memory}`), contactos, registros (`/api/logs`), uso de IA (`/api/ai-runs`), estadísticas (`/api/stats`).

Webhook de Evolution: `POST /webhook/:token` (URL secreta por chatbot, visible en la pestaña General).

## Notas y límites de esta versión

- Un solo usuario administrador (definido en `.env`). Pensado para crecer a usuarios por empresa.
- La cola vive en memoria: pensada para un proceso en un VPS. Al reiniciar, retoma los mensajes sin responder de los últimos 15 minutos.
- La recuperación de conocimiento es por palabras clave (sin embeddings) y solo entra en juego si el conocimiento excede el presupuesto; para la mayoría de negocios se envía completo.
- Se ignoran grupos, estados y canales de WhatsApp.
- La verificación de hechos cubre cifras, links, correos y teléfonos; afirmaciones sin números (p.ej. "sí tenemos alberca") dependen del prompt y la regla de cero invenciones.
