# API y webhooks fáciles de conectar (diseño)

Objetivo: que alguien que conecta su CRM, Zapier o Make lo haga en minutos y sin datos perdidos o duplicados. Todo
es compatible con lo que ya funciona: no se quita ni se renombra ningún campo, cabecera ni ruta.

## Qué falla hoy

- **Conectar**: no hay de dónde sacar los `channel_id` ni las claves de los datos del cliente. La dirección base, la
  llave y el secreto de webhooks están en pantallas distintas. La documentación es un archivo del repositorio.
- **Datos**:
  - `phone` se toma tal cual. `+52 55…` y `521 55…` crean dos contactos distintos.
  - Un cliente que escribió con identificador `@lid` se duplica al darlo de alta por teléfono.
  - Cuando el cliente contesta a un contacto creado por la API, nace un tercer contacto si WhatsApp usa la otra forma
    del número.
  - `data` solo acepta texto: `{"edad": 30}` da 400. Una fecha o un correo mal escritos se guardan sin validar.
  - Los errores solo traen `error` y `issues` en texto, sin un código que un programa pueda leer.
  - Un id mal formado en la ruta da 500.
  - Un reintento de red repite el alta o el envío.
- **Webhooks**:
  - Hay eventos que no llegan nunca: citas reprogramadas, citas de la página de reservas sin chat, cobros y
    cotizaciones.
  - La prueba manda un `ping` sin datos reales, así que en Zapier no se pueden mapear los campos.
  - Una entrega fallida no se puede reenviar, y un webhook no se puede editar desde el panel.
  - La firma no incluye la hora, así que una entrega capturada se puede repetir.

## Fase A: conectar y pasar datos sin errores

- `GET /api/v1/channels`: canales de la cuenta (id, tipo, nombre, si sirve para dar de alta por teléfono y cuál es el
  de omisión).
- `GET /api/v1/contact-fields`: clave, etiqueta, tipo y opciones de cada dato del cliente.
- `GET /api/v1/me`: agrega `timezone` y `default_channel_id`.
- **Canal por omisión**: en `POST /contacts`, `/receivables` y `/messages`, `channel_id` es opcional.
  - Con un solo canal de WhatsApp, se usa ese.
  - Con varios, se responde 400 `channel_required` con la lista de canales.
  - Sin ninguno, se responde 400 `no_whatsapp_channel`.
- **Teléfono en cualquier formato**: se quitan espacios, guiones, paréntesis, `+` y el `00` inicial. A un número de 10
  dígitos se le agrega `52` si la zona horaria de la cuenta es de México; si no, se responde 400 `invalid_phone`.
  - La búsqueda prueba las dos formas de México (`52…` y `521…`) contra el teléfono y el identificador del contacto.
    Así encuentra también a los clientes que escribieron con `@lid`.
  - `GET /contacts?phone=` busca igual.
- **Cuando el cliente contesta**: la primera vez que un número escribe, si existe un contacto del mismo canal con ese
  número que nunca había escrito (creado por la API o importado), se le asigna el identificador real. Así no se
  duplica.
- **`data`**:
  - Acepta texto, números y sí/no. `null` o `""` borran el dato.
  - Si la clave es un dato definido de la cuenta, se valida y se normaliza igual que al importar (número, fecha,
    opción, correo, teléfono). Si no es válido, se responde 400 con el campo.
- **Errores**: además de `error` e `issues`, se agregan:
  - `code`, estable, por ejemplo `invalid_request`, `invalid_phone`, `channel_required`, `not_found`,
    `read_only_key` o `rate_limited`;
  - `fields: [{ field, message }]`.
- **Id mal formado** en la ruta: 404 `not_found`.
- **`Idempotency-Key`** en `POST` y `PUT`:
  - La misma llave y el mismo cuerpo dentro de 24 h devuelven la respuesta guardada, con `idempotent-replayed: true`.
  - Con otro cuerpo, se responde 409 `idempotency_conflict`.
  - Si la primera petición sigue en curso, se responde 409 `idempotency_in_progress`.
  - Un error 5xx no se guarda, para que se pueda reintentar.
  - Tabla nueva `api_idempotency`; se purga con la limpieza diaria.

## Fase B: webhooks coherentes con la API

- **Contacto**: el contacto de los eventos conserva sus campos y agrega `profile_name`, `channel` y `created_at`.
- **Campos nuevos del cuerpo**:
  - `api_version`;
  - `origin`: `api` si lo provocó una llamada de la API (evita ciclos con tu CRM) o `riverrun`;
  - `test: true` en las pruebas.
- **Firma con hora**: cabecera nueva `x-riverrun-signature: t=<segundos>,v1=<HMAC-SHA256 de "t.cuerpo">`.
  `x-signature` se queda igual.
- **Ejemplos reales**: «Enviar prueba» deja elegir el evento y manda un cuerpo con la forma real. Toma la conversación
  más reciente de la cuenta; si no hay ninguna, usa una de ejemplo.
- **Reenviar**:
  - El cuerpo de cada evento se guarda 30 días (tabla `webhook_events`, igual que la bitácora).
  - «Ver entregas» muestra el cuerpo de cada entrega y un botón «Reenviar».
- **Editar**: la dirección, la descripción y los eventos se editan desde el panel.
- **Más reintentos**: 6 intentos en unas 8 horas (1 min, 5 min, 30 min, 2 h y 6 h). Antes eran 3 en minutos.
- **Eventos nuevos**:
  - `appointment.rescheduled`;
  - `appointment.booked` y `appointment.cancelled` también sin chat (página de reservas, panel);
  - `payment.due`, `payment.overdue` y `payment.paid`, con el cobro en la misma forma que `GET /receivables`;
  - `quote.sent`, `quote.accepted` y `quote.rejected`.
- **Cita**: los eventos de cita llevan la cita en la misma forma que `GET /appointments`, no la fila interna.
- **«Todos los eventos» (`*`)** mantiene los de siempre: los eventos nuevos se eligen uno por uno, para que un Zap que ya
  funciona no empiece a recibir avisos de otro tipo. Desde el panel siempre se eligen con casillas.

## Fase C: página «Conectar» y documentación

- **«Conectar tu sistema»**, arriba de Integraciones:
  - dirección base y llave en tres pasos;
  - ejemplos `curl` copiables, ya con tu dirección y tu canal: probar la llave, alta de contacto, enviar un mensaje y
    registrar un cobro;
  - claves de los datos del cliente;
  - secreto de webhooks para copiar, con su propio botón de cambio (hoy cambiarlo también cambia el enlace del
    calendario).
- `GET /api/v1/docs`: documentación navegable generada de `openapi.json`, en el mismo servidor y sin dependencias
  externas.
- **OpenAPI al día**:
  - rutas nuevas;
  - forma real del contacto;
  - errores con `code`;
  - `Idempotency-Key`;
  - sección `webhooks` con cada evento.
- `docs/integraciones.md` y la ayuda del panel quedan al día.

## Pruebas

En `test/integrations.test.ts` y un archivo nuevo, `test/api-v1-easy.test.ts`. Cubren:
- teléfonos en varios formatos y la fusión al contestar (sin duplicados);
- el canal por omisión y sus errores;
- `data` con tipos;
- los códigos de error;
- `Idempotency-Key` (repetir, conflicto, error 5xx);
- la firma con hora;
- los eventos nuevos;
- reenviar;
- el ejemplo real;
- que OpenAPI cubre todas las rutas.

Pruebas unitarias para `normalizePhone`, `phoneVariants` y la validación de `data`.
