# Envío de imágenes

En **Asistentes → Fotos → Reglas de envío**, elige «Solo en los momentos que marque aquí» o «En estos momentos y también cuando la IA lo crea conveniente» para activar envíos automáticos.

- **Cuando el cliente escriba:** palabras o frases completas, sin distinguir acentos o mayúsculas. Una nueva petición coincidente permite reenviar la imagen.
- **Cuando el asistente diga o pregunte:** frases de la respuesta validada que se enviará al cliente. No se compara el razonamiento interno; se respeta «Solo una vez por conversación».
- **Contextos concretos:** bienvenida, llegada a una etapa, objetivo completado y reserva confirmada. Las reacciones y el historial antiguo no bloquean la bienvenida. Una propuesta de reserva rechazada no activa la imagen de cita.
- **Enviar por contexto:** escribe una condición en lenguaje natural, por ejemplo «Cuando el cliente necesite comparar alternativas de alojamiento». Se interpreta la intención, el intercambio reciente y la respuesta propuesta, sin exigir palabras exactas. Funciona también en «Solo en los momentos que marque aquí». La selección semántica la hace la IA; el backend controla catálogo, límites, repetición y entrega.
- **Contexto libre:** en «Cuándo enviarla», describe el criterio para la IA. Se aplica en los modos «La IA decide» y «Ambos»; la interpretación semántica depende del modelo. Para condiciones explícitas, utiliza las reglas automáticas.

El catálogo se limita a imágenes activas del agente. Una coincidencia de regla y selección de IA produce un único envío. Las imágenes automáticas tienen prioridad y todas respetan el máximo de fotos por respuesta. Una transferencia a atención humana no envía estas fotos automáticas.

**Nada de lo que el negocio programó se pierde en silencio.** Una foto que sale por una regla (palabra, bienvenida, etapa, objetivo, cita…) y no pudo enviarse en su respuesta queda como tarea pendiente y se entrega después:

- *No cupo* en el máximo por respuesta: sale unos segundos después, sin repetir ninguna. (Las que solo eligió la IA y no caben sí se omiten, y aparecen en Registros.)
- *La plataforma la rechazó*: se reintenta a los ~45 segundos y, si vuelve a fallar, con espera creciente (hasta 3 intentos). Cada intento queda en Registros («Foto enviada por regla (pendiente)»).
- La tarea se cancela si el recorrido se reinició, si la foto ya llegó, si ya no está activa o si una persona respondió desde que se programó. Si el asistente ya no atiende (pasó a una persona o se cerró), la foto pendiente solo sale cuando fue el propio asistente quien terminó la conversación en ese mismo turno (por ejemplo, al cumplir el objetivo).
- «Una sola vez por conversación» se cuenta **por recorrido**: si la conversación se cierra y el cliente vuelve a escribir (o se borra su memoria), las fotos de etapa y de objetivo vuelven a enviarse.

El texto se envía antes de las imágenes. Cada imagen se almacena como pendiente, se marca como entregada cuando el transporte confirma el envío y como fallida si la plataforma la rechaza. «Foto enviada por regla» solo se registra tras la confirmación. Una foto pendiente o fallida no cuenta como entregada para evitar repeticiones; una nueva petición del cliente puede volver a intentar un envío fallido.

La confirmación del transporte no equivale a que el destinatario haya leído la imagen. Las pruebas locales usan transportes simulados; el envío real requiere una conexión activa y credenciales válidas de la plataforma.

Validación local: compilación TypeScript y JavaScript aprobadas; 270 pruebas aprobadas con pgvector obligatorio y ninguna omitida; 6 evaluaciones de componentes y 16 del motor en Promptfoo aprobadas. El editor se comprobó en Chromium sin errores JavaScript.

La evaluación del motor incluye una petición expresada con otras palabras y un saludo que no debe activar la foto. Los mismos casos se añadieron a la evaluación con OpenRouter real; requieren la clave protegida para ejecutarse.
