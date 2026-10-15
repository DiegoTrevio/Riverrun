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

## Ningún cliente sin respuesta

Lo que pasa cuando el asistente no puede contestar:

- **Falla la IA** (tras los reintentos de la cola): el cliente recibe una vez el **mensaje de demora** del agente (Instrucciones → Reglas; vacío = no se envía) y el equipo un aviso en el panel y por WhatsApp. Los mensajes quedan pendientes.
- **Reintento automático**: si el cliente vuelve a escribir, la conversación sale de revisión y se le responde. Sin mensaje nuevo, una falla de la IA se reintenta cada 10 minutos, hasta 12 veces (unas 2 horas).
- **Envío incierto** (el envío pudo haber llegado o no): nunca se repite solo para no duplicar mensajes. El equipo recibe un recordatorio cada 30 minutos mientras el cliente siga esperando, durante 24 horas, hasta que alguien lo atienda o lo confirme desde la conversación.
- **Monitor**: un cliente con el asistente encendido que lleva más de 10 minutos sin respuesta pone la cola en **falla** (alerta al operador). Mientras eso pase, no se envía el latido (`HEARTBEAT_URL`), así que el servicio externo avisa aunque el servidor siga en pie. No cuentan las conversaciones que atiende una persona, los agentes apagados ni las cuentas en pausa.
- **Reinicios y actualizaciones**: al apagarse, el servidor deja de tomar conversaciones nuevas de inmediato, y docker compose espera hasta 5 minutos (`stop_grace_period`) a que terminen las respuestas en curso. Lo que llegue mientras tanto queda guardado y se atiende al arrancar.
- **Modelo de respaldo**: con OpenRouter, si el modelo principal falla, se usa `google/gemini-2.5-flash` (`OPENROUTER_FALLBACK_MODELS`; `none` lo desactiva).

## Que nada quede colgado ni desatendido

- **Vigilante del proceso** (`src/watchdog.ts`): si la cola, las recepciones o las tareas programadas dejan de avanzar 10 minutos (`WATCHDOG_STALL_MS`), el proceso registra el motivo y sale; si el bucle de eventos se bloquea 60 s (`WATCHDOG_BLOCK_MS`), un hilo aparte lo termina. Docker lo reinicia (`restart: unless-stopped`, con `init: true` para que la señal funcione) y todo lo pendiente está en PostgreSQL. `WATCHDOG=off` lo apaga.
- **Tareas programadas con límite**: una tarea que tarda más de 3 minutos (`JOB_TIMEOUT_MS`) se corta y se reintenta; si alcanzó a enviar algo, el reintento no lo duplica.
- **Conexiones a PostgreSQL**: esperar una conexión libre tiene un límite de 30 s (antes podía esperar para siempre).
- **WhatsApp vigilado** (`src/whatsapp-watch.ts`, cada 5 minutos): se lee el estado real de cada sesión vinculada aunque Evolution no avise; si se cae (dos revisiones seguidas), se avisa a los administradores, se intenta reconectar cada 15 minutos y, si sigue desconectado, se vuelve a avisar cada 6 horas durante 7 días.
- **Avisos urgentes también por correo**: cliente sin respuesta, emergencias, fallas de recepción y clientes que esperan a una persona llegan al panel, por WhatsApp y por correo (el WhatsApp de la cuenta puede ser justo lo que falla). Requiere `SMTP_URL`.
- **Cliente esperando a una persona**: si el último mensaje es del cliente y nadie del equipo responde en 30 minutos (regla del agente `handoff_reminder_minutes`; 0 lo apaga), el equipo recibe un recordatorio que se repite cada 2 horas durante 24 horas.
- **Instalación y revisión previa**: `./riverrun install` pide `SMTP_URL`, `HEARTBEAT_URL` y `ALERT_WEBHOOK_URL`; `./riverrun preflight` advierte si ninguna alerta sale del servidor o si falta el latido externo. El panel (Sistema) muestra el estado de los tres y un aviso si no hay ningún canal de alerta.

## Sesión de WhatsApp duradera y avisos de desconexión

