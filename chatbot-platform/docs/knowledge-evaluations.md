# pgvector y Promptfoo

pgvector mejora la selección de conocimiento por significado. Promptfoo mide regresiones de los componentes y del motor completo, con almacenamiento real y transporte simulado. Son herramientas diferentes: ninguna sustituye PostgreSQL como fuente de verdad, las instrucciones del agente ni la validación de las respuestas.

## Búsqueda semántica

Para la activación verificable, consulta el [procedimiento del punto 2](semantic-activation.md), incluidos comandos, comprobación del proveedor y compatibilidad de volúmenes/collation.

Docker Compose utiliza `pgvector/pgvector:0.8.7-pg16`, conservando PostgreSQL 16 y el volumen existente. Antes de cambiar la imagen en una instalación real, respalda PostgreSQL y comprueba la restauración. No borres el volumen. En proveedores administrados instala/habilita `vector` con los permisos de ese proveedor.

La migración `011_knowledge_vectors.sql` instala la extensión y crea `knowledge_chunks` cuando el servidor la ofrece. Si el servidor es PostgreSQL sin pgvector, la migración conserva la app operativa; el arranque vuelve a comprobarlo para admitir una actualización posterior del servidor. La cuenta que ejecuta migraciones necesita permiso para crear la extensión disponible. Los errores de permisos no se silencian.

Configura y reinicia el backend:

```dotenv
KNOWLEDGE_SEARCH_ENABLED=true
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
```

Se reutilizan la clave y URL configuradas de OpenRouter, sin enviar su clave a otro proveedor. `/embeddings` recibe lotes de texto y devuelve vectores float de 1536 dimensiones; se validan dimensiones, índices y valores. Cambiar de modelo obliga a reindexar; el modelo elegido debe aceptar 1536 dimensiones y entrada de texto. No mezclar vectores de diferentes modelos. El identificador por defecto admite español y otros idiomas.

El motor divide el contenido en fragmentos de hasta 700 caracteres con 120 de solapamiento. Guarda texto original, modelo y hash de categoría/título/contenido. En cada búsqueda descubre documentos pendientes o modificados y prepara hasta cuatro. Un proceso de mantenimiento prepara pendientes aunque no lleguen conversaciones. Desde **Conocimiento → Preparar todo ahora** se puede completar un agente, y la CLI permite preparar todos los perfiles con avance y reanudación. Consulta el [procedimiento del punto 3](knowledge-preparation.md). Los lotes de embeddings tienen un máximo de 32 entradas. La primera consulta y la preparación manual pueden tardar y generan consumo de IA.

Las consultas unen fragmentos, documentos y agentes, exigen el agente y su cuenta y excluyen documentos inactivos o con hash/modelo obsoleto. Se usa distancia coseno exacta dentro del agente: para este tamaño inicial se evita un índice aproximado que podría perder resultados al filtrar por perfil. Antes de incorporar HNSW/IVFFlat, medir volumen y latencia y verificar recall con filtros. Borrar documentos o agentes elimina sus fragmentos por clave foránea; editar durante la generación no permite guardar una versión anterior.

La selección respeta el presupuesto de contexto y conserva los documentos esenciales. Como en el selector previo, los esenciales pueden superar ese presupuesto si el administrador marca demasiados. Los documentos aún pendientes se consideran también mediante la selección por palabras. Los fragmentos seleccionados son fuentes del validador de hechos; la IA sigue sin poder inventar precios, enlaces ni fotos. El texto consultado se envía a OpenRouter para generar su embedding, igual que las preguntas se envían al proveedor de chat.

Si falta la extensión, el modelo falla o el proveedor no admite embeddings, se usa la selección anterior por palabras y se registra un aviso sin incluir claves. El estado se consulta con `GET /api/chatbots/:id/knowledge/index`; `POST` en esa ruta prepara documentos pendientes. Ambas rutas requieren administrador y autorización sobre el perfil del agente.

El consumo se registra como `embedding` en `ai_runs`, asociado al agente y su cuenta, y aparece en **Consumo de IA**. Se utiliza `usage.cost` del proveedor. Si no viene, se aplica el precio configurado en `ai_prices`; si tampoco existe ese precio, el importe queda en cero, por lo que debe configurarse antes de usar totales para facturar. Las respuestas y resúmenes conservan su registro independiente.

## Evaluaciones Promptfoo

Requiere Node.js **22.22 o posterior**. Promptfoo **0.124.0** está fijado como dependencia de desarrollo y se elimina de la imagen final del backend. No hay un servidor Promptfoo público ni acceso a contactos reales.

```bash
npm ci
npm run eval
```

`evals/provider.mjs` carga el **build real** de `buildContext`, `DECISION_JSON_SCHEMA` y `validateDecision`. Usa un agente, documentos y mensajes sintéticos. La evaluación local verifica tarifa real, detección de tarifa inventada, captura automática, rechazo de datos inventados, foto inexistente y ajuste sin emojis. El resultado de cada caso contiene el plan validado y los problemas detectados. La detección de un precio inventado no equivale a haber generado una respuesta buena: ese caso evalúa expresamente el rechazo del validador.

