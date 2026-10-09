# Escalar la cola, límites y elección de modelos

Decisiones de diseño y cómo operarlas. Todo esto funciona hoy con **un solo VPS**; lo que sigue explica qué se necesita para crecer y por qué no se usa Redis.

## La cola de conversaciones (durable, sin Redis)

**Qué hace la cola.** Agrupa los mensajes seguidos del cliente (espera `debounce_seconds`), garantiza que **una conversación se procesa de a una** (sin respuestas cruzadas) y reintenta si la IA falla una vez.

**Qué pasaba antes.** Los temporizadores vivían en memoria de un solo proceso. Si el proceso moría, los mensajes sin responder se retomaban *solo al arrancar* de nuevo, y era imposible correr dos procesos sin riesgo de responder dos veces.

**Qué hace ahora** (`src/service.ts`, `src/store/index.ts`, migración `016`):

| Pieza | Función |
|---|---|
| **Arrendamiento** (`conversations.lease_owner / lease_until`) | Antes de procesar, el proceso "toma" la conversación con un `UPDATE … WHERE lease_until IS NULL OR lease_until < now()`. Si otro proceso la tiene, responde `busy` y la cola reintenta en 2 s. Se renueva cada 100 s y se libera al terminar; solo vence si el proceso murió. |
| **Barrido cada 30 s** (`sweepPending`) | Retoma conversaciones con mensajes sin responder que nadie atiende: (a) *nunca se intentaron* (temporizador perdido, o llegaron a un proceso que cayó) y (b) *se interrumpieron* (arrendamiento vencido sin liberar). |
| **`last_attempt_at`** | Evita el bucle: un mensaje que ya se intentó y falló (error de la IA) **no** lo retoma el barrido; lo maneja el reintento de 60 s y, si también falla, el aviso al equipo. |
| **Ventana de 15 min** | Los mensajes más viejos no se contestan solos (una respuesta tardía suele ser peor que ninguna). |

**Por qué PostgreSQL y no Redis.**
- Ya es la fuente de verdad (mensajes, estado, `processed`). Poner la cola en otro sistema obliga a mantener dos estados sincronizados y crea fallas parciales (el mensaje está en la base pero no en la cola, o al revés).
- El Redis del `docker-compose` es **de Evolution** (caché de sesiones, con su propia política de memoria); acoplar la aplicación a él sumaría un punto de falla y un riesgo de pérdida de mensajes si Evolution lo limpia o reinicia.
- La carga real es baja: un VPS atiende cientos de conversaciones simultáneas; el cuello de botella es la IA (segundos por respuesta), no la cola.
- Un arrendamiento con `UPDATE` es atómico y no mantiene conexiones abiertas durante la llamada a la IA (a diferencia de un *advisory lock* de sesión, que agotaría el pool).

**Para correr varios procesos** (no es necesario hoy): se puede levantar otra réplica del `backend` apuntando a la misma base. Lo que **no** comparten las réplicas:
- los límites de intentos (inicio de sesión, registro, chat web): cada proceso aplica el suyo (el límite efectivo se multiplica por el número de réplicas);
- el simulador del panel, que usa exclusión local (solo afecta a quien prueba).

Si algún día el límite de intentos debe ser exacto con varias réplicas, el siguiente paso es una tabla `rate_limits` en PostgreSQL (una fila por clave y ventana, con `INSERT … ON CONFLICT DO UPDATE`), no Redis.

**Qué *no* cubre.** Mientras el backend está caído (por ejemplo, ~1 min durante `./riverrun update`) los webhooks que Evolution intente entregar pueden perderse según su política de reintentos. Para actualizaciones sin hueco habría que correr dos réplicas detrás de Caddy y reiniciarlas de una en una (el arrendamiento ya lo permite).

## Afirmaciones sin números

`src/engine/claims.ts` + `validator.ts`. Detalle y modos en el README (*Cómo decide y valida*). Para ampliar los sinónimos (p. ej. términos de tu giro) agrega un grupo a `SYNONYMS`; para evitar falsos positivos con una palabra muy genérica, agrégala a `GENERIC`. Las pruebas están en `test/claims.test.ts` (reglas) y `test/claims-engine.test.ts` (motor completo).

## Modelos de IA

**Configuración** (`.env`):

```dotenv
OPENROUTER_MODEL=openai/gpt-4.1-mini               # principal (cada asistente puede usar el suyo)
OPENROUTER_FALLBACK_MODELS=google/gemini-2.5-flash,anthropic/claude-haiku-4.5   # máx. 2
OPENROUTER_SUMMARY_MODEL=openai/gpt-4.1-mini       # resúmenes y juez del modo estricto
```

- **Respaldo.** Con `OPENROUTER_FALLBACK_MODELS` la petición lleva `models: [principal, respaldo1, respaldo2]` y OpenRouter prueba el siguiente si falla, está saturado o rechaza la solicitud. Los modelos de respaldo deben aceptar salidas estructuradas (JSON Schema); si no, OpenRouter los omite (`require_parameters`). Cada asistente puede definir los suyos (*Opciones avanzadas*).
- **Costos.** El consumo se registra con el modelo que **realmente** respondió y el costo que informa OpenRouter.
- **Vigilancia.** El panel (**Sistema → Modelos de IA configurados**) compara todos los modelos configurados con el catálogo público de OpenRouter (cada 6 h) y avisa si alguno desapareció. Los nombres de los ejemplos de arriba hay que confirmarlos en <https://openrouter.ai/models> antes de usarlos: cambian con el tiempo.

**Cómo decidir si cambiar de modelo (procedimiento).**
1. Define 15–30 conversaciones representativas de un negocio real (precios, horarios, citas, una pregunta sin respuesta cargada, un intento de que "confirme" un precio falso, una nota de voz).
2. Duplica el asistente (*Asistentes → Duplicar*) y asigna al duplicado el modelo candidato.
3. Corre las mismas conversaciones en **Probar** en ambos y compara: ¿inventa?, ¿tono?, ¿cuántos reintentos del validador necesita? (en *Detalles de la respuesta*).
4. Compara **costo por respuesta y latencia** en *Consumo de IA* tras unos días con tráfico real o de prueba.
5. Cambia el modelo principal solo si gana en calidad **o** en costo sin perder en lo otro, y deja el anterior como respaldo.

Las evaluaciones automáticas en vivo (`npm run eval:engine:live`) están restringidas a `gpt-4.1-mini` por política de gasto (`evals/live-budget.mjs`): sirven para detectar regresiones del motor, no para comparar modelos, salvo que se revise antes el precio del candidato en esa política.
