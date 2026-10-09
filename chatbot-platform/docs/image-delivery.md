# Envío de imágenes

En **Asistentes → Fotos → Reglas de envío**, elige «Solo en los momentos que marque aquí» o «En estos momentos y también cuando la IA lo crea conveniente» para activar envíos automáticos.

- **Cuando el cliente escriba:** palabras o frases completas, sin distinguir acentos o mayúsculas. Si la foto ya se envió (y es «una sola vez»), solo se reenvía cuando el cliente la vuelve a pedir: una pregunta, «mándame», «otra vez», «no me llegó» o la palabra sola. Mencionarla al agradecer («gracias, me quedo con la doble») no la repite.
- **Cuando el asistente diga o pregunte:** frases de la respuesta validada que se enviará al cliente. No se compara el razonamiento interno; se respeta «Solo una vez por conversación».
- **Contextos concretos:** bienvenida, llegada a una etapa, objetivo completado y reserva confirmada. Las reacciones y el historial antiguo no bloquean la bienvenida. Una propuesta de reserva rechazada no activa la imagen de cita.
- **Enviar por contexto:** escribe una condición en lenguaje natural, por ejemplo «Cuando el cliente necesite comparar alternativas de alojamiento». Se interpreta la intención, el intercambio reciente y la respuesta propuesta, sin exigir palabras exactas. Funciona también en «Solo en los momentos que marque aquí». La selección semántica la hace la IA; el backend controla catálogo, límites, repetición y entrega.
- **Contexto libre:** en «Cuándo enviarla», describe el criterio para la IA. Se aplica en los modos «La IA decide» y «Ambos»; la interpretación semántica depende del modelo. Para condiciones explícitas, utiliza las reglas automáticas.

## Fotos que pide el prompt (Instrucciones)

Puedes escribir en las Instrucciones cuándo enviar una foto, por su ID: «Cuando pregunten por la suite, envía la foto suite». Para que la IA pueda hacerlo, la foto debe estar activa y en «La IA decide» o «Ambos».

- **La IA decide:** la foto aparece en el catálogo de la IA con su ID, «Cuándo enviarla» y lo que muestra. El prompt le indica que, si las instrucciones dicen cuándo enviarla, la incluya en ese momento.
- **Ambos:** aparece una sola vez en el catálogo de la IA, con sus momentos automáticos («además el sistema la envía sola…») y su condición de contexto («también cuando…»). Ya no se le dice a la IA que no la use.
- **Solo en los momentos que marque aquí:** la IA no puede elegirla. El prompt la lista con su ID bajo «solo en sus momentos» y le dice que, si las instrucciones la piden, no la prometa: sale sola en su momento.
- **Avisos en el panel** (Instrucciones y Fotos): si las instrucciones nombran una foto desactivada, una que no existe (por ejemplo, porque cambió su ID) o una que solo se envía en sus momentos, y si una foto está en «Solo en los momentos» sin ningún momento (nunca se enviaría; la tarjeta lo marca «sin momentos»). Al cambiar el ID de una foto que piden las instrucciones, el panel avisa que hay que cambiarlo también ahí.

## Garantías

- **Solo fotos reales:** el catálogo se limita a imágenes activas del asistente. Una coincidencia de regla y selección de IA produce un único envío, y la misma foto en dos mensajes guardados también sale una vez.
- **Nunca promete una foto que no sale.** El validador reconoce las promesas («te comparto el menú», «aquí está la foto», «te voy a mandar las fotos», «te la mando» cuando el cliente habla de una foto…). Si la oración nombra una foto, esa foto debe salir en la respuesta (no basta con que salga otra). Si no sale, pide otra respuesta a la IA con el motivo concreto (ya enviada, solo automática, no cabe, transferencia) y, en el último intento, quita la oración. «Menú» o «catálogo» solo cuentan como foto si el catálogo tiene una con ese nombre.
- **Nunca deja al cliente sin respuesta:** si las correcciones del último intento vacían la respuesta, sale la pregunta pendiente o el mensaje de respaldo.
- **Máximo de fotos por respuesta:** las fotos de los mensajes guardados ocupan primero su lugar; después van las que eligió la IA (las anunció en su texto); las automáticas que no caben salen unos segundos después. Las que eligió la IA y no caben no se prometen. Con el máximo en **0** el asistente no envía fotos (ni automáticas ni de mensajes guardados).
- **Reenvíos:** con «No reenviar fotos ya enviadas», una foto se vuelve a enviar si el cliente la pide de nuevo («¿me la vuelves a mandar?», «no me llegó»). Si nombra fotos, solo esas.
- **Transferencias:** al pasar con una persona no se envían fotos y la IA no puede anunciar una.
- **Respaldo o cita fallida:** si la respuesta de la IA no pasó la validación, o la cita no se pudo agendar, no se marcan el objetivo ni la etapa y no salen sus fotos.
- **Una persona toma la conversación** mientras se envía la respuesta: el asistente no envía lo que falta, no se despide, no cierra, pausa ni transfiere la conversación, y las fotos pendientes no salen después del mensaje de esa persona.

**Nada de lo que el negocio programó se pierde en silencio.** Una foto que sale por una regla (palabra, bienvenida, etapa, objetivo, cita…) y no pudo enviarse en su respuesta queda como tarea pendiente y se entrega después:

