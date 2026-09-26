# Plataforma de chatbots multicanal (WhatsApp, Telegram, Messenger, Instagram y chat web)

Plataforma propia para crear, configurar y operar chatbots para varios clientes. Cada **cuenta** (cliente) tiene sus propios usuarios, chatbots y **canales**: WhatsApp (vía Evolution API), Telegram, Facebook Messenger, Instagram y un chat para su sitio web. Un mismo chatbot puede atender varios canales a la vez. Todo lo que cambia de un negocio a otro (prompt, tono, información, imágenes, reglas, datos a recopilar, flujo) vive en **PostgreSQL** y se edita desde un **panel web**, sin tocar código. Para pasar de un hotel a una inmobiliaria se cambia la configuración, no el sistema.

```
WhatsApp (Evolution) ┐                                  ┌► misma plataforma
Telegram             │                                  │
Messenger/Instagram  ├─► Backend (este proyecto) ───────┤
Chat web (widget)    ┘    │                             │
                          ├─ Cuenta → canal → chatbot asignado
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
| **Memoria** | Datos del cliente (campos configurables, validados: correo, teléfono, opciones…), notas de intereses, nombre, y un **resumen acumulado** de lo antiguo que se genera automáticamente. La IA recibe el resumen + todos los mensajes aún no resumidos (sin huecos), y ve qué datos ya tiene y cuáles faltan, así no vuelve a preguntar. |
| **Transferencia a humano** | Por palabras clave (sin gastar IA), por decisión de la IA según reglas, o manualmente desde el panel. Aviso opcional por WhatsApp a un encargado. Si alguien responde desde el teléfono, el bot se pausa en esa conversación. Retoma automática opcional tras X minutos. |
| **Registros** | Cada error/evento de Evolution, IA, validador, webhook y panel queda en `event_logs` y se ve en el panel. Cada llamada a la IA queda en `ai_runs` con tokens (incluidos los cacheados), latencia, decisión y validación. |
| **Cuentas y usuarios** | Cada cliente es una cuenta con sus usuarios (administradores y agentes). Solo ven lo suyo: cualquier intento de acceder a otra cuenta responde 404. El superadministrador ve y administra todas. Desactivar una cuenta corta el acceso de sus usuarios y detiene sus canales (los mensajes se siguen guardando). |
| **Multicanal** | WhatsApp, Telegram, Messenger, Instagram y chat web. Cada canal pertenece a una cuenta y se asigna a un chatbot; un chatbot puede atender varios canales con la misma configuración. Webhooks verificados por plataforma (secreto de Telegram, firma `X-Hub-Signature-256` de Meta, URL secreta de Evolution). Se puede duplicar un chatbot como plantilla, incluso en otra cuenta. |
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
- **Con dominio y HTTPS** (necesario para Telegram, Messenger, Instagram y el chat web): apunta un dominio al VPS, define `DOMAIN` y `SECURE_COOKIES=true` en `.env` y ejecuta `docker compose --profile https up -d --build`. Caddy obtiene el certificado automáticamente. La URL pública (`PUBLIC_BASE_URL`, por defecto `https://$DOMAIN`) es la que usan esas plataformas para enviar mensajes y descargar imágenes.
- Al arrancar se crea el **superadministrador** con `ADMIN_USER` (tu correo) y `ADMIN_PASSWORD`. Si olvidas la contraseña, cámbiala en `.env` y reinicia.
- Evolution API solo escucha en `127.0.0.1:8080` (no queda expuesta a internet). El backend y Evolution se hablan por la red interna de Docker (`WEBHOOK_BASE_URL=http://backend:3000`).
- Se recomienda fijar la versión de Evolution con `EVOLUTION_IMAGE=evoapicloud/evolution-api:<versión>`.

## Cuentas, usuarios y roles

