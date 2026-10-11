# Producción: manual operativo

Este manual describe lo que **existe hoy**. Lo marcado como **pendiente** no está implementado: no lo des por hecho.
Para observar la plataforma, ver [observabilidad.md](observabilidad.md). Para la activación de pgvector, ver [production-rollout.md](production-rollout.md).

## Quién puede hacer qué

- `./riverrun` (instalar, actualizar, restaurar, rotar secretos, reiniciar) se ejecuta **solo desde la consola del servidor**. El panel no tiene rutas para restaurar ni para desplegar: un superadmin no puede disparar una restauración desde el navegador.
- Restaurar exige escribir `RESTAURAR` a mano. Actualizar pide confirmación cuando hay riesgo.
- Monitores externos: `GET /health` y `GET /health/ready` son públicos y de solo lectura. `GET /health/functional` y `GET /metrics` requieren `HEALTH_TOKEN` y también son de solo lectura.

## Antes de publicar: `./riverrun preflight`

```bash
./riverrun preflight --offline   # sin red: máquina, configuración, Evolution fijada, dominio
./riverrun preflight             # en línea: además, servicios levantados y HTTPS del dominio
```

Salidas posibles:

| Estado final | Qué significa | Qué hacer |
|---|---|---|
| **BLOQUEADO** (código 1) | Hay un ✕: falta `.env`, poco disco o memoria, configuración crítica, `docker-compose.yml` inválido. | Corrige los ✕ y vuelve a correr la revisión. |
| **APROBADO CON ADVERTENCIAS** (código 0) | No hay bloqueos, pero hay un `!`: dominio sin configurar, `OUTBOUND_MODE=sandbox`, Evolution sin fijar por digest, poca memoria. | Decide si la advertencia aplica a este servidor. |
| **SIN BLOQUEOS EN LO REVISADO** (código 0) | Lo revisado está bien, pero quedan comprobaciones `?` **sin verificar**. No es una aprobación completa. | Verifica a mano las comprobaciones `?` antes de publicar. |
| **APROBADO** | Nada bloqueado, nada sin verificar. | — |

Lo que `preflight` **no** comprueba aunque diga "sin bloqueos": último respaldo y su copia en la nube, migraciones pendientes, certificado HTTPS en modo `--offline`. Aparecen como `?`. Revísalos con `./riverrun status`.

`preflight` no cambia nada: no arranca contenedores, no descarga imágenes y no escribe en la base.

## Entornos: producción y pruebas

**Producción** usa `OUTBOUND_MODE=live` (el valor por defecto). Los mensajes, correos y webhooks salen de verdad.

**Pruebas o staging** usan `OUTBOUND_MODE=sandbox` y `OUTBOUND_SANDBOX_ALLOW` con solo los destinos de prueba (teléfonos, correos o URLs, separados por comas):

```bash
OUTBOUND_MODE=sandbox
OUTBOUND_SANDBOX_ALLOW=5215512345678,qa@ejemplo.mx,https://hooks.ejemplo.mx/prueba
```

Qué bloquea el modo sandbox (lo verifican `test/outbound-guard.test.ts`):

- Mensajes de WhatsApp y de los demás canales, incluido el aviso interno al encargado.
- La prueba manual de WhatsApp desde el panel (responde 403).
- Correos (`sendMail`): se omiten y el registro no incluye destinatario ni asunto.
- Webhooks salientes hacia sistemas de clientes.
- Citas en Google Calendar (no se crean).
- Cobros (Stripe y Mercado Pago): con una clave o credencial de producción no se ofrece el pago y no sale ninguna petición al proveedor, ni para cobrar ni para leer facturación. Solo se aceptan claves de prueba (`sk_test_`, `rk_test_`, `TEST-`). Lo verifica `test/billing-guard.test.ts`.
- Webhook de alertas (`ALERT_WEBHOOK_URL`) y latido (`HEARTBEAT_URL`): solo salen si su URL está en `OUTBOUND_SANDBOX_ALLOW`. Si no, se omiten, y la incidencia sigue registrada en la base. Lo verifica `test/alert-guard.test.ts`.