La evaluación local usa propuestas simuladas y prueba componentes; no mide la calidad del modelo, la persistencia ni la entrega de mensajes. Las pruebas `npm test` verifican el motor, almacenamiento y permisos con PostgreSQL y proveedores simulados. La suite de vectores exige pgvector real cuando `REQUIRE_PGVECTOR=true`; para instalaciones sin la extensión verifica la alternativa por palabras.

Para evaluar el modelo real de OpenRouter:

```bash
npm run eval:live
```

La clave se lee del entorno o `.env`; nunca se coloca en YAML. Usa el modelo global `OPENROUTER_MODEL` y datos sintéticos, genera gasto y no envía WhatsApps ni correos. `evals/live.yaml` evalúa precio real, captura de nombre e intento de imponer un precio falso. No se ejecuta automáticamente en CI y no puede considerarse verificada sin credenciales válidas. Para evaluar instrucciones propias se amplían las fixtures del proveedor; no exportar contactos o conversaciones reales a reportes.

La telemetría está desactivada y los resultados locales se guardan bajo `/tmp/riverrun-promptfoo`. Las evaluaciones fuerzan ejecución sin caché. La acción `Chatbot quality` ejecuta PostgreSQL con pgvector, toda la suite y las regresiones Promptfoo sin credenciales, y conserva reportes sintéticos de componentes y motor como artefactos. No ejecuta evaluaciones reales en pull requests.

Referencias: [pgvector](https://github.com/pgvector/pgvector), [proveedores personalizados de Promptfoo](https://www.promptfoo.dev/docs/providers/custom-api/), [SDK oficial de OpenRouter y contrato de embeddings](https://github.com/OpenRouterTeam/typescript-sdk). El endpoint y los campos se contrastaron con el paquete publicado `@openrouter/sdk@1.4.22`; no es una dependencia de la app.


## Punto 4: evaluación integral del motor

```bash
npm run eval:engine -- --output evals/results/engine.json
# Solo en un entorno autorizado con clave segura y acceso a openrouter.ai:
npm run eval:engine:live -- --output evals/results/engine-live.json
```

La CLI crea una **base PostgreSQL nueva y temporal**, aplica las migraciones reales y la elimina al finalizar, también cuando las evaluaciones fallan o se interrumpen con SIGINT/SIGTERM. Requiere un servidor local con pgvector y un rol con CREATEDB. Lee `EVAL_ADMIN_DATABASE_URL`, luego `TEST_DATABASE_URL`, o usa PostgreSQL local en el puerto 5433. Nunca migra la base indicada: utiliza la conexión administrativa para crear una base `riverrun_eval_<UUID>`. Rechaza hosts remotos. Una terminación forzada del proceso o del equipo puede dejar esa base sintética; elimínala manualmente después de comprobar su nombre. El proveedor rechaza su ejecución directa sobre una base existente.

`engine-provider.mjs` ejecuta `Engine.process`, `summarizeConversation`, los stores y las migraciones de la aplicación. Cada caso crea dos perfiles sintéticos con el mismo identificador externo de cliente. Todos los envíos se realizan mediante `PlaygroundTransport`; no arranca servidores, automatizaciones, notificaciones del equipo ni conexiones Evolution. Los registros y reportes contienen únicamente datos sintéticos. La suite evalúa:

- Instrucciones guardadas, estilo sin emojis y conocimiento de precios.
- Reintento y corrección antes de enviar una tarifa inventada; fotos inexistentes.
- Captura en contacto, conversación y mensaje original; acumulación entre turnos; rechazo de valores inventados.
- Resumen solicitado, persistencia, caché y recuperación de respuestas omitidas con referencia al mensaje; rechazo de capturas inventadas en el resumen; resumen automático al transferir o completar el objetivo.
- Agente apagado: entrada guardada sin respuesta.
- Separación de contactos y del contexto entre perfiles. El caso semántico indexa ambos perfiles en pgvector real y comprueba que el otro perfil no entra en el contexto ni en los datos capturados.

Son **14 casos deterministas** con propuestas simuladas. El caso vectorial usa embeddings sintéticos: verifica PostgreSQL y el aislamiento del motor, sin medir la calidad semántica de un modelo. Los permisos HTTP entre perfiles se verifican en `test/profile-permissions.test.ts` dentro de `npm test`; esta suite Promptfoo no sustituye esas pruebas.

La suite integral real contiene **7 casos**, llama al OpenRouter configurado para decisiones, resúmenes y embeddings, mantiene la misma base aislada y usa aserciones deterministas, sin otro modelo como juez. Limita la ejecución a 40 solicitudes y 2000 tokens de salida por completion; el punto 5 añade reservas, reporte de costo y detención ante errores o costos desconocidos; véase [calidad continua y consumo](quality-production.md). El límite monetario estricto requiere una clave dedicada con límite en OpenRouter. Consume crédito y puede fallar por diferencias de formato, contenido o comportamiento del modelo. No usa contactos reales y no modifica producción. No se ejecuta automáticamente en pull requests. `eval:live` sigue disponible para los tres casos del proveedor de componentes.

**Estado de validación:** las suites deterministas se ejecutan localmente y en CI. La suite de OpenRouter real requiere una clave válida y acceso al dominio; tener el comando preparado no acredita que haya pasado ni que esté activa en producción.

La automatización protegida de las evaluaciones reales y su habilitación semanal se documentan en el [punto 5](quality-production.md).