| Rol | Qué puede hacer |
|---|---|
| **Superadministrador** | Todo, en todas las cuentas. Crea cuentas (con su primer administrador), las activa/desactiva o elimina. Tiene un selector de cuenta en el menú para trabajar dentro de una o ver todas. |
| **Administrador** | Todo dentro de su cuenta: chatbots, canales, usuarios, conversaciones y registros. |
| **Agente** | Solo conversaciones de su cuenta: verlas, tomarlas, responder, devolverlas al bot y editar datos del cliente. No ve la configuración ni credenciales. |

Al cambiar una contraseña, las demás sesiones abiertas de ese usuario se cierran. Desactivar un usuario le quita el acceso al instante.

## Primeros pasos en el panel

1. **Cuentas** (superadministrador): crea la cuenta del cliente y, opcionalmente, su primer administrador.
2. **Chatbots → Nuevo chatbot** y configúralo:
   - **Personalidad**: prompt principal, tono, idioma, longitud, emojis, tú/usted, ejemplos de estilo.
   - **Conocimiento**: información por categoría (servicios, precios, horarios, ubicaciones, condiciones, FAQ…). Es lo único que el bot puede afirmar.
   - **Imágenes**: con un **ID** (`habitacion_doble`), qué muestran y **cuándo enviarlas**.
   - **Reglas**, **Datos a recopilar** y **Flujo**.
   - **Probar**: simulador con el mismo motor y validaciones, con panel de depuración. Funciona aunque el bot esté inactivo.
3. **Canales → Nuevo canal**: elige la plataforma, asígnale el chatbot y sigue las instrucciones de conexión (abajo).
4. **General → Activo** para que el chatbot empiece a responder en sus canales.

Para ver un ejemplo completo: `npm run seed:demo` (o `docker compose exec backend node dist/cli/seed-demo.js`) crea la cuenta "Demo" con un chatbot de hotel y un canal de chat web.

## Conectar cada plataforma

| Plataforma | Qué necesitas | Cómo se conecta |
|---|---|---|
| **WhatsApp** | Un teléfono con WhatsApp | Escribe un nombre de instancia, guarda y pulsa **Conectar / mostrar QR**: se crea la instancia en Evolution, se configura el webhook y escaneas el QR desde *Dispositivos vinculados*. |
| **Telegram** | Un bot creado con **@BotFather** | Pega el token, guarda y pulsa **Conectar con Telegram**: se valida el token y se registra el webhook con un secreto (los mensajes sin ese secreto se rechazan). Solo chats privados. |
| **Messenger** | Una app en Meta for Developers con el producto Messenger y una página de Facebook | Pega el token de la página y la clave secreta de la app. En la app de Meta configura el webhook con la **URL** y el **token de verificación** que muestra el panel, suscrito a `messages`, `messaging_postbacks` y `message_echoes`. Pulsa **Verificar y suscribir la página**. |
| **Instagram** | Cuenta profesional de Instagram vinculada a la página, en la misma app de Meta | Igual que Messenger, en la sección Instagram de la app. |
| **Chat web** | Nada | Personaliza título, color y bienvenida; copia el código `<script …>` en el sitio del cliente. Opcional: limita los dominios que pueden insertarlo. Hay una **vista previa** en el panel. |

Detalles por plataforma:

- Si alguien del equipo responde **directamente** desde WhatsApp o desde la bandeja de la página de Facebook/Instagram, el bot se pausa en esa conversación.
- El formato `*negritas*` se usa en WhatsApp; en las demás plataformas se envía como texto plano.
- Messenger e Instagram descargan las imágenes desde una URL pública firmada (`/media/…`), por eso necesitan HTTPS.
- Los avisos de transferencia al encargado salen siempre por un WhatsApp activo de la cuenta, aunque la conversación sea de otra plataforma.
- Un canal **sin chatbot** asignado guarda los mensajes pero no responde; al asignarle uno, empieza a atender.

## Conversaciones

- Lista filtrable por chatbot, plataforma, canal, estado (bot / humano / cerrada) y búsqueda.
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

Problemas corregibles → se reintenta **una vez** con la corrección. En el último intento:

