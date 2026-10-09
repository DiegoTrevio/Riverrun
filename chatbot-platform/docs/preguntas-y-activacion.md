# Preguntas en orden, activadores y desactivadores

## Instrucciones completas

Las instrucciones del asistente (pestaña **Instrucciones**) llegan completas a la IA, sin recortes. Justo después se le indica que esas instrucciones del negocio tienen prioridad sobre las guías generales de estilo: si piden algo concreto (preguntas, orden, datos o mensajes), lo cumple completo.

## Preguntas (pestaña «Preguntas»)

Es un apartado separado del texto de instrucciones: una lista de preguntas en orden que el asistente sigue paso a paso, una por mensaje. Cada pregunta tiene:

- **Texto**: se envía tal cual (la IA puede poner antes una frase corta para conectar).
- **Tipo de respuesta**: texto libre, nombre, correo, teléfono, fecha, número o una de varias opciones.
- **Se guarda como**: la clave del dato en el contacto. Si se deja vacía, se genera a partir de la pregunta.
- **Obligatoria**: se vuelve a preguntar hasta tener respuesta. Una opcional se hace una sola vez; si el cliente no la contesta, se sigue con la siguiente.

Lo que garantiza el sistema (no depende de la IA):

- En cada turno calcula cuál es la siguiente pregunta con las respuestas guardadas.
- Si la respuesta de la IA no la incluye, pide otra; en el último intento la agrega tal cual al final.
- Si la IA se adelanta a una pregunta posterior de la lista, la quita.
- Con una pregunta pendiente, el asistente no se queda callado.
- Una respuesta de texto libre (o nombre, correo o teléfono) solo cuenta si sale de lo que escribió el cliente: una respuesta inventada no da la pregunta por contestada.
- El objetivo de la conversación no se marca cumplido mientras falten preguntas obligatorias.
- Si el cliente ya dio una respuesta (aunque sea antes de que se la pregunten), no se le vuelve a preguntar.

Las respuestas se guardan en el contacto como cualquier otro dato: aparecen en Conversaciones, en los reportes y en las automatizaciones. «Borrar memoria» de una conversación vuelve a empezar la lista. Un cliente que regresa con todo respondido no vuelve a contestar.

La IA reconoce una pregunta aunque la adapte un poco (al menos 70 % de sus palabras clave). Una pregunta muy corta solo cuenta completa.

## Activación (pestaña «Activación»)

Antes estaba dentro de «Opciones avanzadas»; ahora es una pestaña propia.

- **Activadores**: «Siempre» o «Solo cuando el cliente escriba una de estas palabras». En el segundo modo, hasta que el cliente escriba una de las palabras, el asistente no contesta en esa conversación. El servidor rechaza guardar este modo sin ninguna palabra.
- **Desactivadores**: palabras del cliente, objetivo cumplido, cita agendada, datos completos y, nuevo, **cuando el cliente responda todas las preguntas**. También se puede activar desde la pestaña «Preguntas».
- **Al desactivarse**: pausa en silencio, pasar a una persona o cerrar, con un mensaje opcional.

«Cuando el cliente responda todas las preguntas» se cumple una sola vez por recorrido, en el turno en que se resuelve la última pregunta pendiente (contestada o, si es opcional, sin respuesta). El asistente responde ese mensaje y después se apaga. No se dispara para un cliente que vuelve con todas las preguntas ya respondidas.
