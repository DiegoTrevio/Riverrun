# Procesamiento durable y activación semántica por perfil

Cambios preparados para revisión, sin despliegue ni modificación de producción. Basados en `main` b82d8fa (PR 12–22 integrados); las oportunidades adicionales están en [optimization-opportunities.md](optimization-opportunities.md).

## Auditoría: evidencia y riesgos

| Hallazgo en main | Evidencia | Cambio |
|---|---|---|
| Debounce/reintentos se pierden al cerrar el proceso | Map y setTimeout en `engine/queue.ts`; stop cancela temporizadores | Tiempos, revisión, intentos y estados en `conversation_work` |
| Webhook confirmado antes de guardar | `reply.send` precedía `handleIncoming` en `routes/public.ts` | Recibo normalizado y deduplicado en PostgreSQL antes del 200 |
| Exclusión manual/simulador local; leases no cancelan al perder conexión | Cola local y renovación con catch ignorado | Bloqueo de sesión distribuido y comprobación de propiedad antes de efectos/envíos |
| Un timeout de envío se trataba como rechazo conocido | `sendOut` marcaba failed para cualquier excepción | Estados sent/rejected/uncertain/cancelled y revisión sin replay ciego |
| Envío parcial o cita interrumpida puede repetirse al retomar | Mensajes pendientes se conservaban sin un registro de operación | Registro por turno/parte; una operación con efectos externos y entradas pendientes exige revisión |
| Scheduler recupera running solo al iniciar; no impide recuperar un handler vivo largo | `recoverStaleJobs` al start, sin bloqueo compartido durante handlers | Un scheduler activo global, recuperación en cada pasada y drenado al cerrar |
| Buscar puede indexar documentos y pagar embeddings repetidos | `semanticKnowledge` llamaba `indexKnowledge`; consulta sin caché | Mantenimiento independiente, lotes, caché por cuenta/modelo/propósito y presupuesto diario |
| Activación depende de variables; no hay prueba previa por cuenta | `semanticEnabledFor` y botón de preparación de agente | Asistente para toda la cuenta: verificar, preparar, comparar, activar y volver a palabras |
| Selección sin umbral puede traer vecinos poco relacionados | Orden coseno LIMIT 40 sin distancia mínima | Umbral configurable y ranking híbrido, sin otro modelo de reranking |

Los riesgos se verificaron con pruebas de recuperación, concurrencia, duplicados, intervención humana, pérdida de sesión, caída del proveedor e interrupción de indexación. El impacto de tráfico real, relevancia con modelos reales y tiempos de canales reales requiere staging: no se presenta como medido aquí.

## Decisión: PostgreSQL existente frente a pg-boss

pg-boss ofrece una cola general con retries, mantenimiento y expiración. Para RiverRun seguirían haciendo falta exclusión por conversación compartida con simulador/manuales, debounce que cambia al llegar otro mensaje, control humano, pertenencia de cuenta y estados inciertos de entrega.

Se eligió una implementación pequeña sobre el pool, transacciones y migrador existentes: sin dependencias nuevas ni broker obligatorio. Reutiliza `jobs` para automatizaciones y añade tablas específicas para recepción/conversación/entrega. La contrapartida es que el mantenimiento de estos contratos y sus pruebas queda en RiverRun. Redis sigue siendo dependencia de Evolution en Compose, no se utiliza para la nueva cola.

## Arquitectura anterior y nueva

Antes: webhook → 200 → procesamiento en memoria → mensajes → temporizador local → lease de conversación → IA → envío → processed. Scheduler separado sobre jobs.

Ahora: webhook validado → transacción de recibos únicos → 200 → worker de recepción → transacción mensaje + conversación pendiente → debounce persistido → bloqueo de conversación y slot global → IA/validación → comprobación de cuenta, canal, agente, fuentes y control humano → mensaje + intento de entrega en transacción → API externa → comprobante → eventos asentados → entrada processed → trabajo done.

