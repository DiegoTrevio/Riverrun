# Preguntas en orden, activadores y desactivadores

## Instrucciones completas

Las instrucciones del asistente (pestaña **Instrucciones**) llegan completas a la IA, sin recortes. Justo después se le indica que esas instrucciones del negocio tienen prioridad sobre las guías de estilo y de conversación: si piden algo concreto (preguntas, orden, datos o mensajes), lo cumple completo. La regla de no inventar datos y las reglas generales (seguridad, pagos y datos personales) siempre quedan por encima. Si las instrucciones mencionan preguntas en otro orden, manda el orden de la pestaña «Preguntas».

## Preguntas (pestaña «Preguntas»)

Es un apartado separado del texto de instrucciones: una lista de preguntas en orden que el asistente sigue paso a paso, una por mensaje. Cada pregunta tiene:

- **Texto**: se envía tal cual (la IA puede poner antes una frase corta para conectar).
- **Tipo de respuesta**: texto libre, nombre, correo, teléfono, fecha, número o una de varias opciones.
- **Se guarda como**: la clave del dato en el contacto. Si se deja vacía, se genera a partir de la pregunta (sin palabras como «tarjeta» o «NIP», que el sistema trata como dato sensible y nunca guarda). Si coincide con un dato que ya existía sin pregunta (por ejemplo, de una plantilla), la pregunta lo reemplaza. Los datos sin pregunta se ven debajo de la lista y se pueden quitar.
- **Obligatoria**: se vuelve a preguntar hasta tener respuesta. Una opcional se hace una sola vez; si el cliente no la contesta, se sigue con la siguiente.

Lo que garantiza el sistema (no depende de la IA):

- En cada turno calcula cuál es la siguiente pregunta con las respuestas guardadas.
- Si la respuesta de la IA no la incluye, pide otra; en el último intento la agrega tal cual al final.
- Si la IA se adelanta a una pregunta posterior de la lista, o repite tal cual una que ya está respondida, la quita. Solo cuenta una oración que pregunta o pide algo: «Sí, puedes reservar para esa fecha» no es hacer la pregunta de la fecha.
- Cuando el cliente responde una pregunta, el asistente no se queda callado: hace la siguiente. Un «👍» o un mensaje automático sí puede quedar sin respuesta.
- Si el cliente se despide o dice que no le interesa (sin responder nada), no se le insiste con la pregunta en ese mensaje.
- Si la respuesta lleva mensajes guardados, la pregunta pendiente sale al final, después de ellos y de sus fotos.
- El prompt marca la pregunta «en curso» (ya hecha) y cuál sigue si el cliente la contesta en ese mensaje, para que no la repita.
- Una respuesta de texto libre (o nombre, correo o teléfono) solo cuenta si sale de lo que escribió el cliente: una respuesta inventada no da la pregunta por contestada. Para un teléfono, «a este mismo número» vale con el número desde el que escribe, y la lada del país agregada por la IA no lo invalida.
- Las opciones de una pregunta de tipo «opción» cuentan como información del negocio: ofrecerlas no se rechaza como dato inventado. Una opción de una lista fija nunca se trata como dato sensible.
- Solo un dato de tipo nombre es el nombre del contacto (`nombre`, o el primero de ese tipo). Otro, como «¿Cómo se llama el festejado?», se pregunta aparte y no cambia el nombre del contacto.
- El objetivo de la conversación no se marca cumplido mientras falten preguntas obligatorias.
- Si el cliente ya dio una respuesta (aunque sea antes de que se la pregunten), no se le vuelve a preguntar.

Las respuestas se guardan en el contacto como cualquier otro dato: aparecen en Conversaciones, en los reportes y en las automatizaciones. «Borrar memoria» de una conversación vuelve a empezar la lista. Un cliente que regresa con todo respondido no vuelve a contestar, y una opcional que ya se le hizo sin respuesta no se repite al reabrir la conversación.

La IA reconoce una pregunta aunque la adapte un poco (al menos 70 % de sus palabras clave). Una pregunta muy corta solo cuenta completa.

## Activación (pestaña «Activación»)

Antes estaba dentro de «Opciones avanzadas»; ahora es una pestaña propia.

- **Activadores**: «Siempre» o «Solo cuando el cliente escriba una de estas palabras». En el segundo modo, hasta que el cliente escriba una de las palabras, el asistente no contesta en esa conversación. El servidor rechaza cambiar a este modo sin ninguna palabra (un asistente que ya estaba así puede seguir guardando lo demás).
- **Desactivadores**: palabras del cliente, objetivo cumplido, cita agendada, datos completos y, nuevo, **cuando el cliente responda todas las preguntas**. También se puede activar desde la pestaña «Preguntas». Al cambiar la clave de una pregunta o quitarla, «datos completos» se actualiza solo; los datos marcados que no están en la lista también se muestran para poder desmarcarlos.
- **Al desactivarse**: pausa en silencio, pasar a una persona o cerrar, con un mensaje opcional.

«Cuando el cliente responda todas las preguntas» se cumple una sola vez por recorrido, en el turno en que se resuelve la última pregunta pendiente (contestada o, si es opcional, sin respuesta). El asistente responde ese mensaje y después se apaga. No se dispara para un cliente que vuelve con todas las preguntas ya respondidas. El fin de la lista queda registrado en la conversación aunque ese turno sea una transferencia o no lleve respuesta: en una transferencia no apaga al asistente, y tampoco lo apaga después, cuando el equipo devuelve la conversación.