**La sesión se conserva.** Lo que se vincula con el código QR queda guardado en PostgreSQL (`DATABASE_SAVE_DATA_INSTANCE`) y en el volumen `evolution_instances`, ambos incluidos en los respaldos. Un reinicio del servidor, de Evolution o una actualización no obligan a escanear de nuevo: Evolution reabre las sesiones al arrancar, y la vigilancia de WhatsApp (cada minuto) confirma el estado real y reconecta si hace falta.

**Por qué se cae** (`channels.disconnect_reason`, del código que manda Evolution):

| Motivo | Qué pasó | Qué se hace |
| --- | --- | --- |
| `connection_lost` | Se perdió la conexión (internet, reinicio de Evolution) | Se reconecta solo cada 15 min durante 24 h; se avisa si no vuelve en el tiempo definido |
| `logged_out` (401) | Se quitó el dispositivo vinculado en el teléfono, o el teléfono estuvo sin internet más de 14 días | Aviso inmediato: hay que escanear el QR otra vez. No se intenta reconectar (solo generaría QR nuevos) |
| `banned` (403) | WhatsApp bloqueó o restringió el número | Aviso inmediato |
| `replaced` (440) | La sesión se abrió en otro lugar (WhatsApp Web u otro servidor) | Aviso inmediato |

El panel muestra en el canal desde cuándo está desconectado y el motivo.

**Avisos según lo que defina cada negocio** (Ajustes → Horario y avisos → «Avisos si se desconecta un WhatsApp»):

- Activarlos o no (la reconexión automática sigue aunque estén apagados).
- **Esperar N minutos** antes de avisar (5 por defecto; 0 = de inmediato): evita avisos por cortes breves que se recuperan solos. Si hay que volver a escanear el QR, se avisa de inmediato.
- **Repetir cada N horas** mientras siga desconectado (6 por defecto; 0 = una sola vez), hasta 7 días.
- **A quién**: administradores (panel y correo), correos adicionales (hasta 10) y WhatsApp adicionales (hasta 5; se envían desde otro WhatsApp conectado de la cuenta, porque el desconectado no puede enviar).
- Avisar también cuando **vuelve a conectarse**.
- Botón **Enviar alerta de prueba** con lo guardado.

Cada aviso se reclama con una actualización atómica en PostgreSQL, así que con varios procesos sale una sola vez.

## Métricas (`/metrics`)

Formato de texto de Prometheus. Las etiquetas son solo valores fijos o validados.

| Métrica | Etiquetas | Significado |
|---|---|---|
| `riverrun_build_info` | `version` | Versión desplegada. |
| `riverrun_component_state` | `component`, `state` | 1 en el estado actual de cada componente, 0 en los demás. |
| `riverrun_check_value` | `component`, `metric` | Cifras de cada componente (`runs_15m`, `jobs_stuck`, `rss_mb`…). Una cifra desconocida **no se publica** (no hay 0 inventados). |
| `riverrun_incidents_open` | `severity` | Incidencias abiertas por severidad. |
| `riverrun_channels` | `type`, `connection` | Canales activos por tipo; en WhatsApp, `connection` es `open`, `close` o `sin_conectar`. |
| `riverrun_channels_silent_24h` | `type` | Canales activos sin mensajes entrantes en 24 horas. |
| `riverrun_channel_last_inbound_age_seconds` | `type` | Segundos desde el último mensaje entrante de cualquier canal de ese tipo (ventana de 7 días). Sin mensajes, no se publica. |
| `riverrun_ai_runs_15m` | `model` | Llamadas a la IA en 15 minutos, por modelo. |
| `riverrun_ai_tokens_15m` | `model`, `kind` (`input`/`output`) | Tokens en 15 minutos. |
| `riverrun_ai_cost_usd_15m` | `model` | Costo en USD en 15 minutos (lo que guarda cada llamada en `ai_runs`). |
| `riverrun_ai_latency_p95_ms_15m` | `model` | Latencia p95 en 15 minutos. |
| `riverrun_db_pool_connections` | `state` | `total`, `idle`, `waiting` del pool de PostgreSQL. |
| `riverrun_process_resident_memory_bytes` | — | Memoria residente del proceso. |
| `riverrun_process_uptime_seconds` | — | Tiempo desde el arranque. |

