# Observabilidad

Cómo saber si RiverRun funciona de verdad, qué avisa cuando no, y qué todavía no está cubierto.

## Tres niveles de salud

| Nivel | Endpoint | Qué prueba | Acceso | Falla con |
|---|---|---|---|---|
| Vivo (liveness) | `GET /health` | El proceso responde. No consulta nada. | Público | nunca, salvo que el proceso muera |
| Preparado (readiness) | `GET /health/ready` | Puede atender: base de datos y tareas programadas. | Público, sin detalles | **503** si falla la base de datos o las tareas |
| Funcional | `GET /health/functional` | Cada componente, con su estado y qué hacer. | `HEALTH_TOKEN` | — (informa; `status` dice el peor estado) |
| Métricas | `GET /metrics` | Formato Prometheus, para un scraper. | `HEALTH_TOKEN` | — |

Un WhatsApp caído **no** hace fallar `/health/ready`: así un balanceador no saca a la plataforma entera por un canal opcional. Ese fallo sí aparece en `/health/functional` y en las alertas.

`HEALTH_TOKEN` lo genera `./riverrun install` (y `./riverrun update` en instalaciones anteriores). Sin token, `/health/functional` y `/metrics` responden **404**: no existen, en vez de quedar abiertos por omisión.

```bash
curl -H "Authorization: Bearer $HEALTH_TOKEN" https://tu-dominio/health/functional
curl -H "Authorization: Bearer $HEALTH_TOKEN" https://tu-dominio/metrics
```

El token también se acepta en la cabecera `X-Health-Token`. Se compara en tiempo constante. `/health/functional` y `/metrics` reutilizan el resultado 15 segundos: un monitor que pregunte cada 10 s no dispara consultas ni llamadas a Evolution en cada petición.

## Estados

Cada componente tiene uno de cinco estados. Describen lo que se **comprobó**, no lo que se supone:

| Estado | Significa | Ejemplo |
|---|---|---|
| `operativo` | Se comprobó y funciona. | Evolution responde, acepta la llave y su versión está verificada. |
| `degradado` | Funciona, con errores o demoras. | 5 errores de IA en 15 minutos; un WhatsApp desconectado. |
| `no_disponible` | No funciona o no responde. | Base de datos caída; Evolution rechaza la llave. |
| `no_configurado` | La función no está activada aquí. **No es un fallo.** | No hay canales de WhatsApp; no hay carpeta de respaldos (modo desarrollo). |
| `no_verificado` | Debería funcionar, pero no hay forma de comprobarlo ahora. | Sin llamadas de IA en 15 minutos; el catálogo de modelos no responde. |

Reglas que evitan falsa seguridad:

- Que una variable esté definida no basta para `operativo`: la comprobación tiene que ejecutarse.
- Sin llamadas de IA en los últimos 15 minutos, el componente es `no_verificado`, no `operativo`.
- La salud general ignora `no_configurado` y `no_verificado`; sí cuenta `degradado` y `no_disponible`.
- Cada componente no operativo trae sus acciones (`actions`), con comandos reales de `./riverrun`.

### Forma de la respuesta de `/health/functional`

```json
{
  "status": "degradado",
  "version": "…",
  "checked_at": "2026-10-10T12:00:00.000Z",
  "components": [
    {
      "id": "ai",
      "state": "degradado",
      "label": "IA (OpenRouter)",
      "detail": "7 errores de IA en los últimos 15 minutos (de 40 llamadas)",
      "verified": true,
      "actions": ["Revisa OPENROUTER_API_KEY y el saldo de la cuenta de OpenRouter", "…"],
      "metrics": { "runs_15m": 40, "errors_15m": 7, "retries_15m": 3, "p95_latency_ms_15m": 2100 }
    }
  ]
}
```

`id` y `state` van siempre primero: `./riverrun` los lee así para decidir si una actualización empeoró algo.

## Componentes

