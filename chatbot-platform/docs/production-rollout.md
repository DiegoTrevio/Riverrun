# Punto 6: despliegue gradual, observación y recuperación

Este procedimiento prepara una activación verificable de pgvector y calidad continua. El PR no ejecuta despliegues, cambia claves/volúmenes ni conecta teléfonos de producción. Hace falta acceso al servidor y completar las comprobaciones reales de los puntos 1–5.

## Antes de activar

- Integrar únicamente una revisión que haya pasado `Chatbot quality`; ejecutar y aprobar los siete casos OpenRouter del [punto 5](quality-production.md).
- Registrar commit e imágenes/digests actuales, PostgreSQL, collation y configuración anterior. No guardar valores de claves en reportes. Mantener una revisión anterior compatible del backend para recuperación.
- Completar [respaldos y restauración](production-review.md) de ambas bases, uploads y sesiones Evolution. Validar una restauración aislada y definir una ventana operativa para el cambio del backend. No usar las suites `npm test` o Promptfoo contra una base de producción.
- Elegir un perfil piloto activo y su UUID real. Preparar mensajes y contacto de prueba controlados, separados de clientes reales. Confirmar que el equipo puede atender las conversaciones si hay fallos.

## Piloto por perfil

En las variables privadas del servidor:

```dotenv
KNOWLEDGE_SEARCH_ENABLED=true
KNOWLEDGE_SEARCH_ACCOUNT_IDS=<UUID_DEL_PERFIL_PILOTO>
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
```

`KNOWLEDGE_SEARCH_ACCOUNT_IDS` acepta UUID separados por comas; se normalizan y eliminan duplicados. Una lista mal formada impide el arranque en lugar de ampliar el alcance. **Vacía significa todos los perfiles** cuando `KNOWLEDGE_SEARCH_ENABLED=true`; `false` desactiva todo el componente semántico. Estos valores son configuración del operador, no permisos de acceso de los usuarios.

La restricción se aplica a búsqueda, indexado solicitado, preparación CLI y mantenimiento automático. Fuera del piloto el motor usa la búsqueda por palabras y no solicita embeddings. Los datos y permisos de cada perfil se conservan. La preparación global con `--all --apply` se rechaza si incluye perfiles fuera del piloto; prepararlos individualmente evita activar o gastar sobre perfiles no elegidos.

Actualizar el backend desde la revisión probada, conservando bases, volúmenes y Evolution. En la instalación Compose del proyecto, una vez preparados los requisitos y la ventana:

```bash
docker compose up -d --build --no-deps backend
docker compose exec backend node dist/cli/knowledge-activate.js --verify-provider
docker compose exec backend node dist/cli/knowledge-prepare.js --account <UUID_DEL_PERFIL_PILOTO> --apply
docker compose exec backend node dist/cli/operations-check.js --window-minutes 60
```

El comando de activación de este ejemplo no aplica migraciones por sí mismo; el arranque del backend las aplica tras validar collation. No sustituye la preparación de PostgreSQL y la extensión del [punto 2](semantic-activation.md). Los comandos de activación/preparación sí pueden consumir embeddings; el diagnóstico operativo no llama a IA. Promptfoo permanece fuera de la imagen final y se ejecuta en CI o en una máquina de evaluación aislada.

Desde el perfil piloto comprobar tarifa conocida, pregunta clave, captura en contacto/conversación, resumen solicitado/final y transferencia. Comprobar también un perfil fuera del piloto y que no puede consultar datos de otro perfil. No hacer pruebas automáticas enviando mensajes a teléfonos de clientes. Observar al menos 24 horas de tráfico representativo antes de ampliar; un perfil sin solicitudes no acredita calidad ni latencia.

## Diagnóstico y observación

```bash
npm run operations:check -- --window-minutes 60
```

La CLI solo consulta PostgreSQL y emite JSON sin mensajes de clientes ni claves. No migra, indexa, reinicia, envía avisos o verifica OpenRouter. Devuelve código distinto de cero si el diagnóstico no se completa, el esquema no está listo o, con búsqueda activada, falta clave, hay un perfil piloto inexistente o quedan documentos pendientes. Un código cero **no certifica el proveedor**: `provider` permanece `not_checked`.

El maestro puede consultar `GET /api/health/operations` con su sesión autenticada. Los administradores limitados no tienen acceso a este informe global; `/health` mantiene únicamente la señal de proceso vivo. El snapshot contiene:

