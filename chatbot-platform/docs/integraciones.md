# Integraciones

Riverrun se conecta con otros sistemas de tres formas. Todo se administra en **Ajustes → Integraciones**.

1. **Google Calendar y Outlook**: las citas aparecen en tu calendario y tus horas ocupadas no se ofrecen a los clientes. Se pueden conectar los dos a la vez.
2. **Webhooks**: Riverrun avisa por `POST` firmado a la dirección que indiques cuando pasa algo (Zapier, Make, n8n, tu CRM).
3. **API v1**: tu sistema consulta y escribe contactos, conversaciones, mensajes y citas con una llave.

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
{ "id": "uuid-del-evento", "type": "contact.created", "created_at": "2026-10-07T15:04:05.000Z", "account_id": "uuid", "data": { "contact": { "id": "…", "name": "Ana", "phone": "5215512345678", "tags": [], "data": {} } } }
```

| Evento | Cuándo |
|---|---|
| `contact.created` | Primer mensaje de un cliente nuevo |
| `message.received` | Mensaje del cliente (**no** viene en "todos los eventos"; se elige a propósito) |
| `contact.data_captured` | El asistente capturó un dato (nombre, correo, fecha…) |
| `contact.tag_added` | Se agregó una etiqueta |
| `contact.opted_out` | El cliente se dio de baja de promociones |
| `conversation.handoff` | La conversación pasó a una persona (con el resumen y los datos capturados) |
| `goal.completed` | Se cumplió el objetivo de la conversación (con el resumen, el análisis y los datos capturados) |
| `appointment.booked` / `appointment.cancelled` | Cita agendada / cancelada (con conversación) |
| `conversation.sent` | Se envió una conversación a tu app: resumen, completa o ambos (ver abajo) |
| `ping` | Botón "Enviar prueba" |

En `conversation.handoff` y `goal.completed`, `data.conversation` incluye además `summary`, `analysis` (intención, ánimo, interés, acuerdos y pendientes), `data` (datos capturados), `flow_step` y `goal_completed_at`. Se generan antes de avisar, así que no hace falta pedirlos aparte; si la IA no pudo resumir, `summary` es `null` y `data` sigue completo.

Cabeceras: `x-riverrun-event`, `x-riverrun-delivery` (id de la entrega), `x-riverrun-timestamp` y `x-signature: sha256=<HMAC-SHA256 del cuerpo exacto>`, con el secreto de webhooks de tu cuenta (Ajustes → Horario y avisos).

**Verifica siempre la firma** (usa el cuerpo crudo, sin volver a serializar):

```js
// Node
import crypto from 'node:crypto';
const ok = (raw, header, secret) => {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
};
```

```python
# Python
import hmac, hashlib
def ok(raw: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header, expected)
```

Entrega: responde `2xx` en menos de 15 s. Si falla, se reintenta 3 veces con espera creciente; el mismo evento puede llegar más de una vez, usa `id` para no duplicar. Tras **20 fallos seguidos** el webhook se pausa y se avisa al equipo; al encenderlo de nuevo vuelve a funcionar. Las últimas entregas se ven en "Ver entregas" y se conservan 30 días.

**Zapier / Make / n8n**: crea un disparador "Webhook" (Catch Hook), pega su URL en Riverrun, pulsa **Enviar prueba** y mapea los campos de `data`. No necesitan verificar la firma si la URL es secreta, pero conviene.

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

Base: `https://TU-DOMINIO/api/v1`. Autenticación: `Authorization: Bearer rr_…` con una llave creada en Integraciones (se muestra una sola vez; en la base solo queda su hash; máximo 10 activas). Las de **lectura** solo hacen `GET`; las de **escritura** también `POST`/`PUT`. Límites: 300 lecturas/min y 60 escrituras/min por llave. Una cuenta pausada responde `402` en escrituras y una inactiva `403`.

| Método y ruta | Qué hace |
|---|---|
| `GET /me` | Cuenta, permiso de la llave y estado |
| `GET /contacts?limit&cursor&updated_since&tag&phone&channel_id` | Lista contactos (paginado por `cursor`) |
| `GET /contacts/:id` · `PUT /contacts/:id` | Ver o actualizar (`name`, `data`, `tags`, `add_tags`, `remove_tags`, `notes`, `consent`) |
| `POST /contacts` | Crea o actualiza por teléfono |
| `GET /conversations?status&contact_id&updated_since` | Lista conversaciones |
| `GET /conversations/:id/messages?after&limit` | Mensajes de una conversación |
| `GET /conversations/:id/export?content=summary\|full\|both&refresh` | La conversación para tu app: resumen, completa o ambos (lo mismo que el evento `conversation.sent`); `refresh=true` actualiza antes el resumen |
| `POST /messages` | Envía un texto (`conversation_id`, o `channel_id` + `phone`); respeta bajas y el límite del plan |
| `GET /appointments` | Citas |
| `GET /team` | Personas del equipo (id, nombre, rol, disponible) |
| `POST /notifications` | Aviso interno en el panel: `title`, `body`, `link` (ruta del panel), `user_ids`, `roles`, `round_robin` (solo a quien siga en el turno) |
| `PUT /conversations/:id/assign` | `user_id`: una persona, `"next"` (siguiente por turnos) o `null` (sin asignar) |

Ejemplo:

```bash
curl -H "Authorization: Bearer rr_xxx" "https://TU-DOMINIO/api/v1/contacts?updated_since=2026-10-01T00:00:00Z&limit=100"
```

La respuesta lleva `data` y, si hay más, `next_cursor` para la siguiente página.

Especificación **OpenAPI 3.1** (sin llave): `https://TU-DOMINIO/api/v1/openapi.json`. Impórtala en Postman, Insomnia o un generador de clientes.

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
