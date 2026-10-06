# Creación sencilla del agente

En **Asistentes → Nuevo asistente** (o **Primeros pasos → Crear agente en 3 pasos**), completa tres bloques:

1. **Tu negocio:** nombre, giro e información para responder (servicios, precios, horarios, ubicación y condiciones).
2. **Qué debe lograr:** el resultado que esperas de la conversación.
3. **Qué debe preguntar:** las preguntas clave, escritas con tus palabras.

**Crear y probar** organiza las instrucciones, guarda el objetivo en el recorrido y crea un documento de conocimiento. El agente nace apagado y abre el simulador. No se crean campos manuales: el motor existente captura las respuestas y correcciones en el contacto y la conversación.

Desde cualquier pestaña del agente, **Conectar teléfono / ver QR** abre la creación de un canal con el agente seleccionado. Cada perfil permite hasta cuatro conexiones WhatsApp; un mismo agente puede atender varias. Enciéndelo desde Instrucciones cuando hayas probado sus respuestas y conectado el canal.

Se conservan las cuatro pestañas: Instrucciones, Conocimiento, Fotos y Probar. Las reglas, activación, modelo, administración y recorrido permanecen en Opciones avanzadas; cada sección se carga al abrirla. Conocimiento consulta sus documentos y el estado del índice en paralelo.

## Guardado y compatibilidad

`POST /api/chatbots` admite opcionalmente `setup: { goal, questions, knowledge }`. Valida textos no vacíos y límites antes de escribir. El agente y su documento se insertan en una misma transacción: un error revierte ambas inserciones. El perfil se resuelve con los permisos existentes, nunca desde el contenido del prompt. Las peticiones antiguas y las actualizaciones parciales siguen funcionando.

El objetivo tiene una sola fuente, `flow.goal`; las instrucciones hacen referencia al objetivo configurado para evitar conservar un objetivo anterior al editarlo. Las preguntas se guardan en `personality.prompt`. La información factual se guarda en `knowledge_items` y utiliza el indexador automático existente. Crear no necesita una llamada al proveedor de IA. Probar y generar embeddings sí requieren su configuración habitual.
