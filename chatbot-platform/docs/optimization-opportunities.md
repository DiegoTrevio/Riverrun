# Oportunidades de mejora de RiverRun

Revisión de `origin/main` en **b82d8fa**, posterior a los PR 12–22. Las recomendaciones se basan en rutas, servicios, migraciones, componentes y workflows reales. No constituyen una certificación de producción. La rama de colas persistentes añade las mejoras señaladas como «en este PR»; las demás son propuestas.


Los dos primeros puntos de producto —versionado de agentes y pruebas propias por negocio— se implementan en la continuación descrita en [Versiones y pruebas](agent-versions-and-tests.md): borrador en servidor, publicación/reversión, historial y evaluaciones del motor exportables a Promptfoo. El alcance y los criterios de aceptación están detallados allí.


La ficha unificada de contactos y los presupuestos de IA por perfil se implementan en [Ficha y presupuestos](contact-workspace-and-ai-budgets.md), con permisos antes de agrupar, vistas personales y reservas monetarias transaccionales.

## Lo que ya existe y se debe reutilizar

- Agentes y conexiones reunidos, creación guiada y menú sencillo: `public/js/agent-connections.js`, `agentwizard.js`, `shell.js`, `src/templates/agent-builder.ts`.
- Preguntas con caminos por respuesta, fotos por contexto/reglas, avisos al equipo, solicitudes repetidas y resumen/datos de contacto: motor, automatizador y migraciones 040–042.
- pgvector con preparación incremental, invalidación por hash, aislamiento de cuenta y supervisión; Promptfoo con regresiones sintéticas, ejecución del motor y workflow de evaluaciones reales con presupuesto.
- Salud de proceso, readiness, salud funcional, métricas Prometheus, diagnóstico de configuración, incidencias, staging y pruebas de fallos: `app.ts`, `monitor.ts`, `diagnostics.ts`, `observability/incidents.ts` y workflows existentes.
- Integraciones por API y webhooks firmados, Google Calendar, Google Login, Stripe y Mercado Pago. No se necesita rehacer estas funciones para conectar herramientas externas.
- Respaldos cifrados con almacenamiento compatible con S3, comprobación y simulacro de restauración. Los archivos de imágenes/documentos de la aplicación siguen siendo locales: respaldo remoto y almacenamiento operativo son funciones diferentes.

## Prioridades concretas

P0 = confiabilidad antes de ampliar tráfico; P1 = siguiente mejora de producto; P2 = cuando lo justifique el uso. Complejidad relativa, no estimación contractual.