- Recepción única por canal, cliente, ID externo y dirección; eventos repetidos no repiten transcripciones, medios ni reglas. Recibos done borran su payload y su deduplicación se retiene 30 días.
- `revision` conserva los mensajes llegados durante una ejecución. Nuevos recibos aún no convertidos en messages también provocan restart, con el límite de reinicios existente.
- Locks de sesión cubren llamadas lentas; vencer una fecha no permite robar un trabajo que sigue con su lock. Al morir el proceso PostgreSQL libera locks; otro worker recupera el estado running vencido.
- Reintento exponencial configurable y estado dead. Llegar otro webhook no borra una revisión pendiente ni reinicia un contador fallido arbitrariamente.
- Los recibos de una respuesta humana tienen prioridad y no esperan un slot de IA. Una persona puede atender sin esperar a que termine una llamada al proveedor; los futuros envíos del agente se cancelan por versión de control.
- Los mensajes, fotos y archivos pasan por el mismo registro de entrega. Errores explícitos HTTP 4xx o bloqueo sandbox se reconocen como rechazo; timeout, caída de conexión y 5xx quedan inciertos.
- Una operación interrumpida tras un envío confirmado o una cita también se retiene para revisión: no se regeneran ni repiten efectos automáticamente. La interfaz permite reintentar errores sin entrega, o confirmar revisión/atención de los mensajes pendientes con permiso administrativo.
- Los eventos del motor se esperan antes de confirmar processed, manteniendo vivo su contexto de coordinación. Un cierre no anuncia que acabó un turno cuyos eventos aún están en curso.

## Migración y archivos

**046_durable_processing.sql**, aditiva: `inbound_receipts`, `conversation_work`, `worker_limits`, `delivery_attempts`, `semantic_settings`, `embedding_usage`, `knowledge_preparation_state`, `query_embedding_cache`; índices y triggers para control de conversación e invalidación de pruebas semánticas.

Backend: `engine/queue.ts`, `inbox.ts`, `coordination.ts`, `engine.ts`, `knowledge.ts`, `semantic-policy.ts`, `semantic-activation.ts`, mantenimiento/supervisión, scheduler/outbound, store, service, privacidad, monitor, server, configuración y rutas de agentes/canales/conversaciones/webhooks.

Panel: activación en Conocimiento, recuperación en conversación/conexiones; módulos existentes reutilizados. Documentación y snapshots intencionales del prompt. Pruebas nuevas en `architecture-recovery.test.ts`, `queue.test.ts`, fixture de proceso interrumpido y navegador `test-semantic-ux.mts`; se actualizan las expectativas antiguas de mensajes inciertos, backoff, snapshots y migración.

## Activación y aislamiento

Conocimiento → Búsqueda por significado, en la ficha del agente. La elección se aplica a toda su cuenta, no a cuentas ajenas.

1. Verificar base y proveedor/modelo con consulta sintética (consume reserva y registra uso).
2. Estimar trabajo y establecer presupuesto diario de **tokens reservados**. Estimación monetaria identificada como tal; desconocido no se presenta como costo cero.
3. Preparar una tanda limitada; mantenimiento continúa de forma incremental. Un lock global de indexación reduce carga; locks por agente/modelo y caché por cuenta evitan preparar simultáneamente lo mismo. Lotes exitosos se reutilizan tras interrupción.
4. Comparar fuentes de búsqueda híbrida y por palabras. Activar exige cobertura completa, modelo verificado y firma vigente del conjunto. Un cambio invalida la prueba y una carrera con la activación se rechaza.
5. Volver a palabras no borra documentos ni índices. Las cuentas existentes sin elección explícita conservan `KNOWLEDGE_SEARCH_ENABLED` y `KNOWLEDGE_SEARCH_ACCOUNT_IDS`; no se activa ninguna por migración.

`KNOWLEDGE_SEARCH_FORCE_OFF=true` suspende también elecciones explícitas: es el interruptor operativo de emergencia. `KNOWLEDGE_SEARCH_ENABLED` sigue siendo el valor heredado para perfiles sin elección. Las preferencias de cuenta permanecen al cambiar de entorno.

Fuentes vigentes por hash, documentos activos y pertenencia de cuenta se vuelven a comprobar tras recuperar. El motor comprueba otra vez fuentes/configuración antes de ejecutar. Referencias de origen acompañan el contexto y la comparación; los documentos se tratan como datos, no como instrucciones. Consultas guardan solo hashes y vectores, sin texto en caché ni logs de búsqueda.

## Recursos y límites

