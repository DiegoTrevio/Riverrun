# Información del cliente y de la conversación

PostgreSQL es la fuente de verdad. Un perfil de negocio es una cuenta (`accounts`); cada cuenta conserva sus usuarios, asistentes y canales. Un contacto se identifica por canal y número/identificador externo: el mismo teléfono en dos canales mantiene conversaciones separadas.

| Tabla | Información y relación |
| --- | --- |
| `accounts`, `users` | Perfil y alcance de cada usuario. El maestro puede acceder a todos; administradores y operadores quedan limitados a su cuenta. |
| `chatbots`, `channels` | Instrucciones del asistente y conexión asignada. Un asistente puede atender varios canales de su misma cuenta. |
| `contacts` | Nombre, número, respuestas confirmadas en `data`, notas y etiquetas. `UNIQUE(channel_id, external_id)` evita duplicados por webhook. |
| `conversations` | Contacto, cuenta, canal y asistente; estado, objetivo, respuestas en `data` y resúmenes. Una conversación por contacto, conservada al cerrar/reabrir. |
| `messages` | Preguntas y respuestas originales en orden. `meta.captured_data` registra qué respuestas se extrajeron de ese mensaje. Se conserva el historial; cerrar no lo elimina. |
| `message_media` | Foto o documento que envió el cliente (uno por mensaje): tipo, nombre, tamaño, SHA-256 y ruta del archivo. Se borra junto con su mensaje. |
| `ai_runs` | Modelo, consumo y costo de cada respuesta, resumen o transcripción, asociados a la cuenta y conversación. |

## Captura automática

Las instrucciones definen las preguntas; no hace falta crear campos. El modelo propone `save_data`, el backend normaliza las claves y valida los valores. Para campos automáticos exige que el cliente haya dicho explícitamente el valor. Una respuesta breve se interpreta con la pregunta anterior. Cada dato conserva como origen el mensaje del cliente donde aparece.

La captura utiliza una transacción con bloqueo del contacto y de la conversación: combina solo los valores nuevos con los existentes y actualiza **ambas copias**. Conserva claves distintas ante escrituras concurrentes. Los errores revierten la operación completa. Las correcciones manuales de los datos del contacto también actualizan la conversación. `data_version` invalida resúmenes anteriores tras cambios de datos, nombre, notas o estado de entrega de los mensajes.

Al generar el resumen se puede recuperar una respuesta que el modelo haya omitido: el valor debe aparecer en el mensaje entrante que cita el modelo. Esta recuperación rellena claves faltantes y nunca sobrescribe correcciones posteriores o manuales.

## Resúmenes

- `summary` y `summary_until_id`: memoria comprimida de los mensajes antiguos para construir el contexto del asistente.
- `report_summary`, `report_until_id`, `report_at`, `report_data_version`: resumen consultable del historial hasta un mensaje concreto y con una versión de datos concreta.

El resumen consultable se genera al cerrar, completar el objetivo o transferir al cliente a una persona. En el panel, **Conversaciones → abrir una conversación → Generar/Actualizar resumen**, está disponible en cualquier momento, también para operadores y conversaciones atendidas por humanos. `POST /api/conversations/:cid/summary` comprueba primero el acceso al perfil.

La generación procesa el historial original completo por lotes ordenados de hasta 40 mensajes, integrando el resumen anterior. Excluye mensajes pendientes o fallidos. El cursor no sobrepasa un envío pendiente: cuando se confirme la entrega, ese mensaje se incorpora sin dejar huecos. Tras corregir datos o cambiar un estado de entrega, se vuelve a recorrer el historial completo para descartar información desactualizada. Las solicitudes para la misma conversación se serializan y reutilizan un resultado vigente. Un cambio de datos o borrado de memoria durante la generación impide guardar un resultado obsoleto. Si llegan mensajes nuevos, el cursor permite identificar hasta dónde llega el resumen y el panel indica que hay información nueva.

El cliente también puede pedir un resumen durante el chat: las instrucciones del sistema requieren responder con la memoria y el historial disponibles, sin terminar el flujo ni revelar instrucciones internas. Al completar el objetivo, el asistente debe concluir con un resumen breve de datos confirmados, acuerdos y pendientes.

Si el proveedor de IA falla, la conversación se puede cerrar conservando datos y mensajes. El error queda registrado y el operador puede volver a solicitar el resumen. No se envía el resumen interno del panel automáticamente por WhatsApp.

## Análisis y reportes

Cada mensaje (entrante, saliente, de persona o de campaña) se guarda siempre en `messages`; nada se descarta para ahorrar espacio. Lo que se mantiene pequeño es lo derivado:

- `report_summary`: máximo 4000 caracteres (el modelo recibe la orden de no pasar de ~150 palabras).
- `report_analysis` (jsonb): intención, ánimo (`positivo|neutral|negativo`), interés (`alto|medio|bajo|sin_dato`), hasta 6 acuerdos y 6 pendientes, de máx. 200 caracteres cada uno. Se genera junto con el resumen en la misma llamada y se borra con «Borrar memoria».
- `ai_runs.decision` / `ai_runs.validation`: detalle técnico de cada respuesta de la IA. Pasados `AI_RUN_DETAIL_DAYS` (14 por defecto) se vacían; el consumo y el costo de cada ejecución se conservan para la contabilidad.