- Problemas de **estilo** (frase prohibida, prometer una foto inexistente, mensaje largo) se corrigen solos: se quitan las oraciones problemáticas y se envía el resto.
- Datos **no verificables** → respuesta de respaldo o transferencia, según la regla configurada.
- Respuesta **inválida** (JSON roto o vacía) → no se envía nada; se registra el error y se reintenta en 1 minuto.

Las cotizaciones simples (precio del catálogo × cantidad que dijo el cliente, p. ej. 3 noches) se aceptan; cualquier otro monto se rechaza. Si la regla es "transferir cuando falta un dato" y la IA marca `info_not_found`, el backend transfiere aunque la IA haya propuesto solo responder. Además, si el cliente escribe mientras la IA piensa, la respuesta se descarta y se vuelve a generar con todos los mensajes; si una persona toma la conversación mientras tanto, no se envía nada.

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
    transport.ts   interfaz de salida común y simulador
    text.ts        normalización, extracción de hechos, formato WhatsApp / texto plano
  channels/        un adaptador por plataforma (whatsapp, telegram, meta, webchat): webhook, firma, envío, conexión
  evolution/       cliente de Evolution API v2 y parser del webhook
  ai/provider.ts   cliente de OpenAI (chat + transcripción de notas de voz)
  routes/          API del panel (cuentas, usuarios, chatbots, canales, conversaciones) y rutas públicas (webhooks, chat web, imágenes)
  access.ts        reglas de acceso por cuenta y rol
  auth.ts          usuarios, contraseñas (scrypt) y sesiones
  store/           acceso a PostgreSQL
migrations/        esquema SQL
public/            panel web (HTML/CSS/JS sin build) y widget del chat web (widget.js)
test/              pruebas
```

## API (resumen)

Panel (bajo `/api`, con sesión por cookie; todo se limita a la cuenta del usuario):

- Sesión: `POST /api/login`, `GET /api/me`, `PUT /api/me/password`
- Cuentas: `/api/accounts`
- Usuarios: `/api/users`
- Chatbots: `/api/chatbots`, `/:id/duplicate`, `/:id/knowledge`, `/:id/images`, `/:id/playground`
- Canales: `/api/channels`, `/:id/setup`, `/:id/status`, `/:id/rotate-token`, `/:id/whatsapp/{connect,logout,test}`
- Conversaciones: `/api/conversations`, `/:id/{takeover,release,close,send,reset-memory}`
- Contactos: `/api/contacts/:id`
- Registros, uso de IA y estadísticas: `/api/logs`, `/api/ai-runs`, `/api/stats`

Públicas:

- Webhooks: `GET|POST /webhook/:token`. El token es una URL secreta por canal; `GET` sirve para la verificación de Meta.
- Chat web: `/webchat/:token/{config,session,messages}`, con CORS y límite de 15 mensajes por minuto por sesión.
- Imágenes firmadas: `GET /media/:id?e=…&s=…`.

Actualización desde la versión anterior: la migración `002` pasa automáticamente todo a una "Cuenta principal" y convierte el WhatsApp de cada chatbot en un canal, **conservando la URL del webhook** para que Evolution siga funcionando sin reconfigurar.

## Notas y límites de esta versión

- La cola vive en memoria: pensada para un proceso en un VPS. Al reiniciar, retoma los mensajes sin responder de los últimos 15 minutos.
- La recuperación de conocimiento es por palabras clave (sin embeddings) y solo entra en juego si el conocimiento excede el presupuesto; para la mayoría de negocios se envía completo.
- Se ignoran grupos, estados y canales de WhatsApp.
- Los mensajes con más de 30 minutos de antigüedad (p. ej. al reconectar el teléfono) se guardan pero no se contestan automáticamente.
- Una conversación **cerrada** se reabre (con su memoria) cuando el cliente vuelve a escribir.
- La verificación de hechos cubre cifras, links, correos y teléfonos; afirmaciones sin números (p.ej. "sí tenemos alberca") dependen del prompt y la regla de cero invenciones.
