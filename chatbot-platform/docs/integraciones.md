# Integraciones

Riverrun se conecta con otros sistemas de tres formas. Todo se administra en **Ajustes → Integraciones**.

1. **Google Calendar y Outlook**: las citas aparecen en tu calendario y tus horas ocupadas no se ofrecen a los clientes. Se pueden conectar los dos a la vez.
2. **Webhooks**: Riverrun avisa por `POST` firmado a la dirección que indiques cuando pasa algo (Zapier, Make, n8n, tu CRM).
3. **API v1**: tu sistema consulta y escribe contactos, conversaciones, mensajes, cobros y citas con una llave. La pantalla de Integraciones tiene los pasos, la dirección y ejemplos listos para copiar; la referencia completa está en `https://TU-DOMINIO/api/v1/docs`.

## 1. Google Calendar

Sentido único: Riverrun → Google. Cada cita agendada (por el asistente o desde el panel) se crea como evento; si se reprograma se actualiza y si se cancela se borra. Si activas **bloquear horarios ocupados**, las horas "ocupado" de ese calendario se consultan (con una espera de 60 s) y no se ofrecen. Si Google no responde, la agenda sigue funcionando y el error se muestra en la pantalla de Integraciones; la copia de la cita se reintenta sola.

Configuración del servidor (una sola vez, la hace quien instala):

1. En <https://console.cloud.google.com> crea un proyecto, activa **Google Calendar API** y crea unas credenciales **OAuth (aplicación web)**.
2. En "URI de redireccionamiento autorizados" pon `https://TU-DOMINIO/oauth/google/callback` (es `PUBLIC_BASE_URL` + `/oauth/google/callback`).
3. Define en `.env`: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`, y reinicia.

Para usarlo con clientes que no son tú, Google pide verificar la aplicación (permisos `calendar.events` y `calendar.freebusy`). El permiso permanente se guarda cifrado (AES-256-GCM con `SESSION_SECRET`: si lo cambias hay que volver a conectar).

### Outlook (Microsoft 365 y Outlook.com)

Funciona igual que Google Calendar: sentido único Riverrun → Outlook (alta, cambio y cancelación de cada cita), bloqueo opcional de horarios ocupados (cuentan «ocupado», «tentativo» y «fuera de la oficina»; no cuentan «libre» ni «trabajando en otro lugar») y, si Microsoft no responde, la agenda sigue y la copia se reintenta. Sirve para cuentas de trabajo (Microsoft 365) y personales (Outlook.com, Hotmail). Si Google y Outlook están conectados, la cita se copia a los dos y se respetan los ocupados de ambos.

Configuración del servidor (una sola vez):

1. En <https://portal.azure.com> → **Microsoft Entra ID → Registros de aplicaciones → Nuevo registro**. En «Tipos de cuenta compatibles» elige *Cuentas de cualquier directorio organizativo y cuentas personales de Microsoft*.
2. En «URI de redirección» elige **Web** y pon `https://TU-DOMINIO/oauth/outlook/callback` (es `PUBLIC_BASE_URL` + `/oauth/outlook/callback`).
3. En **Permisos de API → Microsoft Graph → Permisos delegados** agrega `Calendars.ReadWrite`, `User.Read` y `offline_access`.
4. En **Certificados y secretos** crea un secreto de cliente y copia su **valor** (no el id; caduca, anota la fecha).
5. Define en `.env`: `MICROSOFT_CLIENT_ID` (el «Id. de aplicación (cliente)») y `MICROSOFT_CLIENT_SECRET`, y reinicia. Opcional: `MICROSOFT_TENANT` con el id de tu organización para aceptar solo sus cuentas (por omisión `common`).

El permiso permanente se guarda cifrado igual que el de Google; Microsoft lo renueva y Riverrun guarda el nuevo cada vez. Al desconectar, el permiso se borra de Riverrun; para retirarlo también de Microsoft, hazlo en la cuenta (Aplicaciones y servicios con acceso).

## 2. Webhooks