| Prioridad | Oportunidad y evidencia | Integración/cambio recomendado | Beneficio y aceptación | Complejidad | Estado |
|---|---|---|---|---|---|
| P0 | `queue.ts` en main mantiene tiempos y reintentos en un Map; `public.ts` confirma el webhook antes de persistir | Cola e inbox PostgreSQL, bloqueos distribuidos, DLQ y registro de entregas inciertas | Reinicio y dos procesos no pierden el trabajo; un timeout no provoca reenvío ciego | Alta | En este PR |
| P0 | El scheduler reclama filas, pero recupera trabajos running solo al iniciar y puede volver a reclamar un trabajo largo | Exclusión distribuida de scheduler, recuperación periódica, cierre con drenado | Dos instancias no ejecutan el mismo scheduler; se conserva la tarea al perder PostgreSQL | Media | En este PR |
| P0 | La configuración semántica de main depende de entorno y la búsqueda llama al indexador | Activación por perfil desde panel; preparación fuera del turno; presupuesto y caché aislados | Preparar no cambia respuestas; activar exige comprobación, cobertura y prueba; apagar vuelve a palabras | Alta | En este PR |
| P0 | `auth.ts` conserva el rate limit en un Map local; más procesos multiplican el cupo permitido | Límite compartido en el proxy o PostgreSQL con expiración; mantener los límites por cuenta de la app | La misma IP/clave no obtiene más intentos al cambiar de instancia; recuperación automática al vencer | Media | Propuesta |
| P1 | Los borradores están en localStorage y los PUT cambian el agente vigente; `chatbots/draft` crea un borrador inicial, no un historial de publicaciones | Versiones de agente: borrador en servidor → probar → publicar, con autor, diferencias y reversión | Recuperar la versión previa en una acción; editar en otro dispositivo; ninguna edición incompleta llega a producción | Media/alta | Implementada; ver documentación de versiones y pruebas |
| P1 | Promptfoo evalúa casos comunes del producto, pero no hay batería de aprobación propia de cada agente | Convertir ejemplos sintéticos de cada negocio en pruebas del simulador reutilizando el motor y Promptfoo | Antes de publicar validar precios, preguntas, imágenes, citas y transferencias; guardar resultado ligado a versión y modelo | Media | Implementada; ver documentación de versiones y pruebas |
| P1 | `conversations.js` consulta cada 5 s y la bandeja cada 10 s | SSE para mensajes/estado, con cursor, reconexión y alternativa actual por polling | Mensaje visible <1 s en conexión estable; reconectar no duplica; solo se reciben conversaciones autorizadas | Media | Propuesta |
| P1 | Ya existen contactos, datos, tareas, etiquetas, solicitudes y reparto; están repartidos entre conversación y paneles | Ficha de contacto unificada, filtros guardados y vistas «pendientes», «sin asignar», «citas próximas» | Encontrar y retomar un caso en ≤2 acciones; conservar permisos por asignación y perfil | Media | Implementada; ver ficha y presupuestos |
| P1 | Hay métricas e incidencias, pero un mensaje atraviesa recepción, IA, validación, scheduler y canal sin una traza completa única | IDs de correlación y tramos de latencia; exportación OpenTelemetry opcional a un collector compatible | Identificar dónde se demoró/falló una respuesta sin guardar texto ni teléfonos en trazas | Media | Propuesta; ampliar observabilidad existente |
| P1 | `aiAlertUsdPerAccount` avisa sobre gasto; el proveedor y los modelos son configuración operativa y del agente | Límites de gasto de IA por perfil, modelo y periodo; reserva antes de llamar, aviso y comportamiento de respaldo | Consumo simultáneo no rebasa reservas; mostrar costo real frente a estimado; desconocido nunca se presenta como gratis | Media/alta | Implementada; ver ficha y presupuestos |
| P1 | No hay MFA en autenticación; usuarios admin pueden cambiar canales, usuarios e integraciones | Segundo factor TOTP o passkeys y gestión de sesiones; historial de cambios con antes/después y autor | Operaciones administrativas auditables y recuperación del segundo factor probada | Media | Propuesta |
| P2 | No hay adaptador de WhatsApp Cloud API; WhatsApp usa Evolution/QR | Adaptador oficial alternativo dentro de ChannelAdapter, conservando Evolution | Elegir QR u oficial; probar firmas, medios, ventana de 24 h, plantillas y estado de entrega | Alta | Propuesta, con costo/alta de Meta |
| P2 | API y webhooks ya permiten automatización externa | Plantillas listas para n8n/Make y CRM: contacto capturado → sincronizar; cita → seguimiento; fallo → aviso | Configurar una integración con prueba y ejemplo de payload; usar event_id para deduplicar y claves con alcance mínimo | Baja/media | Propuesta; no requiere alojar n8n en el VPS |
| P2 | `attachments.ts` y medios usan rutas locales; replicar servidores exige compartir esas rutas | Interfaz de almacenamiento operativo y adaptador S3/R2 opcional, enlaces firmados y política de retención | Dos servidores sirven la misma foto/documento; acceso ajeno denegado; borrado de contacto elimina datos derivados | Alta | Propuesta, necesaria antes de varios servidores sin volumen compartido |
| P2 | Hay checks de propiedad/FK y permisos de aplicación, sin políticas RLS en las migraciones | RLS como defensa adicional, con contexto transaccional de cuenta y rol de worker restringido | Consultas sin contexto no leen otras cuentas; pool no conserva identidad del cliente anterior | Alta | Propuesta; requiere diseñar acceso master y migraciones |
| P2 | El asistente guiado ya arma una configuración determinista y gratuita | Revisión final de preparación del agente: instrucciones, información, canal, prueba y pendientes con enlaces directos | Un usuario nuevo completa un agente sin leer registros técnicos; cada problema lleva a la acción que lo resuelve | Baja/media | Propuesta; reutilizar wizard actual |

## Orden recomendado

1. Terminar y validar colas/entregas/activación semántica. No introducir nuevos servicios obligatorios.
2. Versionar el agente y vincular cada publicación con pruebas de su negocio. Añadir el control compartido de intentos al preparar múltiples instancias.
3. Mejorar trabajo cotidiano con ficha de contacto y eventos SSE; medir primero el tiempo real para crear y atender casos.
4. Abrir integraciones externas con recetas n8n/Make; añadir WhatsApp oficial y almacenamiento operativo remoto solo cuando exista necesidad concreta.

## Métricas de producto y operación

- Crear un agente y conectar un canal: tiempo mediano y p90, finalización, campos corregidos, abandonos por etapa. Comparar con una línea base medida con usuarios nuevos.
- Atender una conversación: tiempo hasta encontrar contacto, transferir o confirmar una cita; número de acciones; errores al guardar.
- Entregas: recibidos persistidos, pendientes vencidos, DLQ por motivo, inciertos y tiempo de atención de una incidencia. Meta: cero pérdida confirmada y cero replay automático de entregas inciertas.
- IA: p50/p95 de recepción a respuesta, tiempo separado de cola/proveedor/envío, costo por conversación y por objetivo completado.
- Conocimiento: cobertura de índice vigente, fallos por documento, proporción de alternativa por palabras, latencia de búsqueda y presupuesto reservado frente a tokens/costos reportados.
- Calidad: porcentaje de casos por agente aprobados, afirmaciones sin fuente, saltos de preguntas, citas/fotos/transferencias correctas. Las pruebas sintéticas no reemplazan evaluaciones reales con proveedor y usuarios.

## Qué evitar por ahora

No migraría toda la interfaz a otro framework, no añadiría Redis como requisito para la cola ni un constructor visual de automatizaciones más complejo sin observar primero dónde se atascan los usuarios. No pondría una nueva suite de monitoring paralela a las métricas e incidencias existentes. No habilitaría búsqueda semántica, integraciones de pago o canales reales silenciosamente.

## Límites de esta revisión

Inspección de código de main y de la rama de trabajo; no acceso a producción, usuarios reales ni métricas de tráfico. La necesidad de S3 operativo, RLS, SSE y trazas es una recomendación arquitectónica, no un fallo de producción reproducido. El estado de pruebas y del PR de arquitectura se documenta por separado en `durable-processing.md`.