**Qué no sale nunca en métricas**: teléfonos, correos, nombres, IDs de cuenta o de canal, contenido de mensajes, prompts, respuestas de IA, claves ni el texto de las comprobaciones. Cualquier valor de etiqueta que no sea un identificador simple (letras, dígitos, `_`, `.`, `-`) se reemplaza por `otro`. Las pruebas `test/observability.test.ts` lo verifican con datos sensibles a propósito.

## Incidencias y alertas

- **Confirmación.** Un fallo avisa al segundo chequeo seguido (cada minuto), no al primero: así un parpadeo no despierta a nadie.
- **Una incidencia por componente.** La tabla `incidents` (migración 038) tiene un índice único parcial: si el mismo componente sigue fallando, se actualiza su detalle y "última vez visto"; no se duplica. Así una caída de cinco minutos es una incidencia, no cinco.
- **Severidad.** `critica` para base de datos, tareas y WhatsApp (afectan a todos los clientes); `alta` para el resto. Un `degradado` que dura dos chequeos seguidos abre una incidencia `baja`: queda en el historial, pero no avisa ni escala. Si el mismo componente pasa a fallo, su severidad sube.
- **Repetición.** Mientras siga fallando, se repite el aviso cada 6 horas. Al recuperarse, sale un aviso de recuperación y la incidencia se cierra con fecha.
- **Silencio.** `ALERT_MUTE=backup,disk` registra las incidencias de esos componentes, pero no envía correo ni webhook (ni de falla, ni de recuperación, ni de escalamiento). Con fecha vence sola: `ALERT_MUTE=backup=2026-10-12T18:00:00Z`, y después los avisos vuelven. Sin fecha no vence, y `./riverrun preflight` lo advierte. Una entrada que no se entiende no silencia nada.
- **Base caída.** Mientras PostgreSQL no responde, las incidencias no se pueden guardar: se anotan en `incidencias-pendientes.jsonl`, en la carpeta de respaldos, y se vuelcan en orden cuando la base vuelve. Los avisos salen igual. El diario guarda cambios de estado, no cada minuto, y tiene como máximo 500 entradas.
- **Dedupe tras reinicio.** El último aviso de cada incidencia queda en la base (migración 039). Tras un reinicio no se repite un aviso de hace menos de 6 horas, y la recuperación sí se anuncia.
- **Escalamiento.** Si una incidencia sigue abierta más de `ALERT_ESCALATE_MINUTES` (60 por defecto), se envía **una** vez un aviso marcado como `ESCALADO`. Está marcada en la base con un UPDATE atómico, así dos procesos no la envían dos veces.
- **Historial.** `GET /api/system/status` (superadmin) incluye `functional`. Las incidencias cerradas se borran después de 180 días; las abiertas nunca.

Canales: el correo a `SUPERADMIN_EMAIL` y el webhook `ALERT_WEBHOOK_URL` (Slack, ntfy, Discord, Telegram…). El latido `HEARTBEAT_URL` sigue igual.

## Variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `HEALTH_TOKEN` | generado por `install`/`update` | Acceso a `/health/functional` y `/metrics`. Vacío = 404. |
| `ALERT_MUTE` | vacío | Componentes sin avisos externos (la incidencia se registra igual). Con `=AAAA-MM-DDTHH:MM:SSZ`, el silencio vence solo. |
| `ALERT_ESCALATE_MINUTES` | `60` | Minutos abiertos antes del aviso de escalamiento. |
| `RESOURCE_WARN_RSS_MB` | `1024` | Memoria del proceso que dispara un aviso. `0` lo desactiva. |
| `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`, `SUPERADMIN_EMAIL` | vacío | Destinos de los avisos (ya existían). |

## Pruebas