| `id` | Qué mide | Cuándo es `degradado` / `no_disponible` |
|---|---|---|
| `database` | `SELECT 1` con tiempo límite de 4 s. | — / no responde |
| `whatsapp` | Evolution: responde, acepta la llave, no pide licencia, versión compatible. | No responde o rechaza la llave / versión incompatible o licencia |
| `whatsapp_sessions` | Canales WhatsApp conectados, instancias perdidas, webhooks, envíos fallidos en 15 min. | Desconexiones (con umbral) / instancias perdidas o caída tras una actualización |
| `scheduler` | Tareas pendientes atrasadas más de 5 min. | — / hay tareas atrasadas |
| `ai` | Llamadas, errores, reintentos y latencia p95 de los últimos 15 min (sin prompts ni respuestas). | ≥ 5 errores con respuestas correctas (degradado) / ≥ 3 errores y ninguna respuesta correcta, o falta `OPENROUTER_API_KEY` (no disponible) |
| `models` | Que los modelos configurados existen en OpenRouter. | Un modelo no existe (degradado) |
| `backup` | Último respaldo correcto, copia en la nube. | Vencido (`BACKUP_MAX_AGE_HOURS`) / sin respaldo nunca |
| `disk` | Espacio libre donde están las subidas. | Poco / casi sin espacio |
| `queue` | Trabajos "en curso" desde hace más de 15 min; mensajes entrantes sin procesar entre 5 y 60 min. | Trabajos atascados o mensajes sin procesar (degradado) |
| `resources` | Memoria del proceso, conexiones a PostgreSQL en espera, tamaño de la base. | Consultas esperando conexión, o memoria sobre `RESOURCE_WARN_RSS_MB` (degradado) |