Qué **no** bloquea, y por eso staging debe configurarse aparte:

- El simulador del panel: nunca sale de la plataforma.
- Llamadas a la IA (OpenRouter): cuestan dinero, pero no envían nada a un cliente.
- **Evolution:** staging no debe tener vinculado un WhatsApp de cliente.

La validación de configuración (`config-check`) hace críticos estos casos, y en modo estricto impiden arrancar:

- `OUTBOUND_MODE` con un valor distinto de `live` o `sandbox`.
- Producción con `OUTBOUND_MODE=sandbox`. Cuenta también cuando el entorno viene de la imagen (`NODE_ENV=production`). Por eso staging declara `RIVERRUN_ENV=test`: el overlay lo fija.
- En sandbox, una clave de producción de Stripe (`sk_live_`, `rk_live_`) o de Mercado Pago (`APP_USR-`).

Lo verifica `test/config-check.test.ts` (pruebas 7 a 9). El reporte nombra la variable, pero nunca muestra su valor.

**Overlay de staging: `docker-compose.staging.yml`.** Se usa junto con el compose principal, nunca solo:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.staging.yml docker compose up -d
```

Lo que fuerza, aunque el `.env` diga otra cosa: proyecto propio (`riverrun-staging`, volúmenes separados de producción), todo puerto publicado en `127.0.0.1` (incluido `PANEL_BIND=0.0.0.0`), caddy sin HTTPS público, `OUTBOUND_MODE=sandbox`, sin alertas externas ni latido, y sin copia de respaldos a la nube.

`scripts/test-staging-overlay.sh` comprueba esas garantías sobre la configuración que Compose renderiza, con un `.env` temporal de valores falsos. Verificado: las ocho comprobaciones pasan. Como control, el compose base sin overlay, con `PANEL_BIND=0.0.0.0` y `OUTBOUND_MODE=live`, publica el panel en `0.0.0.0` y envía en `live`: lo comprobé a mano, no con el script.

**Lo que el overlay no garantiza:** las claves. Staging usa las que pongas en su `.env`: claves de prueba y nunca una copia del `.env` de producción. Tampoco está probado todavía que el stack de staging arranque de punta a punta con Docker; eso queda en el paso de CI del plan.

## Actualizar

```bash
./riverrun update
```

Hace, en orden: revisar cambios locales, descargar, construir **sin arrancar**, revisar la configuración para la versión nueva, respaldar (obligatorio), levantar, verificar Evolution si cambió, y comprobar la salud funcional. Cualquier problema antes de levantar deja todo como estaba. Si la versión nueva no queda sana, vuelve sola (ver la siguiente sección). El detalle de Evolution está en [evolution-api.md](evolution-api.md).

**Ventana de observación.** Después de levantar la versión nueva, `./riverrun update` la observa durante `RIVERRUN_OBSERVE_SECONDS` (120 por defecto; `0` la apaga), midiendo la salud funcional cada `RIVERRUN_OBSERVE_POLL` segundos (15 por defecto). Un fallo aislado no revierte: hacen falta dos comprobaciones seguidas malas, como en las alertas. Una falla sostenida vuelve a la versión anterior, igual que una falla al levantar. La ventana añade ese tiempo a cada actualización; si necesitas actualizar más rápido, bájala con cuidado. Lo verifica `scripts/test-cli.sh` (un fallo aislado no revierte; una falla sostenida sí; un valor inválido se rechaza antes de descargar). **Limitación:** la ventana observa la salud funcional, no el tráfico real: un fallo que solo aparece con mensajes reales no se detecta aquí.

## Revertir no es restaurar

| | Revertir | Restaurar |
|---|---|---|
| Qué hace | Vuelve el código y la imagen del backend a la versión anterior. Evolution vuelve a su imagen anterior solo si su esquema no cambió. | Reemplaza la base de datos y los archivos por un respaldo. |
| Datos | No los toca. Las migraciones de RiverRun son aditivas, así que volver atrás es seguro. | Sobrescribe los datos con el respaldo: lo hecho después de esa fecha se pierde. |
| Quién lo dispara | `./riverrun update`, automático si la versión nueva no queda sana. | Una persona, escribiendo `RESTAURAR`. Requiere decisión explícita. |
| Cuándo | La versión nueva falla al levantar o en la comprobación posterior. | Corrupción, borrado accidental, servidor nuevo. |

Si una migración de Evolution ya se aplicó, la vuelta atrás no baja su imagen (no se puede deshacer su esquema sin perder datos). `./riverrun update` lo explica y deja Evolution fijada en la versión nueva.

## Respaldos

- Se hacen cada noche y con `./riverrun backup`. Se cifran con AES-256 (openssl, PBKDF2 con 200 000 iteraciones) cuando `BACKUP_PASSPHRASE` está definida.
- **La passphrase debe guardarse fuera del servidor.** Sin ella el respaldo no se puede abrir, aunque el archivo esté completo.
- Cada respaldo nuevo se verifica restaurándolo en una base temporal dentro del contenedor de respaldos. La base principal no se toca. `BACKUP_VERIFY_ALL=true` verifica todas las bases.
- Verificar uno a mano (sin tocar la base principal): `docker compose exec backup backup.sh verify [archivo]`. Sin archivo, verifica el último.
- Restaurar: `./riverrun restore latest`, o pasar la ruta de un archivo (por ejemplo, en un servidor nuevo). Pide escribir `RESTAURAR`.

**Prueba periódica de restauración en otro servidor: pendiente.** La verificación automática prueba que el archivo se puede restaurar en ese mismo servidor; no prueba que se pueda recuperar si el servidor se pierde.

## Qué hacer ante cada fallo

El sistema hoy detecta y avisa; no se recupera solo, salvo la reversión de una actualización. Los pasos son estos:

| Fallo | Qué se ve | Qué hacer |
|---|---|---|
| Backend no arranca o no responde | `/health` no responde; el preflight en línea bloquea. | `./riverrun logs backend`. Si fue una actualización reciente, `./riverrun update` ya habrá revertido; revisa el motivo antes de volver a intentarlo. |
| Configuración con problemas críticos | El arranque se detiene (con `CONFIG_VALIDATION=strict`). | Corrige el `.env`; `./riverrun status` muestra el problema y cómo corregirlo. |
| PostgreSQL caído | `database` en `no_disponible`; `/health/ready` responde 503. | `./riverrun logs postgres`. Si el volumen está dañado, restaurar. |
| Evolution caído | `whatsapp` en `no_disponible`; el resto de la plataforma sigue. | Revisa `./riverrun logs evolution`. **No recrees instancias** antes de revisar los respaldos: recrear una sesión vinculada la pierde. |
| Sesión de WhatsApp desconectada | `whatsapp_sessions` en `degradado`. | Vuelve a vincularla desde el panel. |
| IA sin clave o con errores | `ai` en `no_disponible` o `degradado`. | Revisa `OPENROUTER_API_KEY` y el saldo; el asistente no responde sin ella. |
| Disco casi lleno | `disk` en `no_disponible`; los respaldos y las subidas fallan. | Libera espacio o amplía el disco. Nada se borra solo. |
| Respaldo vencido o fallido | `backup` en `degradado` o `no_disponible`, según la edad. | `./riverrun backup` y luego `./riverrun status`. |
| Automatizaciones o mensajes atascados | `queue` en `degradado`. | Espera unos minutos; si no baja, `./riverrun restart`. |

**Fallos inyectados, dos niveles:**

- `test/fault-injection.test.ts` (ejecutado): monitoreo real con PostgreSQL real. Cubre Evolution caído, base de datos caída (los avisos salen aunque el historial no pueda escribirse), IA sin clave, IA con clave inválida y un fallo que dura un solo ciclo.
- `scripts/fault-inject.sh` (**no ejecutado todavía**): stack de staging real con Docker. Cubre Evolution caído, PostgreSQL caído y configuración crítica. Corre a mano o semanalmente en GitHub (`Fallos inyectados`). No se ha probado en este entorno porque la imagen del backend no se puede construir aquí.

En el monitoreo, probados con estado inyectado (no con un disco o un proceso realmente agotados): disco casi lleno, respaldo fallido y vencido, y memoria sobre el aviso. Quedan sin probar con un fallo real: un disco lleno de verdad, la memoria del sistema agotada, y la reversión de una actualización cuando la nueva versión arranca pero falla después. La reversión se prueba con el docker simulado de `test-cli.sh`, no con un fallo real.

## Límites de recursos para un VPS de ~2 GB

- **Medido: nada todavía.** Ninguna prueba de carga se ha ejecutado contra un servidor real, y los límites de abajo no están medidos.
- Configurado en producción: `RESOURCE_WARN_RSS_MB=1024` avisa si el proceso del backend crece por encima de 1 GB. El pool de PostgreSQL usa como máximo 10 conexiones. Producción **no** tiene límites de memoria por contenedor: añadirlos cambiaría su comportamiento en el próximo `update`, así que es una decisión aparte.
- En staging, el overlay fija límites de memoria para aproximar un VPS de ~2 GB: PostgreSQL 384 MB, Redis 128 MB, Evolution 512 MB, backend 512 MB y respaldos 256 MB. Son un punto de partida, no datos medidos.

**Prueba de carga (`scripts/load-test.mjs`)**: solo lectura. Pega a `/health`, `/health/ready`, `/health/functional` y `/metrics`. No escribe, no envía mensajes y no llama a proveedores. Se niega a correr salvo que se cumplan tres cosas: la URL es loopback, `LOAD_TEST_TARGET=staging` y hay `HEALTH_TOKEN`. Para un staging remoto, con un túnel:

```bash
ssh -L 3000:127.0.0.1:3000 servidor-staging
LOAD_TEST_TARGET=staging HEALTH_TOKEN=... node scripts/load-test.mjs --duration 60 --concurrency 10
```

Sale con código 1 si la tasa de errores supera 1% o el p95 supera `--max-p95-ms` (1000 por defecto). Limitación: mide la capa de salud y métricas, no el procesamiento de mensajes; probar ese camino exigiría escribir y gastar IA, y eso no entra en una prueba de solo lectura. Lo verifica `test/load-test.test.ts` (7 pruebas, con un servidor local). **No se ha corrido contra un staging real.**

## Pruebas que necesitan cuentas o teléfonos reales

Estas pruebas **no** se corren en CI ni en esta revisión. Requieren credenciales que no están en el repositorio. Se corren solo en staging, con cuentas y números de prueba:

- Vincular un WhatsApp real y enviar y recibir mensajes (`test/evolution-live.test.ts`, marcadas `[real]`, con una instancia de Evolution levantada).
- Cobros de prueba con Stripe o MercadoPago.
- Envío real de correo por SMTP.
- Crear una cita en un Google Calendar de prueba.

Ninguna de ellas se ha ejecutado como parte de la revisión de observabilidad y producción.

## Lo que todavía no existe

Lista para quien vaya a publicar. Mientras cualquiera esté pendiente, no declares la plataforma "lista para producción" sin decirlo:

- Overlay y guía de staging aislado, probados de extremo a extremo.
- Panel (Sistema) que muestre los cinco estados; hoy la API los entrega, el panel no.
- Fallos inyectados sobre el stack real, ejecutados en GitHub (`scripts/fault-inject.sh`): hoy no se han corrido. Y fallos todavía sin prueba con un fallo real: disco lleno de verdad, memoria del sistema agotada y reversión tras un fallo real.
- Resultados medidos de la prueba de carga contra staging y ajuste de los límites de memoria del overlay con esos datos.
- Límites de memoria en producción: decisión pendiente, no se aplican solos.
- Prueba periódica de restauración en un servidor distinto.
