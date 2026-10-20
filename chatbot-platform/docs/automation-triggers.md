# Activación de automatizaciones

Las reglas deben estar activas, pertenecer al mismo perfil y coincidir con el agente y las condiciones configuradas. Las acciones conservan las restricciones de baja, atención humana, cuenta/canal inactivos y ventanas de mensajería.

## Casos corregidos

- **Nuevo contacto / primer mensaje:** se reconoce el primer mensaje entrante válido por su ID, excluyendo historial marcado como antiguo y reacciones. Dos mensajes ya almacenados no impiden reconocer el primero. Los siguientes mensajes no repiten la bienvenida.
- **Dato capturado desde el panel:** guardar o corregir un dato no vacío del contacto dispara `data_captured` para cada campo cambiado. Cambiar el nombre dispara el campo `nombre`. Datos y versión de memoria de la conversación se actualizan en la misma transacción. Las ediciones manuales no se atribuyen a un mensaje del cliente. Guardar el mismo valor o vaciarlo no dispara captura.
- **Transferencia manual:** tomar la conversación, enviar texto/foto desde el panel con toma habilitada o responder desde el teléfono con pausa por respuesta humana habilitada dispara `handoff`. La transición a atención humana es atómica: operaciones repetidas o concurrentes no repiten el evento; liberar y volver a tomar sí produce uno nuevo. Los ecos de mensajes ya enviados no producen transferencias.
- **Baja desde el panel:** cambiar de alta a baja dispara `opt_out` y detiene las secuencias activas. Repetir la baja no dispara otro evento; después de un alta puede producirse una nueva baja. La edición no manda la confirmación de palabra BAJA automáticamente.

## Flujos con botones: orden de atención y cuándo se detiene un flujo

Con cada mensaje del cliente, en este orden:

1. **Baja o alta** (palabra de baja o de alta): gana a todo; la baja detiene los flujos.
2. **Botón de un flujo**: el toque trae el identificador del juego de botones vigente de la conversación (`conversations.pending_buttons`); escrito, cuenta el texto del botón y, solo si el mensaje con botones es el último que se envió, el número ("1", "uno", "el primero"…). Un toque de un mensaje anterior no cuenta. El juego se aparta con un `UPDATE` condicional: un segundo toque (o el mismo toque por dos réplicas) no repite nada. Se envía la respuesta del botón y se hace su acción. El toque queda en la inscripción (`choice`, `choice_step`) y su `last_inbound_id` avanza: **no cuenta como "respondió"**. La IA no contesta.
3. Consentimiento (ACEPTO), detener flujos por respuesta y reglas por mensaje, como siempre.

Un flujo se detiene:

- si el cliente responde con algo que no es un botón (solo si el flujo tiene "Detener si el cliente responde");
- si se da de baja;
- al tocar "Terminar" o "Empezar otro flujo";
- si, con "Esperar a que elija" y "Terminar si no elige", llega la hora del mensaje siguiente sin elección;
- **al momento**, si una persona toma la conversación (evento `handoff`: tomarla, escribir desde el panel o el teléfono, una regla o el botón "Pasar con una persona"); sus botones dejan de contar;
- si se cancela su campaña de flujo.

Cada paso se aparta antes de enviarse (`current_step` avanza con un `UPDATE` condicional): el paso que adelanta un botón "Seguir" y el que estaba programado no salen los dos.

Los cambios de contacto se comparan con los valores anteriores bajo bloqueo de fila de PostgreSQL y los eventos se emiten después de confirmar la transacción. Se mantiene el aislamiento de perfiles y los eventos automáticos existentes del motor.

## Validación

`test/flow-buttons.test.ts` y `test/buttons.unit.test.ts` cubren los flujos con botones. `test/automation-triggers.test.ts` cubre historial y reacciones, primeros mensajes concurrentes, captura manual y correcciones, bajas y secuencias, transferencias manuales y ecos, deduplicación, cierre con acciones pendientes e intento de edición desde otro perfil. Las pruebas usan PostgreSQL real y transportes simulados.

El cierre de la aplicación espera las automatizaciones emitidas y los resúmenes en segundo plano antes de terminar.

Verificación final: compilación TypeScript aprobada; 259 pruebas aprobadas con pgvector obligatorio, ninguna omitida; 6 evaluaciones de componentes y 14 del motor en Promptfoo aprobadas. No se reprodujeron errores de uso del pool después del cierre. La entrega con servicios externos reales requiere sus credenciales y la verificación del despliegue.