Los umbrales de WhatsApp están en [evolution-api.md](evolution-api.md#monitoreo-preventivo). Los de IA (latencia p95 de 10 s, 5 errores) están en el código (`src/monitor.ts`); son razonables para empezar, no calibrados con datos de tu operación.

## Métricas (`/metrics`)

Formato de texto de Prometheus. Las etiquetas son solo valores fijos o validados.

| Métrica | Etiquetas | Significado |
|---|---|---|
| `riverrun_build_info` | `version` | Versión desplegada. |
| `riverrun_component_state` | `component`, `state` | 1 en el estado actual de cada componente, 0 en los demás. |
| `riverrun_check_value` | `component`, `metric` | Cifras de cada componente (`runs_15m`, `jobs_stuck`, `rss_mb`…). Una cifra desconocida **no se publica** (no hay 0 inventados). |
| `riverrun_incidents_open` | `severity` | Incidencias abiertas por severidad. |
| `riverrun_channels` | `type`, `connection` | Canales activos por tipo; en WhatsApp, `connection` es `open`, `close` o `sin_conectar`. |
| `riverrun_db_pool_connections` | `state` | `total`, `idle`, `waiting` del pool de PostgreSQL. |
| `riverrun_process_resident_memory_bytes` | — | Memoria residente del proceso. |
| `riverrun_process_uptime_seconds` | — | Tiempo desde el arranque. |

**Qué no sale nunca en métricas**: teléfonos, correos, nombres, IDs de cuenta o de canal, contenido de mensajes, prompts, respuestas de IA, claves ni el texto de las comprobaciones. Cualquier valor de etiqueta que no sea un identificador simple (letras, dígitos, `_`, `.`, `-`) se reemplaza por `otro`. Las pruebas `test/observability.test.ts` lo verifican con datos sensibles a propósito.

## Incidencias y alertas

- **Confirmación.** Un fallo avisa al segundo chequeo seguido (cada minuto), no al primero: así un parpadeo no despierta a nadie.
- **Una incidencia por componente.** La tabla `incidents` (migración 038) tiene un índice único parcial: si el mismo componente sigue fallando, se actualiza su detalle y "última vez visto"; no se duplica. Así una caída de cinco minutos es una incidencia, no cinco.
- **Severidad.** `critica` para base de datos, tareas y WhatsApp (afectan a todos los clientes); `alta` para el resto. Un aviso (`degradado`) se muestra, pero no abre incidencia.
- **Repetición.** Mientras siga fallando, se repite el aviso cada 6 horas. Al recuperarse, sale un aviso de recuperación y la incidencia se cierra con fecha.
- **Silencio.** `ALERT_MUTE=backup,disk` registra las incidencias de esos componentes, pero no envía correo ni webhook (ni de falla, ni de recuperación, ni de escalamiento). Es una decisión que se olvida: revísala y quítala cuando acabe el motivo.
- **Escalamiento.** Si una incidencia sigue abierta más de `ALERT_ESCALATE_MINUTES` (60 por defecto), se envía **una** vez un aviso marcado como `ESCALADO`. Está marcada en la base con un UPDATE atómico, así dos procesos no la envían dos veces.
- **Historial.** `GET /api/system/status` (superadmin) incluye `functional`. Las incidencias cerradas se borran después de 180 días; las abiertas nunca.

Canales: el correo a `SUPERADMIN_EMAIL` y el webhook `ALERT_WEBHOOK_URL` (Slack, ntfy, Discord, Telegram…). El latido `HEARTBEAT_URL` sigue igual.

## Variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `HEALTH_TOKEN` | generado por `install`/`update` | Acceso a `/health/functional` y `/metrics`. Vacío = 404. |
| `ALERT_MUTE` | vacío | Componentes sin avisos externos (la incidencia se registra igual). |
| `ALERT_ESCALATE_MINUTES` | `60` | Minutos abiertos antes del aviso de escalamiento. |
| `RESOURCE_WARN_RSS_MB` | `1024` | Memoria del proceso que dispara un aviso. `0` lo desactiva. |
| `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`, `SUPERADMIN_EMAIL` | vacío | Destinos de los avisos (ya existían). |

## Pruebas

- `test/observability.test.ts`: estados, mapeo de comprobaciones, la preparación sin WhatsApp (con Evolution caída de verdad en el arnés), métricas sin datos personales y con etiquetas maliciosas, 401/404 del token, incidencias: deduplicación, silencio, escalamiento único, recuperación y poda.
- `test/monitor.test.ts`: las comprobaciones existentes, con los nuevos nombres.
- `test/fault-injection.test.ts`: fallos inyectados sobre la lógica real de monitoreo, con PostgreSQL real. Sin fallos, cuatro ciclos sin avisos ni incidencias (falsos positivos). Un fallo de un solo ciclo no avisa. Evolution caído, base de datos caída, IA sin clave e IA con clave inválida avisan en el segundo ciclo, y se recuperan. Un respaldo fallido y vencido avisa y se cierra con un respaldo correcto. Un disco casi lleno y la memoria sobre el aviso se miden con estado inyectado. La prueba de clave inválida fue la que destapó que una IA sin ninguna respuesta correcta aparecía como "operativo".
- `scripts/fault-inject.sh` y `.github/workflows/fault-injection.yml`: fallos sobre el stack de staging real (Docker): Evolution caído, PostgreSQL caído y configuración crítica. Corre a mano o semanalmente, no en cada PR. Se ejecutó por primera vez en GitHub, sobre `main`, y pasó los cuatro escenarios (sin fallos, Evolution caído, PostgreSQL caído y configuración crítica). La imagen del backend no se construye en el entorno de desarrollo, así que su resultado vive en GitHub.
- `scripts/test-cli.sh`: `./riverrun update` lee `/health/functional`, genera el token sin imprimirlo y, con un backend anterior que responde 404, cae a `/health/ready` y sigue revirtiendo ante una falla nueva.

## Lo que no está incluido todavía

Sin esto, no conviene afirmar "observabilidad completa":

- **El panel (Sistema) no muestra todavía los cinco estados.** La API sí los entrega (`functional`); el panel conserva la vista anterior de comprobaciones.
- **Canales: solo WhatsApp tiene estado por sesión.** Para los demás tipos hay conteos y conexión, pero no "último mensaje recibido" ni latencia de respuesta por canal.
- **Respuesta de IA: sin p95 por cuenta ni por chatbot**, solo global de 15 minutos.
- **Dedupe tras reinicio.** El contador de "ya avisé" vive en memoria. Tras un reinicio, un fallo que sigue puede avisar una vez más. La incidencia no se duplica (está en la base).
- **Los `degradado` no abren incidencia**, así que no escalan ni quedan en el historial.
- **`ALERT_MUTE` no expira solo.**
- **Sin trazas de LLM ni tiempos por etapa** del motor.

## Herramientas externas: evaluación, no instaladas

Ninguna se instaló. Esta es la recomendación para un VPS de unos 2 GB, sin medir consumo en el servidor real:

- **Uptime Kuma** (o similar) contra `GET /health/ready`: lo más útil y barato. Avisa si el servidor entero deja de responder, algo que el propio backend no puede avisar. Recomendado primero.
- **Prometheus + Grafana** contra `/metrics` con `HEALTH_TOKEN`: útil cuando haya historial que mirar. Son dos procesos más que compiten por la memoria del mismo VPS; no se midió cuánta memoria ocupan aquí.
- **Langfuse**: trazas de cada llamada a modelos. Necesita su propia base de datos y contenedores; conviene solo cuando haya que depurar calidad de respuestas, y exige decidir antes qué contenido se envía fuera (los prompts contienen datos de clientes).
- **OpenTelemetry**: no hace falta hoy. Tendría sentido si el motor se reparte en varios procesos.

Verificar cualquiera de estas herramientas en un servidor real requiere el servidor y su configuración, así que queda como pendiente.
