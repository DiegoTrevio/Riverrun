# Envío de imágenes

En **Asistentes → Fotos → Reglas de envío**, elige «Solo en los momentos que marque aquí» o «En estos momentos y también cuando la IA lo crea conveniente» para activar envíos automáticos.

- **Cuando el cliente escriba:** palabras o frases completas, sin distinguir acentos o mayúsculas. Una nueva petición coincidente permite reenviar la imagen.
- **Cuando el asistente diga o pregunte:** frases de la respuesta validada que se enviará al cliente. No se compara el razonamiento interno; se respeta «Solo una vez por conversación».
- **Contextos concretos:** bienvenida, llegada a una etapa, objetivo completado y reserva confirmada. Las reacciones y el historial antiguo no bloquean la bienvenida. Una propuesta de reserva rechazada no activa la imagen de cita.
- **Contexto libre:** en «Cuándo enviarla», describe el criterio para la IA. Se aplica en los modos «La IA decide» y «Ambos»; la interpretación semántica depende del modelo. Para condiciones explícitas, utiliza las reglas automáticas.

El catálogo se limita a imágenes activas del agente. Una coincidencia de regla y selección de IA produce un único envío. Las imágenes automáticas tienen prioridad y todas respetan el máximo de fotos por respuesta; las omitidas por ese límite aparecen en Registros. Una transferencia a atención humana no envía estas fotos automáticas.

El texto se envía antes de las imágenes. Cada imagen se almacena como pendiente, se marca como entregada cuando el transporte confirma el envío y como fallida si la plataforma la rechaza. «Foto enviada por regla» solo se registra tras la confirmación. Una foto pendiente o fallida no cuenta como entregada para evitar repeticiones; una nueva petición del cliente puede volver a intentar un envío fallido.

La confirmación del transporte no equivale a que el destinatario haya leído la imagen. Las pruebas locales usan transportes simulados; el envío real requiere una conexión activa y credenciales válidas de la plataforma.

Validación local: compilación TypeScript y JavaScript aprobadas; 267 pruebas aprobadas con pgvector obligatorio y ninguna omitida; 6 evaluaciones de componentes y 14 del motor en Promptfoo aprobadas. El editor se comprobó en Chromium sin errores JavaScript.
