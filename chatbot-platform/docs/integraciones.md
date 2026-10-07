# Integraciones

Riverrun se conecta con otros sistemas de tres formas. Todo se administra en **Ajustes → Integraciones**.

1. **Google Calendar**: las citas aparecen en tu calendario y tus horas ocupadas no se ofrecen a los clientes.
2. **Webhooks**: Riverrun avisa por `POST` firmado a la dirección que indiques cuando pasa algo (Zapier, Make, n8n, tu CRM).
3. **API v1**: tu sistema consulta y escribe contactos, conversaciones, mensajes y citas con una llave.

## 1. Google Calendar

Sentido único: Riverrun → Google. Cada cita agendada (por el asistente o desde el panel) se crea como evento; si se reprograma se actualiza y si se cancela se borra. Si activas **bloquear horarios ocupados**, las horas "ocupado" de ese calendario se consultan (con una espera de 60 s) y no se ofrecen. Si Google no responde, la agenda sigue funcionando y el error se muestra en la pantalla de Integraciones; la copia de la cita se reintenta sola.

Configuración del servidor (una sola vez, la hace quien instala):

1. En <https://console.cloud.google.com> crea un proyecto, activa **Google Calendar API** y crea unas credenciales **OAuth (aplicación web)**.
2. En "URI de redireccionamiento autorizados" pon `https://TU-DOMINIO/oauth/google/callback` (es `PUBLIC_BASE_URL` + `/oauth/google/callback`).
3. Define en `.env`: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`, y reinicia.

Para usarlo con clientes que no son tú, Google pide verificar la aplicación (permisos `calendar.events` y `calendar.freebusy`). El permiso permanente se guarda cifrado (AES-256-GCM con `SESSION_SECRET`: si lo cambias hay que volver a conectar).

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
| `conversation.handoff` | La conversación pasó a una persona |
| `goal.completed` | Se cumplió el objetivo de la conversación |
| `appointment.booked` / `appointment.cancelled` | Cita agendada / cancelada (con conversación) |
| `ping` | Botón "Enviar prueba" |

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
| `POST /messages` | Envía un texto (`conversation_id`, o `channel_id` + `phone`); respeta bajas y el límite del plan |
| `GET /appointments` | Citas |

Ejemplo:

```bash
curl -H "Authorization: Bearer rr_xxx" "https://TU-DOMINIO/api/v1/contacts?updated_since=2026-10-01T00:00:00Z&limit=100"
```

La respuesta lleva `data` y, si hay más, `next_cursor` para la siguiente página.

## Exportar a CSV

En Conversaciones hay un menú **Exportar** (contactos, conversaciones y mensajes). Solo administradores; cada exportación queda en el registro.
