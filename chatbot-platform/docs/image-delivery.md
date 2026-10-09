# Envío de imágenes

En **Asistentes → Fotos → Reglas de envío**, elige «Solo en los momentos que marque aquí» o «En estos momentos y también cuando la IA lo crea conveniente» para activar envíos automáticos.

- **Cuando el cliente escriba:** palabras o frases completas, sin distinguir acentos o mayúsculas. Una nueva petición coincidente permite reenviar la imagen.
- **Cuando el asistente diga o pregunte:** frases de la respuesta validada que se enviará al cliente. No se compara el razonamiento interno; se respeta «Solo una vez por conversación».
- **Contextos concretos:** bienvenida, llegada a una etapa, objetivo completado y reserva confirmada. Las reacciones y el historial antiguo no bloquean la bienvenida. Una propuesta de reserva rechazada no activa la imagen de cita.
- **Enviar por contexto:** escribe una condición en lenguaje natural, por ejemplo «Cuando el cliente necesite comparar alternativas de alojamiento». Se interpreta la intención, el intercambio reciente y la respuesta propuesta, sin exigir palabras exactas. Funciona también en «Solo en los momentos que marque aquí». La selección semántica la hace la IA; el backend controla catálogo, límites, repetición y entrega.
- **Contexto libre:** en «Cuándo enviarla», describe el criterio para la IA. Se aplica en los modos «La IA decide» y «Ambos»; la interpretación semántica depende del modelo. Para condiciones explícitas, utiliza las reglas automáticas.

El catálogo se limita a imágenes activas del agente. Una coincidencia de regla y selección de IA produce un único envío. Las imágenes automáticas tienen prioridad y todas respetan el máximo de fotos por respuesta; las omitidas por ese límite aparecen en Registros. Una transferencia a atención humana no envía estas fotos automáticas.

En las respuestas de la IA, su texto se envía antes de las imágenes del catálogo. Cada imagen se almacena como pendiente, se marca como entregada cuando el transporte confirma el envío y como fallida si la plataforma la rechaza. «Foto enviada por regla» solo se registra tras la confirmación. Una foto pendiente o fallida no cuenta como entregada para evitar repeticiones; una nueva petición del cliente puede volver a intentar un envío fallido.

La confirmación del transporte no equivale a que el destinatario haya leído la imagen. Las pruebas locales usan transportes simulados; el envío real requiere una conexión activa y credenciales válidas de la plataforma.

Validación local: compilación TypeScript y JavaScript aprobadas; 270 pruebas aprobadas con pgvector obligatorio y ninguna omitida; 6 evaluaciones de componentes y 16 del motor en Promptfoo aprobadas. El editor se comprobó en Chromium sin errores JavaScript.

La evaluación del motor incluye una petición expresada con otras palabras y un saludo que no debe activar la foto. Los mismos casos se añadieron a la evaluación con OpenRouter real; requieren la clave protegida para ejecutarse.

## Mensajes guardados (texto + foto)

En **Asistentes → Fotos → Mensajes guardados** se escriben textos con una foto opcional del mismo asistente. Cada uno tiene un código, un «Cuándo enviarlo» y, si se quiere, la etapa del recorrido en la que deja la conversación.

- La IA los ve en el prompt y los elige por su código; también puedes nombrarlos en el prompt («si piden precios, envía el mensaje precios»). El texto se envía tal cual, sin que la IA lo reescriba.
- Con foto, salen en **un solo mensaje**: la foto con el texto como pie. Si la plataforma rechaza la foto, se envía el texto solo.
- Su foto cuenta para el máximo de fotos por respuesta; las fotos de la IA que no quepan se omiten y quedan en Registros.
- Si la IA no marca otra etapa, la conversación queda en la etapa del mensaje guardado.
- Su texto cuenta como información del negocio: la IA puede repetir sus datos sin que el validador los rechace.
- Los códigos inexistentes o inactivos se descartan. En una transferencia a una persona no se envían.
- Al duplicar un asistente, los mensajes guardados apuntan a las fotos copiadas.

## Envíos programados (campañas, automatizaciones y secuencias)

Si un envío lleva texto y foto, sale en un solo mensaje con el texto como pie de la foto; sin texto, se usa el pie de la foto. Si la foto falla, se envía el texto.

Para un primer mensaje que inicia un recorrido, indica en la campaña **«Etapa del recorrido al enviarla»**: cada conversación queda en esa etapa y, cuando el cliente responda, el asistente sigue el flujo desde ahí, con el mensaje enviado ya en su historial.