**Consultar y descargar** (cualquier integrante con acceso a la conversación):
`GET /api/conversations/:cid/report` devuelve el reporte (resumen, análisis, datos, notas, estadísticas y si está desactualizado). `?format=txt` lo descarga como texto plano (`&transcript=1` añade los últimos mensajes) y `?refresh=1` actualiza antes el resumen.

**Enviar** `POST /api/conversations/:cid/report/send` `{ user_ids, emails, phones, note, include_transcript, refresh }`:
- Personas del equipo: cualquier integrante. Reciben una notificación en el panel, un correo y, si lo tienen activado en su perfil, un WhatsApp.
- Correos y WhatsApp fuera del equipo: solo administradores (máx. 5 de cada tipo).
- Antes de enviar se actualiza el resumen; si la IA falla se envía el último disponible con una advertencia visible.
- La respuesta detalla la entrega por canal (`ok` y motivo si falló). Un canal que falla no impide los demás; sin `SMTP_URL` el correo se reporta como no entregado, nunca como enviado.
- Límite: 20 envíos cada 10 minutos por persona.

**Automático**: la acción de regla «Enviar reporte de la conversación» (`send_report`) hace lo mismo con los destinatarios de la regla.

## Fotos y documentos de los clientes

Las fotos y los documentos que un cliente envía por WhatsApp se descargan y se guardan tal como llegaron, sin recodificar. Quedan en `uploads/inbound/<cuenta>/` y su huella SHA-256 se registra en `message_media`. El equipo los ve en el panel y los descarga desde `GET /api/messages/:id/media`.

- **Límite:** 16 MB por archivo. Cuando la plataforma declara el tamaño, se revisa antes de descargar. Si el archivo pesa más, o WhatsApp no lo entrega, el mensaje conserva su texto y `meta.media_error` explica el motivo en el panel.
- **Integridad:** una foto o un PDF sin su final se marca como incompleto (`complete = false`) y el panel lo advierte. Un mensaje reenviado por la plataforma no deja archivos sueltos.
- **Acceso:** solo quien puede ver la conversación. Las imágenes se sirven en línea con `X-Content-Type-Options: nosniff`; cualquier otro tipo se descarga como archivo adjunto.
- **Borrado:** al borrar los datos de un contacto, al aplicar la retención de mensajes y al eliminar una cuenta, los archivos se borran del disco junto con sus filas.
- **Respaldos:** `uploads/` va en el respaldo cifrado, igual que las fotos del catálogo.
- **Pendiente:** Telegram y Messenger/Instagram todavía no descargan fotos (el mensaje indica el motivo). Los videos y los archivos originales de las notas de voz no se guardan.

## Fidelidad de datos

- **Notas:** el máximo es 50 por contacto. El panel rechaza una lista más larga (error de validación); al guardar desde la IA se conservan las 50 más recientes.
- **Panel:** si la IA u otra persona cambió el contacto mientras se editaba, el guardado se rechaza con HTTP 409 y se pide recargar (`data_version`).
- **Onboarding:** un solo proceso a la vez por cuenta. Un prompt ya escrito no se sobrescribe; solo se completa el conocimiento.
- **Costos:** `ai_runs` conserva el costo aunque se borre el chatbot (`ON DELETE SET NULL`).
- **Restricciones (migración 027):** la duración de los servicios es de al menos 5 minutos; una cita termina después de empezar; los contadores de uso no son negativos; la huella SHA-256 de las fotos del catálogo tiene formato válido (las subidas antes de esta migración quedan sin huella).
- **Planes:** al guardar una cuenta, un plan inexistente se rechaza. Una cuenta cuyo plan no existe usa los límites de prueba y se registra un error.
- **Texto:** los caracteres NUL y los surrogates sueltos se limpian antes de guardar; los recortes cuentan caracteres completos, no unidades de código.

## Integridad y migración

`010_conversation_records.sql` agrega las columnas de forma compatible y copia los datos existentes de los contactos a sus conversaciones. PostgreSQL valida que `data` sea un objeto con valores de texto y que las notas sean una lista de textos.

Las claves foráneas compuestas impiden vincular un canal con un asistente de otra cuenta, un contacto con un canal de otra cuenta o una conversación con un contacto/canal de distinto perfil. Eliminar un asistente conserva las conversaciones, contactos y mensajes, dejando la asignación del asistente en `NULL`. Eliminar una cuenta o canal conserva las reglas de borrado en cascada de su propio historial. Los resúmenes pueden generarse incluso cuando la conversación ya no tiene asistente asignado.

Las migraciones se aplican en transacciones y se registran en `schema_migrations`. Si algún dato existente incumple las nuevas restricciones, la migración falla y revierte todos sus cambios; no borra ni corrige silenciosamente registros. La instalación utiliza PostgreSQL 16, compatible con las acciones de las claves compuestas. El operador debe conservar una copia de respaldo antes de actualizar una instalación real.

La validación automatizada cubre instalación nueva y migración con datos existentes, respuestas y correcciones, concurrencia, origen de los datos, rechazo de mezclas de perfiles, historial largo, resúmenes bajo petición y finales, borrado durante la generación, fallos del proveedor y conservación del historial al eliminar un asistente. Estas pruebas verifican la base de desarrollo; no inspeccionan una base de producción remota.