- `test/observability.test.ts`: estados, mapeo de comprobaciones, la preparación sin WhatsApp (con Evolution caída de verdad en el arnés), métricas sin datos personales y con etiquetas maliciosas, 401/404 del token, incidencias: deduplicación, silencio, escalamiento único, recuperación y poda.
- `test/monitor.test.ts`: las comprobaciones existentes, con los nuevos nombres.
- `test/fault-injection.test.ts`: fallos inyectados sobre la lógica real de monitoreo, con PostgreSQL real. Sin fallos, cuatro ciclos sin avisos ni incidencias (falsos positivos). Un fallo de un solo ciclo no avisa. Evolution caído, base de datos caída, IA sin clave e IA con clave inválida avisan en el segundo ciclo, y se recuperan. Un respaldo fallido y vencido avisa y se cierra con un respaldo correcto. Un disco casi lleno y la memoria sobre el aviso se miden con estado inyectado. La prueba de clave inválida fue la que destapó que una IA sin ninguna respuesta correcta aparecía como "operativo". Un degradado sostenido se anota con severidad baja y no escala. Tras un reinicio no se repite un aviso reciente, y la recuperación sí sale. Con la base caída, el diario se vuelca al volver. `ALERT_MUTE` con fecha vence solo.
- `test/alert-mute.test.ts` y `test/incident-journal.test.ts`: el formato de `ALERT_MUTE`, y que el diario de la base caída no crezca mientras dura la caída. No necesitan base de datos.
- `scripts/fault-inject.sh` y `.github/workflows/fault-injection.yml`: fallos sobre el stack de staging real (Docker): Evolution caído, PostgreSQL caído y configuración crítica. Corre a mano o semanalmente, no en cada PR. Se ejecutó por primera vez en GitHub, sobre `main`, y pasó los cuatro escenarios (sin fallos, Evolution caído, PostgreSQL caído y configuración crítica). La imagen del backend no se construye en el entorno de desarrollo, así que su resultado vive en GitHub.
- `scripts/restore-drill.sh`: simulacro de restauración. Baja el último respaldo remoto (o recibe uno), lo abre con la clave y lo restaura en un PostgreSQL temporal con la misma imagen de producción. Ver [produccion.md](produccion.md#simulacro-de-restauración).
- `scripts/test-restore-drill.sh`: la prueba del simulacro sin S3, en CI. Comprueba clave correcta, clave equivocada y una lista de bases que no coincide.
- `scripts/test-cli.sh`: `./riverrun update` lee `/health/functional`, genera el token sin imprimirlo y, con un backend anterior que responde 404, cae a `/health/ready` y sigue revirtiendo ante una falla nueva.

## Lo que no está incluido todavía

Sin esto, no conviene afirmar "observabilidad completa":

- **Canales: sin latencia de respuesta por canal.** Hay conteos, conexión, canales callados y hace cuánto llegó el último mensaje, pero por tipo de canal. Una etiqueta por cada ID de canal chocaría con la regla de privacidad de las métricas.
- **Respuesta de IA: sin p95 por chatbot.** Hay p95, tokens y costo por modelo en 15 minutos. Por chatbot sería una etiqueta por cada uno.
- **`ALERT_MUTE` sin fecha no vence.** `./riverrun preflight` lo advierte; con fecha, vence solo.
- **Sin trazas de LLM ni tiempos por etapa** del motor.

## Herramientas externas: evaluación, no instaladas

Ninguna se instaló. Esta es la recomendación para un VPS de unos 2 GB, sin medir consumo en el servidor real:

- **Uptime Kuma** (o similar) contra `GET /health/ready`: lo más útil y barato. Avisa si el servidor entero deja de responder, algo que el propio backend no puede avisar. Recomendado primero.
- **Prometheus + Grafana** contra `/metrics` con `HEALTH_TOKEN`: útil cuando haya historial que mirar. Son dos procesos más que compiten por la memoria del mismo VPS; no se midió cuánta memoria ocupan aquí.
- **Langfuse**: trazas de cada llamada a modelos. Necesita su propia base de datos y contenedores; conviene solo cuando haya que depurar calidad de respuestas, y exige decidir antes qué contenido se envía fuera (los prompts contienen datos de clientes).
- **OpenTelemetry**: no hace falta hoy. Tendría sentido si el motor se reparte en varios procesos.

Verificar cualquiera de estas herramientas en un servidor real requiere el servidor y su configuración, así que queda como pendiente.