- Sin servicios nuevos. Pool por proceso: `max(10, QUEUE_CONCURRENCY*3+4)`; predeterminado 10. Los locks de workers y consultas de embeddings ocupan conexiones mientras esperan; el límite local y global y la indexación única evitan llenar el pool con indexadores competidores.
- Límite global inicial: 2 trabajos. Cada proceso respeta además su límite local. `worker_limits` inicializa una vez; no cambia silenciosamente porque otro proceso arranque.
- Revisiones de inbox/cola cada 500 ms por defecto: unas seis consultas de descubrimiento/s por proceso ocioso; despertadores opcionales locales reducen latencia, pero no determinan durabilidad.
- Una conversación almacena una fila de trabajo. Entregas y recibos añaden escrituras pequeñas por mensaje; los recibos completados se limpian y las entregas siguen el borrado de conversación.
- Vectores de pgvector de 1536 dimensiones rondan 6 KB más overhead. Caché JSON añade almacenamiento (dependiente de los valores); consultas expiran a 10 minutos, fragmentos a 30 días; retención purga expirados en tandas. Cambiar de modelo mantiene versiones separadas.
- Ningún embedding nuevo se solicita sin reserva de cuota de cuenta. Los fallos conservan la reserva por seguridad; el límite es de tokens conservadores, **no una garantía de dólares del proveedor**. Costo real se registra cuando se reporta. Generación conversacional mantiene la cuota/alertas existentes.
- RAM/CPU bajo tráfico real y calidad de ranking no se benchmarkearon en producción. Escalar procesos aumenta conexiones y memoria: medir p95, pool_waiting, backlog y tamaño de base antes de ampliar.

## Despliegue para revisión

1. Respaldo comprobado y staging con datos sintéticos, destinos permitidos y proveedor de pruebas. Conservar restauración y guardas existentes de main.
2. Drenar y detener **todos** los workers viejos. No mezclar versiones de cola local y durable: la versión anterior no conoce los locks ni recibos nuevos.
3. Ejecutar migración con la versión nueva; el migrador ya usa lock global y transacciones. No borra mensajes ni activa búsquedas.
4. Comenzar `PROCESS_ROLE=all`, 2 workers, en un VPS. Validar /health/ready, métricas, operaciones, DLQ y una conversación sintética con toma humana.
5. Si se separan procesos: HTTP con `PROCESS_ROLE=http`; uno o varios procesos del mismo release con `PROCESS_ROLE=worker`, misma base, proveedor, modelos y volumen compartido de archivos. El worker no escucha HTTP; monitorizar progreso durable, no asumir que DB sana significa worker sano.
6. Activar semántica en una cuenta piloto desde el panel, revisar costos/alternativas/latencia y respuestas con fuentes. Ampliar manualmente después.

Para cambiar capacidad global con workers drenados:

```sql
UPDATE worker_limits SET concurrency=2 WHERE id=true;
```

No aumentar sin ajustar el límite local y revisar el total de conexiones de todas las réplicas. Las variables y límites nuevos se comprueban antes de arrancar.

## Rollback

- Semántica: botón «Volver a búsqueda por palabras» por perfil, o `KNOWLEDGE_SEARCH_FORCE_OFF=true` para suspensión operativa global; datos e índices se conservan.
- Capacidad: bajar `worker_limits` y límites locales, dejando terminar operaciones vivas.
- Código/cola: detener recepción y workers, drenar o revisar recibos pendientes/dead, conversaciones con entregas inciertas y jobs running antes de volver a un binario anterior. No eliminar las tablas ni recrear messages. **Una versión antigua no procesa inbox ni entiende uncertain**: no arrancarla con esa cola sin resolver/exportar sus pendientes y poner las conversaciones afectadas bajo atención humana. Preferir corregir hacia adelante si hay entregas ambiguas.
- No ejecutar rollback/despliegue desde el panel ni automáticamente en producción. Este PR prepara los procedimientos para revisión.

## Límites que permanecen

Las APIs externas sin idempotencia no garantizan exactamente una entrega. Una petición ya despachada no puede retirarse al tomar control una persona; se impiden los siguientes envíos y se revisa lo incierto. Algunas plataformas realizan varios requests dentro de un envío lógico (división de texto, imagen y leyenda): pueden confirmar parcialmente. Notificaciones internas y eventos de integraciones mantienen sus contratos anteriores; el receptor de webhooks debe deduplicar `event_id`.

La recuperación de un turno con efectos externos se hace por revisión, no reconstruyendo automáticamente una respuesta parcial. No se certifica conexión QR, entrega a un teléfono real, credenciales reales ni calidad de un modelo real con las pruebas sintéticas. El umbral inicial necesita calibración en el piloto. No se añade RLS, almacenamiento operativo remoto, versiones de publicación ni SSE: son oportunidades posteriores documentadas.

## Validación

Resultados finales y comandos en `architecture-verification/results.md`. Evidencia de navegador en esta carpeta. Las 13 pruebas que requieren Evolution real se distinguen de las pruebas locales; no se presentan como ejecutadas.
