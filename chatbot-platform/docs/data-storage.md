# Información del cliente y de la conversación

PostgreSQL es la fuente de verdad. Un perfil de negocio es una cuenta (`accounts`); cada cuenta conserva sus usuarios, asistentes y canales. Un contacto se identifica por canal y número/identificador externo: el mismo teléfono en dos canales mantiene conversaciones separadas.

| Tabla | Información y relación |
| --- | --- |
| `accounts`, `users` | Perfil y alcance de cada usuario. El maestro puede acceder a todos; administradores y operadores quedan limitados a su cuenta. |
| `chatbots`, `channels` | Instrucciones del asistente y conexión asignada. Un asistente puede atender varios canales de su misma cuenta. |
| `contacts` | Nombre, número, respuestas confirmadas en `data`, notas y etiquetas. `UNIQUE(channel_id, external_id)` evita duplicados por webhook. |
| `conversations` | Contacto, cuenta, canal y asistente; estado, objetivo, respuestas en `data` y resúmenes. Una conversación por contacto, conservada al cerrar/reabrir. |
| `messages` | Preguntas y respuestas originales en orden. `meta.captured_data` registra qué respuestas se extrajeron de ese mensaje. Se conserva el historial; cerrar no lo elimina. |
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

## Integridad y migración

`010_conversation_records.sql` agrega las columnas de forma compatible y copia los datos existentes de los contactos a sus conversaciones. PostgreSQL valida que `data` sea un objeto con valores de texto y que las notas sean una lista de textos.

Las claves foráneas compuestas impiden vincular un canal con un asistente de otra cuenta, un contacto con un canal de otra cuenta o una conversación con un contacto/canal de distinto perfil. Eliminar un asistente conserva las conversaciones, contactos y mensajes, dejando la asignación del asistente en `NULL`. Eliminar una cuenta o canal conserva las reglas de borrado en cascada de su propio historial. Los resúmenes pueden generarse incluso cuando la conversación ya no tiene asistente asignado.

Las migraciones se aplican en transacciones y se registran en `schema_migrations`. Si algún dato existente incumple las nuevas restricciones, la migración falla y revierte todos sus cambios; no borra ni corrige silenciosamente registros. La instalación utiliza PostgreSQL 16, compatible con las acciones de las claves compuestas. El operador debe conservar una copia de respaldo antes de actualizar una instalación real.

La validación automatizada cubre instalación nueva y migración con datos existentes, respuestas y correcciones, concurrencia, origen de los datos, rechazo de mezclas de perfiles, historial largo, resúmenes bajo petición y finales, borrado durante la generación, fallos del proveedor y conservación del historial al eliminar un asistente. Estas pruebas verifican la base de desarrollo; no inspeccionan una base de producción remota.