- *No cupo* en el máximo por respuesta: sale unos segundos después, sin repetir ninguna. (Las que solo eligió la IA y no caben sí se omiten, y aparecen en Registros.)
- *La plataforma la rechazó*: se reintenta a los ~45 segundos y, si vuelve a fallar, con espera creciente (hasta 3 intentos). Cada intento queda en Registros («Foto enviada por regla (pendiente)»). Esto aplica también a la foto que eligió la IA (y ya anunció) y a la foto de un mensaje guardado que además pide una regla.
- Un reenvío que pidió el cliente se entrega aunque la foto sea «una sola vez».
- La tarea se cancela (y queda en Registros con el motivo) si el recorrido se reinició, si la foto ya llegó, si ya no está activa, si una persona respondió desde que se programó o si el cliente pausó al asistente. Si el asistente ya no atiende (pasó a una persona o se cerró), la foto pendiente solo sale cuando fue el propio asistente quien terminó la conversación en ese mismo turno (por ejemplo, al cumplir el objetivo).
- «Una sola vez por conversación» se cuenta **por recorrido**: si la conversación se cierra y el cliente vuelve a escribir (o se borra su memoria), las fotos de etapa y de objetivo vuelven a enviarse.

**Etapas del recorrido:** si quitas o reordenas etapas, las fotos y los mensajes guardados que se envían en una etapa la siguen (con su nuevo número), y las conversaciones en curso se quedan en la misma etapa. Una foto de una etapa que se quitó deja de tener ese momento.

**Fotos borradas:** al borrar una foto que usaba una regla automática o una secuencia, se quita de ellas (siguen pudiéndose guardar y desactivar) y el panel lo avisa. Los selectores de foto marcan las inactivas («no se enviará») y las borradas.

**Messenger e Instagram** no tienen pie de foto: el texto se envía aparte, justo después. Si ese texto falla, la foto ya entregada no cuenta como fallida (no se reenvía repetida). Instagram rechaza textos de más de 1000 bytes: se dividen en varias partes, por palabras.

En las respuestas de la IA, su texto se envía antes de las imágenes del catálogo. Cada imagen se almacena como pendiente, se marca como entregada cuando el transporte confirma el envío y como fallida si la plataforma la rechaza. «Foto enviada por regla» solo se registra tras la confirmación. Una foto pendiente o fallida no cuenta como entregada para evitar repeticiones; una nueva petición del cliente puede volver a intentar un envío fallido.

La confirmación del transporte no equivale a que el destinatario haya leído la imagen. Las pruebas locales usan transportes simulados; el envío real requiere una conexión activa y credenciales válidas de la plataforma.

Validación local: compilación TypeScript y JavaScript aprobadas; 600 pruebas aprobadas con pgvector obligatorio y ninguna omitida (incluye `test/image-prompt.test.ts`: promesas, reenvíos, límite, reintentos, transferencias, respaldo, toma por una persona, máximo 0, avisos del panel y Messenger/Instagram); 6 evaluaciones de componentes y 16 del motor en Promptfoo aprobadas. El panel (avisos, insignias, etapas y fotos borradas) se comprobó en Chromium sin errores JavaScript.

La evaluación del motor incluye una petición expresada con otras palabras y un saludo que no debe activar la foto. Los mismos casos se añadieron a la evaluación con OpenRouter real; requieren la clave protegida para ejecutarse.

## Mensajes guardados (texto + foto)

En **Asistentes → Fotos → Mensajes guardados** se escriben textos con una foto opcional del mismo asistente. Cada uno tiene un código, un «Cuándo enviarlo» y, si se quiere, la etapa del recorrido en la que deja la conversación.

- La IA los ve en el prompt y los elige por su código; también puedes nombrarlos en el prompt («si piden precios, envía el mensaje precios»). El texto se envía tal cual, sin que la IA lo reescriba.
- Con foto, salen en **un solo mensaje**: la foto con el texto como pie. Si la plataforma rechaza la foto, se envía el texto solo. Un texto de más de 1024 caracteres (el límite de pie de foto de Telegram y WhatsApp) sale aparte, antes de la foto.
- Su foto cuenta para el máximo de fotos por respuesta; las fotos de la IA que no quepan se omiten y quedan en Registros. Si esa misma foto también la pide una regla o la IA, sale una sola vez.
- Un mensaje guardado que es solo foto, y cuya foto ya no está o no cabe en el máximo, no cuenta como respuesta: el validador pide otra a la IA en lugar de dejar al cliente sin contestar. Si la foto se borró o se desactivó, el prompt lo presenta como «solo texto» (o no lo ofrece si no tiene texto) y la lista se puede seguir guardando; el panel marca la foto que falta.
- Si una persona toma la conversación mientras se envía la respuesta, los mensajes guardados que faltan ya no salen.
- Si la IA no marca otra etapa, la conversación queda en la etapa del mensaje guardado.
- Su texto cuenta como información del negocio: la IA puede repetir sus datos sin que el validador los rechace.
- Los códigos inexistentes o inactivos se descartan. En una transferencia a una persona no se envían.
- Al duplicar un asistente, los mensajes guardados apuntan a las fotos copiadas.

## Envíos programados (campañas, automatizaciones y secuencias)

Si un envío lleva texto y foto, sale en un solo mensaje con el texto como pie de la foto; sin texto, se usa el pie de la foto. Si la foto falla, se envía el texto. Un texto de más de 1024 caracteres (con el pie de baja incluido) sale aparte y la foto después, con su propio pie. Si solo es foto y su pie más el de baja no caben, el de baja sale como texto aparte.

Para un primer mensaje que inicia un recorrido, indica en la campaña **«Etapa del recorrido al enviarla»**: cada conversación empieza un recorrido nuevo en esa etapa (el objetivo y las preguntas vuelven a contar desde ahí) y, cuando el cliente responda, el asistente sigue el flujo desde esa etapa, con el mensaje enviado ya en su historial. Su foto cuenta como ya enviada en ese recorrido, así que el asistente no la repite. Funciona también con conversaciones cerradas: al reabrirse porque el cliente contesta la campaña, se conserva la etapa en lugar de empezar de cero.