Cada entrega es un `POST` con JSON:

```json
{ "id": "uuid-del-evento", "type": "contact.created", "api_version": 1, "created_at": "2026-10-07T15:04:05.000Z", "account_id": "uuid", "origin": "riverrun",
  "data": { "contact": { "id": "…", "name": "Ana", "profile_name": "Ana", "phone": "5215512345678", "channel": { "id": "…", "type": "whatsapp", "name": "WhatsApp" }, "tags": [], "data": {}, "consent": true, "opted_out": false, "created_at": "…" }, "conversation": { "id": "…", "status": "bot", "url": "https://TU-DOMINIO/#/conversation/…" } } }
```

- `origin` es `"api"` cuando lo provocó tu propio sistema por la API (por ejemplo, tu CRM agregó la etiqueta): así puedes ignorar tu propio cambio y evitar ciclos. Si no, es `"riverrun"`.
- El contacto, la cita y el cobro llegan con la misma forma que en la API (`GET /contacts`, `GET /appointments`, `GET /receivables`). En el contacto, `consent` es sí/no; el detalle está en `GET /contacts/:id`.
- `test: true` solo aparece en las pruebas que mandas desde el panel.

| Evento | Cuándo |
|---|---|
| `contact.created` | Primer mensaje de un cliente nuevo |
| `message.received` | Mensaje del cliente (**no** viene en "todos los eventos"; se elige a propósito) |
| `contact.data_captured` | El asistente capturó un dato (nombre, correo, fecha…) |
| `contact.tag_added` | Se agregó una etiqueta |
| `contact.opted_out` | El cliente se dio de baja de promociones |
| `conversation.handoff` | La conversación pasó a una persona (con el resumen y los datos capturados) |
| `goal.completed` | Se cumplió el objetivo de la conversación (con el resumen, el análisis y los datos capturados) |
| `appointment.booked` / `appointment.rescheduled` / `appointment.cancelled` | Cita agendada, cambiada de fecha u hora, o cancelada. También las que no tienen chat (página de reservas, panel): ahí `conversation` es `null` |
| `payment.due` / `payment.overdue` / `payment.paid` | Hoy vence un cobro (al salir su recordatorio), venció sin pagarse, o se marcó pagado. Trae `receivable` |
| `quote.sent` / `quote.accepted` / `quote.rejected` | Cotización enviada, aceptada por el cliente o rechazada por el equipo. Trae `quote` (folio, tipo, total, vigencia) |
| `pipeline.stage_changed` | Una solicitud cambió de columna en un pipeline |
| `conversation.sent` | Se envió una conversación a tu app: resumen, completa o ambos (ver abajo) |
| `ping` | «Enviar prueba» de conexión |

«Todos los eventos» (`"*"`, al crear un webhook por la API) son los de siempre: los de cobros, cotizaciones y `appointment.rescheduled` se eligen uno por uno, para que un Zap que ya funciona no empiece a recibir avisos de otro tipo. Desde el panel se eligen con casillas.

En `conversation.handoff` y `goal.completed`, `data.conversation` incluye además `summary`, `analysis` (intención, ánimo, interés, acuerdos y pendientes), `data` (datos capturados), `flow_step` y `goal_completed_at`. Se generan antes de avisar, así que no hace falta pedirlos aparte; si la IA no pudo resumir, `summary` es `null` y `data` sigue completo.

**Cabeceras:** `x-riverrun-event` (el tipo), `x-riverrun-delivery` (el id del evento), `x-riverrun-timestamp`, `x-riverrun-signature: t=<segundos>,v1=<HMAC-SHA256 de "t.cuerpo">` y `x-signature: sha256=<HMAC-SHA256 del cuerpo>` (la de antes, se conserva). El secreto está en **Integraciones → Secreto para verificar los webhooks**, donde también se cambia (el enlace del calendario no cambia).

**Verifica siempre la firma** con el cuerpo crudo (sin volver a serializar) y rechaza las de hace más de 5 minutos:

```js
// Node
import crypto from 'node:crypto';
export function verify(raw, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

```python
# Python
import hmac, hashlib, time
def verify(raw: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > tolerance:
        return False
    expected = hmac.new(secret.encode(), parts["t"].encode() + b"." + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(parts["v1"], expected)
```

**Entrega:** responde `2xx` en menos de 10 s. Si falla, se reintenta 6 veces en unas 8 horas (a 1, 5, 30, 120 y 360 minutos) con el **mismo** `id`: úsalo para no duplicar. Tras **20 eventos fallidos seguidos** el webhook se pausa y se avisa al equipo; al encenderlo de nuevo vuelve a funcionar. En **Ver entregas** están las últimas 50 con lo que se envió y un botón **Reenviar** (el cuerpo de cada evento se guarda 30 días; al borrar los datos de un cliente se borran también sus eventos). Cada webhook se puede **Editar** (dirección, descripción y eventos).

**Zapier / Make / n8n**: crea un disparador "Webhook" (Catch Hook), pega su URL en Riverrun, pulsa **Enviar prueba** y elige el evento: llega un ejemplo con la forma real y los datos más recientes de tu cuenta, para mapear los campos. No necesitan verificar la firma si la URL es secreta, pero conviene.

### Enviar conversaciones a tu app (resumen o completa)

Tu app recibe las conversaciones que tú decidas, con el resumen, todos los mensajes o ambos, en el evento `conversation.sent`.

1. **Conecta tu app una vez**: en Integraciones crea un webhook con su dirección y el evento «Conversación enviada a tu app» (o «todos los eventos»).
2. **Decide cuándo y qué se envía**, de tres formas:
   - **Reglas automáticas** (Automatización → Reglas, acción **«Enviar la conversación a tu app»**). El disparador y las condiciones de la regla deciden *cuándo* y la acción decide *qué* (resumen, completa o ambos) y a qué app. Por contexto: una intención del cliente («quiere comprar», «queja»), el objetivo cumplido, el paso a una persona, un dato capturado o una etapa del recorrido. Por marcas: una **etiqueta** que pone tu equipo desde el panel (o tu sistema por la API) dispara la regla, por ejemplo la etiqueta `enviar-a-mi-app` → conversación completa. Hay dos plantillas listas.
   - **A mano**: en la conversación, botón **«↗ Enviar a mi app»** (cualquier persona que vea la conversación).
   - **Tu app lo pide** cuando quiera: `GET /api/v1/conversations/:id/export?content=summary|full|both` devuelve lo mismo que `data` del evento.

Ejemplo de `data` en `conversation.sent` (con `content: "both"`):

```json
{
  "content": "both",
  "reason": "regla \"Objetivo cumplido → resumen a mi app\"",
  "trigger": { "rule": "Objetivo cumplido → resumen a mi app", "event": "goal_completed" },
  "contact": { "id": "…", "name": "Ana", "phone": "5215512345678", "tags": ["vip"], "data": { "correo": "ana@correo.com" }, "consent": true, "opted_out": false },
  "conversation": { "id": "…", "status": "bot", "channel": { "id": "…", "type": "whatsapp", "name": "WhatsApp" }, "data": {}, "url": "https://TU-DOMINIO/#/conversation/…" },
  "summary": { "text": "Ana quiere una limpieza dental el lunes…", "analysis": { "intent": "…", "sentiment": "positivo", "interest": "alto", "agreements": [], "next_steps": [] }, "generated_at": "…", "stale": false, "warning": null },
  "transcript": {
    "messages": [{ "id": 101, "at": "…", "direction": "inbound", "sender": "customer", "type": "text", "text": "Hola, quiero una cita" }],
    "total": 1, "included": 1, "truncated": false, "more": null
  }
}
```

- `summary` solo viene con `summary` o `both`. Se actualiza antes de enviar; si la IA no responde se envía el último con `warning`, y si no hay ninguno, `text` es `null`.
- `transcript` solo viene con `full` o `both`. Trae los mensajes entregados del cliente (`customer`), el asistente (`bot`) y el equipo (`human`), en orden y en el mismo formato que `GET /conversations/:id/messages`. Si la conversación tiene más de 1000 mensajes van los más recientes, con `truncated: true`; el resto se pide en `more`.
- `trigger` dice qué lo disparó (regla y evento, con la etiqueta, el dato o la intención), o `{ "event": "manual" }` si lo envió una persona: así tu app puede tratar distinto cada caso.
- La entrega es igual que la de los demás eventos: firmada, con reintentos y en "Ver entregas". En la regla puedes elegir una app concreta; si no, llega a todas las que reciben conversaciones.

## 3. API v1

**Empieza en 3 pasos** (los mismos que muestra la pantalla de Integraciones, con tu dirección ya puesta):

1. Crea una llave en **Integraciones → Llaves de la API**. «Lectura y escritura» si tu sistema va a dar de alta clientes, cobros o mensajes. Se muestra una sola vez; en la base solo queda su hash; máximo 10 activas.
2. En tu sistema pon la dirección `https://TU-DOMINIO/api/v1` y la cabecera `Authorization: Bearer rr_…`.
3. Prueba: `curl https://TU-DOMINIO/api/v1/me -H "Authorization: Bearer rr_…"` responde con tu cuenta, la zona horaria y el canal por omisión.

Referencia completa con ejemplos: `https://TU-DOMINIO/api/v1/docs` (sin llave). Especificación **OpenAPI 3.1** para Postman, Insomnia o un generador de clientes: `https://TU-DOMINIO/api/v1/openapi.json` (incluye los webhooks).

**Para no adivinar nada:**

- `GET /channels` da los ids de tus canales. Si tienes **un solo WhatsApp**, no hace falta mandar `channel_id`: se usa ese. Con varios, la respuesta de error `channel_required` trae la lista.
- `GET /contact-fields` da las claves de los datos de tus clientes (`data`), su tipo y sus opciones.
- **Teléfono en cualquier formato**: `+52 1 (55) 1234-5678`, `0052…`, `521…`. Con la zona horaria de México, a un número de 10 dígitos se le pone la lada 52. Las dos formas de un celular de México (`52…` y `521…`) son el mismo contacto, y también lo encuentra si el cliente escribió con un identificador `@lid`. Cuando el cliente contesta a un contacto que diste de alta, sigue siendo ese contacto.
- **`data`** acepta texto, números y sí/no; `null` o `""` borran el dato. Los datos definidos en «Datos de clientes» se validan (número, fecha `AAAA-MM-DD` o `DD/MM/AAAA`, opción de la lista, correo, teléfono) y se guardan normalizados.

**Errores**: siempre `{ "error", "code", "fields": [{ "field", "message" }], "issues" }`. `code` es estable para tu programa (`invalid_request`, `invalid_phone`, `channel_required`, `not_found`, `read_only_key`, `rate_limited`, `idempotency_conflict`…; la lista completa está en la documentación); `error` es el mensaje en español. Un id con mal formato da 404 y una ruta que no existe, `route_not_found`.

**Reintentos seguros**: manda `Idempotency-Key: <un id único de la operación>` en `POST`/`PUT`. Si tu sistema repite la petición (se cortó la red), recibe la misma respuesta con `idempotent-replayed: true` sin crear el contacto ni enviar el mensaje otra vez. Vale 24 h por llave; la misma llave con otro cuerpo da `409 idempotency_conflict`.

**Límites**: 300 lecturas/min y 60 escrituras/min por llave. Una cuenta pausada responde `402` en escrituras y una inactiva `403`.

| Método y ruta | Qué hace |
|---|---|
| `GET /me` | Cuenta, permiso de la llave, zona horaria y canal por omisión |
| `GET /channels` · `GET /contact-fields` | Tus canales y los datos de tus clientes |
| `GET /contacts?limit&cursor&updated_since&tag&phone&channel_id` | Lista contactos (paginado por `cursor`) |
| `GET /contacts/:id` · `PUT /contacts/:id` | Ver o actualizar (`name`, `data`, `tags`, `add_tags`, `remove_tags`, `notes`, `consent`, `opted_out`) |
| `POST /contacts` | Crea o actualiza por teléfono (201 nuevo, 200 ya existía) |
| `GET /conversations?status&contact_id&updated_since` | Lista conversaciones |
| `GET /conversations/:id/messages?after&limit` | Mensajes de una conversación |
| `GET /conversations/:id/export?content=summary\|full\|both&refresh` | La conversación para tu app (lo mismo que el evento `conversation.sent`); `refresh=true` actualiza antes el resumen |
| `POST /messages` | Envía un texto a `conversation_id`, `contact_id` o `phone`; respeta bajas y el límite del plan (422 con el motivo si no sale) |
| `GET /receivables` · `POST /receivables` · `POST /receivables/:id/paid` · `/cancel` | Cobros con recordatorios por WhatsApp (`contact_id` o `phone`; `source_id` evita duplicados) |
| `GET /receivable-plans` · `POST /receivable-plans` · `POST /receivable-plans/:id/deactivate` | Pagos recurrentes |
| `GET /appointments` | Citas (la misma forma que en los webhooks) |
| `GET /team` | Personas del equipo (id, nombre, rol, disponible) |
| `POST /notifications` | Aviso interno en el panel: `title`, `body`, `link`, `user_ids`, `roles`, `round_robin` |
| `PUT /conversations/:id/assign` | `user_id`: una persona, `"next"` (siguiente por turnos) o `null` (sin asignar) |

Ejemplo:

```bash
curl -X POST https://TU-DOMINIO/api/v1/contacts \
  -H "Authorization: Bearer rr_xxx" -H "Content-Type: application/json" -H "Idempotency-Key: cliente-1024" \
  -d '{ "phone": "+52 55 1234 5678", "name": "Ana López", "data": { "correo": "ana@ejemplo.com", "edad": 30 }, "tags": ["crm"] }'
```

Las listas traen `data` y, si hay más, `next_cursor` para la siguiente página.

## 4. Canal de correo electrónico (IMAP/SMTP)

En **Canales → Nuevo canal → Correo electrónico**. Funciona con Gmail, Google Workspace, Outlook/Microsoft 365 o cualquier proveedor con IMAP y SMTP.

1. En Gmail o Microsoft activa la verificación en dos pasos y crea una **contraseña de aplicación** (no uses tu contraseña normal).
2. Elige el proveedor (rellena los servidores), escribe el correo y la contraseña de aplicación y pulsa **Probar y conectar el correo**.
3. El buzón se revisa cada minuto (`EMAIL_POLL_SECONDS`, mínimo 15). Solo se contestan los correos **posteriores a la conexión**. Las respuestas salen por SMTP en el mismo hilo (`Re: asunto`, `In-Reply-To`) y varias burbujas de la IA se mandan como un solo correo.
4. Se ignoran avisos automáticos, listas de correo, rebotes y los mensajes de la propia dirección; el texto citado de la respuesta no se envía a la IA.

Los servidores en redes internas se rechazan. Si el acceso falla (contraseña revocada, etc.) el canal muestra el error y se reintenta solo.

## 5. Iniciar sesión con Google

Con `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` definidos aparece **Continuar con Google** en el inicio de sesión (solo en el dominio principal). Agrega `https://TU-DOMINIO/oauth/google/login/callback` a las URI de redireccionamiento autorizadas de las credenciales OAuth (además de la de Calendar, `/oauth/google/callback`). Quien ya tiene usuario entra con el mismo correo (Google debe haberlo verificado); un correo nuevo crea una cuenta de prueba si el registro está abierto. El superadministrador solo entra con su contraseña.

## Exportar a CSV

En Conversaciones hay un menú **Exportar** (contactos, conversaciones y mensajes). Solo administradores; cada exportación queda en el registro.