| Campo | Interpretación |
| --- | --- |
| `database_ready`, `issues` | Esquema/vector/collation y configuración; no estado de autenticación del modelo |
| `rollout` | Activación global o piloto, UUID configurados y perfiles inexistentes |
| `knowledge` | Agentes totales, agentes habilitados y documentos pendientes del alcance activo |
| `search` | Intentos observados, selección semántica, degradaciones, proporción de degradación y p95 de duración |
| `usage` | Ejecuciones IA, USD registrados y ejecuciones con costo cero en la ventana |
| `delivery` | Mensajes salientes fallidos en la ventana |

Las métricas de búsqueda nacen de eventos `knowledge_search` con resultado, motivo, duración y modelo, asociados al perfil/agente. No incluyen preguntas, respuestas ni cuerpos de errores del proveedor. No cuentan los perfiles fuera del piloto ni casos atendidos solo con documentos esenciales. La duración incluye preparación y consulta de embeddings. Una selección sin fragmentos por presupuesto de contexto se registra como degradación. Si no hay intentos, la proporción queda `null`, no cero. La retención de logs limita el historial disponible.

El informe global de consumo/entrega incluye **todos** los perfiles; para comparar un piloto use además los listados autorizados de registros y Consumo de IA filtrados por su cuenta. Un costo cero puede ser válido o indicar precios/reportes faltantes: no equivale a que la llamada fuera gratuita. El snapshot no identifica importes que el proveedor no haya reportado o la tabla de precios no haya podido estimar.

Durante el piloto registrar snapshots y revisar inicialmente cada cinco minutos. Propuestas iniciales para revisión operativa: degradaciones >5% con al menos 20 intentos en una hora, p95 >10 s con muestras suficientes, pendientes que no bajan durante 15 minutos, o cualquier fallo de entrega persistente. Comparar con la línea base y el SLA real antes de automatizar umbrales. La CLI no genera alertas externas ni detiene el backend por estos umbrales. Configurar el monitor del alojamiento y las notificaciones de GitHub Actions explícitamente; no hay alertas de correo/Slack habilitadas desde este PR.

## Ampliar y recuperar

Añadir UUID de otros perfiles por etapas, reiniciar el backend para leer la configuración y preparar cada perfil nuevo. Repetir las comprobaciones y observar cada etapa. Solo después de validar cobertura/calidad/consumo, dejar la lista vacía para activar todos y completar `knowledge:prepare --all --apply`. Registrar operador, revisión, hora, alcance y resultados sin conversaciones ni claves.

Si la búsqueda semántica produce degradaciones o latencia inaceptable:

1. Establecer `KNOWLEDGE_SEARCH_ENABLED=false` y recrear únicamente el backend para leer la variable. Si la lista piloto estaba mal formada, vaciarla también; `false` mantiene todo desactivado. La búsqueda por palabras continúa atendiendo. Una petición iniciada antes del cambio puede haber consumido crédito.
2. Revisar el diagnóstico y confirmar con un mensaje sintético que no se solicitan embeddings. Conservar `knowledge_items`, `knowledge_chunks`, contactos, conversaciones, mensajes, volúmenes y sesiones QR. Desactivar no borra ni restaura datos.
3. Diagnosticar proveedor, saldo, red, modelo, esquema o cambios de contenido; volver al piloto cuando se haya corregido y comprobado.

Si falla la revisión del backend, restaurar la **imagen/revisión anterior compatible** y su configuración guardada. No degradar PostgreSQL ni quitar la extensión/tablas para recuperar el backend. Comprobar compatibilidad de migraciones antes de usar código anterior. Una restauración de respaldo es una recuperación distinta, con ventana autorizada y posible pérdida de escrituras posteriores; no ejecutarla automáticamente ni sobre un volumen sin respaldo recuperable. Nunca usar `docker compose down -v` en recuperación.

## Evidencia

Se prueban con PostgreSQL/pgvector local: exclusión del piloto en consultas/indexado/worker/API, rechazo de preparación global fuera del alcance, métricas de selección/degradación sin textos ni secretos, permisos del diagnóstico, desactivación sin pérdida de conocimiento/índices, ampliación sin reindexar documentos completos y rechazo de UUID inválidos/inexistentes. Los embeddings son sintéticos; esta evidencia no demuestra activación, calidad o recuperación del servidor de producción.
