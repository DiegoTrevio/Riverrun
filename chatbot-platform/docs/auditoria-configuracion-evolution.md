# Auditoría: validación de la configuración y estabilidad de Evolution API (octubre 2026)

Alcance: problemas C (configuraciones críticas sin validación bloqueante) y D (versionado y actualizaciones de
Evolution API). Detalle de uso en [configuracion.md](configuracion.md) y [evolution-api.md](evolution-api.md).

## Método

1. Lectura del código: `config.ts`, `index.ts`, `monitor.ts`, `secret.ts`, `auth.ts`, `evolution/`, `channels/whatsapp*.ts`,
   rutas del panel, `docker-compose.yml`, `.env.example`, `riverrun`, `docker/backup/backup.sh` y las pruebas existentes.
2. Fuente y publicaciones oficiales de Evolution API (repositorio, etiquetas 2.2.3–2.4.0-rc2, Docker Hub): rutas, guardas
   de autenticación, migraciones por versión y qué contiene cada imagen.
3. Pruebas: suite existente como línea base (604/604 con PostgreSQL + pgvector), pruebas nuevas simuladas, **Evolution
   real** en un entorno aislado y una prueba **de extremo a extremo con Docker real** de `./riverrun install/update/restore`.

## Hallazgos

| # | Gravedad | Problema | Causa | Solución | Estado |
|---|---|---|---|---|---|
| D1 | **Crítica** | Evolution sin versión fijada (`latest` por defecto). | `latest` se reconstruye sin aviso (hoy: 2.3.7 + documentación); cada instalación corre la versión del día en que la descargó. La siguiente, 2.4, **exige licencia**: con la imagen real 2.4.0-rc2 toda la API responde `503 LICENSE_REQUIRED` (aunque `GET /` diga "it is working"). Al llegar a `latest`, WhatsApp caería en todas las instalaciones. | Imagen fijada a **2.3.7 por digest** (ancla única en Compose), catálogo de compatibilidad. La RC probada `2.4.0-rc2` queda incompatible; la 2.4 final y demás 2.4.x, no verificadas (pide confirmación); el bloqueo real lo detecta el monitoreo al recibir `LICENSE_REQUIRED`. | Corregido |
| D2 | Alta | Actualizar Evolution migraba su esquema sin plan ni confirmación, y la vuelta atrás podía bajarlo sobre una base ya migrada. | Evolution ejecuta `prisma migrate deploy` en cada arranque. `update` no miraba Evolution; su vuelta atrás (`up -d backend`) **recrea las dependencias cambiadas** (comprobado con Docker real), es decir, Evolution con la imagen vieja. | `update`: plan de esquema, confirmación, respaldo verificado de ambas bases, verificación de sesiones, vuelta atrás con `--no-deps` y **nunca** bajar un esquema migrado (se fija y se explica cómo recuperar). | Corregido |
| D3 | Alta | La comprobación de salud posterior a `update` nunca detectaba fallos. | `health_json` usaba `wget -qO-`, que con un **503** no imprime el cuerpo: el texto vacío "pasaba". Detectado en la prueba real (la instalación estaba en falla y "se actualizó" igual). | Se lee con `node` dentro del contenedor y solo bloquean las comprobaciones que **la versión nueva rompe** (lo que ya fallaba, como una clave de IA pendiente, no). | Corregido |
| C1 | Alta | Configuraciones críticas solo producían advertencias y el servidor arrancaba igual. | `index.ts` imprimía `assertProductionConfig()` con `console.warn`. | Validación estructurada (Zod) antes de cargar el servidor: crítico / aviso / opcional, según entorno y funciones activas; no arranca ante un crítico y explica cómo corregirlo. | Corregido |
| C2 | Alta | Valores numéricos inválidos se convertían en `NaN` sin aviso. | `Number(env(...))` sin validar: `SCHEDULER_INTERVAL_MS=abc` o `EMAIL_POLL_SECONDS=x` acaban en `setInterval(NaN)` (cada 1 ms); otros, en consultas rotas. | Rangos y enteros validados; crítico en cualquier entorno. | Corregido |
| C3 | Media | Secretos débiles sin aviso claro. | `SESSION_SECRET` de ejemplo o corto (firma sesiones y cifra secretos guardados), `ADMIN_PASSWORD` corta o la pública de ejemplo. | Avisos visibles en consola y panel; **no bloquean el arranque**, para no romper instalaciones existentes que ya funcionan. Riesgo aceptado: un `SESSION_SECRET` corto puede adivinarse a partir de una cookie (ver riesgos). | Corregido (aviso) |
| D4 | Media | El monitoreo daba Evolution por sano con cualquier respuesta HTTP (también 401 o 503) y no veía el funcionamiento real de WhatsApp. | `fetch(EVOLUTION_URL)` sin mirar el resultado; ni versión, ni llave, ni sesiones perdidas, ni webhooks, ni entregas fallidas. | Dos comprobaciones: servicio (responde, atiende la API, llave, versión) y sesiones (perdidas, desconexiones, webhooks, entregas, regresión tras un cambio de versión). Solo lectura. | Corregido |
| D5 | Media | La vinculación podía borrar y recrear una instancia ya vinculada justo después de actualizar Evolution. | Recuperación automática de instancias "trabadas" (45 s sin QR). | Durante 24 h tras un cambio de versión, o con una versión incompatible, no se recrean instancias ya vinculadas: se avisa. | Corregido |
| D6 | Media | El respaldo previo a actualizar solo comprobaba la base principal; no registraba la versión de Evolution. | `verify_backup` restauraba solo `chatbot`. | `BACKUP_VERIFY_ALL` (lo usa `update` si cambia Evolution) restaura también `evolution`; el manifiesto guarda imagen y esquema; la restauración avisa si no coinciden. | Corregido |
| C4 | Media | Funciones "aparentemente activas" que no funcionan. | Interruptores con valores distintos de `true` exacto se apagan; Stripe/Mercado Pago/Google con una sola credencial quedan desactivados; `WEBHOOK_BASE_URL` a `localhost` con Evolution en otro contenedor; verificación de correo sin SMTP. | Avisos específicos con cómo corregirlos; el panel distingue configurado, accesible, credenciales, funcional y listo. | Corregido |
| C5 | Media | Algunos valores detenían el proceso con una traza en vez de un reporte. | `config.ts` lanza errores al importarse. | La validación corre antes de importarlo (`index.ts` → `server.ts`) y reporta todos los problemas juntos. | Corregido |
| D7 | Media | El procedimiento de actualización nunca se actualizaba a sí mismo. | El `riverrun` instalado se lee completo antes del `git pull`. | Si el `riverrun` descargado cambió, `update` continúa con él (`--resume-from`). La primera actualización a esta versión aún la ejecuta el script anterior (ver riesgos). | Corregido (desde esta versión) |
| D8 | Baja | `restore` con la confirmación por tubería se cancelaba con error. | `docker compose run … list` consumía la entrada estándar. | Lista con `</dev/null`; sin respuesta = cancelado. | Corregido |
| C6 | Baja | El panel no mostraba el estado de la configuración. | — | Sección Configuración / Servicios / Evolution API (solo superadmin, sin secretos). | Corregido |

Errores propios detectados por las pruebas reales antes de entregar (no llegaron a `main`): la sonda de la llave trataba
el 404 de Evolution 2.3.7 real como error (el simulador devolvía `[]`; ahora imita al real); `verify` no fallaba si
Evolution respondía 503 a toda la API; avisos falsos con versiones RC y con la misma imagen escrita de otra forma; el
puerto efímero del script de compatibilidad cambiaba al reiniciar.

## Archivos

Nuevos: `src/config-check.ts`, `src/server.ts` (el cuerpo anterior de `index.ts`), `src/diagnostics.ts`,
`src/evolution/compat.ts`, `src/evolution/status.ts`, `src/cli/config-check.ts`, `src/cli/evolution-check.ts`,
`migrations/037_system_state.sql`, `public/js/system-config.js`, `scripts/evolution-compat.sh`,
`.github/workflows/evolution-compat.yml`, `docs/configuracion.md`, `docs/evolution-api.md`, este documento y las pruebas
`test/config-check.test.ts`, `test/startup.test.ts`, `test/evolution-monitor.test.ts`, `test/evolution-live.test.ts`.

Modificados: `src/index.ts`, `src/config.ts`, `src/monitor.ts`, `src/evolution/client.ts`,
`src/channels/whatsapp-session.ts`, `src/routes/admin.ts`, `public/js/system.js` (una línea), `docker-compose.yml`,
`.env.example`, `riverrun`, `docker/backup/backup.sh`, `package.json` (scripts), `README.md` y las pruebas
`test/harness.ts`, `test/monitor.test.ts`, `test/migration.test.ts`, `test/evolution.test.ts`, `scripts/test-cli.sh`,
`scripts/test-backup.sh`.

## Configuración nueva o modificada

| Elemento | Antes | Ahora |
|---|---|---|
| `EVOLUTION_IMAGE` (por defecto) | `evoapicloud/evolution-api:latest` | `evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4…7f4d339` (sigue siendo configurable) |
| `CONFIG_VALIDATION` | — | `strict` (por defecto) · `warn` (emergencias) |
| `RIVERRUN_ENV` | — | opcional; si no, se deduce de `NODE_ENV` |
| Backend y respaldos | no conocían la imagen de Evolution | reciben `EVOLUTION_IMAGE` (misma ancla de Compose) |
| `BACKUP_VERIFY_ALL`, `BACKUP_EVOLUTION_DB` | — | verificación completa (la activa `update`) y nombre de la base de Evolution en el respaldo |
| `./riverrun update` | sin opciones de Evolution | `--accept-evolution-change` (confirmación sin terminal) |
| Panel / API | — | `GET /api/system/diagnostics`, `POST /api/system/diagnostics/run` (superadmin) |
| npm | — | `npm run config:check`, `npm run evolution:check` |
| Base de datos | — | tabla `system_state` (versión de Evolution vista y última comprobación; sin secretos) |

Ninguna variable se eliminó ni se renombró.

## Pruebas ejecutadas

Resumen; el detalle de cada prueba real y de la prueba de extremo a extremo está en
[evolution-api.md → Pruebas](evolution-api.md#pruebas).

| Conjunto | Tipo | Resultado |
|---|---|---|
| `npm test` (PostgreSQL 16 + pgvector, como CI) | simulado + base real | 640 pruebas: 627 pasan, 0 fallan, 13 omitidas (las `[real]`) |
| `scripts/evolution-compat.sh` (Evolution 2.3.7 fijada; y 2.3.6 → 2.3.7) | Evolution real | pasa; el QR se omite con motivo (sin acceso a WhatsApp) |
| `scripts/evolution-compat.sh` con la RC 2.4.0-rc2 (`EVOLUTION_EXPECT_INCOMPATIBLE=1`) | Evolution real | detectada como bloqueada por licencia |
| Transición, actualización, bloqueo de bajada, fallo con migraciones y recuperación | Docker real (extremo a extremo) | instancia, webhook y canal conservados |
| `scripts/test-cli.sh` (flujo de `update`, `restart` y `rotate-secret`) | Docker simulado | pasa |
| `scripts/test-backup.sh`, `shellcheck`, tipos, panel, `npm audit` | estático y PostgreSQL real | pasa |

Qué no se pudo probar aquí: vincular un teléfono, recibir y enviar mensajes reales, reconectar tras actualizar,
`docker build` local (lo cubre CI) y las credenciales de Stripe, Mercado Pago y Google.

## Riesgos pendientes

- **Primera actualización a esta versión:** la ejecuta el `riverrun` anterior, que aplica la imagen fijada sin plan ni
  confirmación (con su respaldo de siempre). Probado sin pérdidas desde 2.3.6; para versiones de Evolution más viejas
  (< 2.3) el camino no está verificado. Recomendado: `git pull --ff-only && ./riverrun update`.
- **Bajadas de versión:** solo se comprobó que 2.3.6 funciona sobre un esquema de 2.3.7. El procedimiento nunca baja un
  esquema migrado automáticamente; una bajada manual exige restaurar el respaldo.
- **Evolution 2.4:** la RC probada exige licencia y queda bloqueada. La 2.4 final no se ha probado: se trata como no
  verificada y el monitoreo detecta el bloqueo por licencia en tiempo real. Adoptarla requiere verificarla con la suite.
- **Secretos débiles como aviso:** un `SESSION_SECRET` de pocos caracteres, si se filtra una cookie de sesión, puede
  probarse sin conexión. Se avisa en consola y en el panel; no se bloquea el arranque.
- **Servidores de Evolution propios por canal** (`config.url`): el monitoreo profundo no los revisa (se cuentan aparte).
- **Stripe, Mercado Pago y Google:** sus credenciales no se prueban automáticamente (se informa "no verificado").
- **`CONFIG_VALIDATION=warn`** permite arrancar con problemas críticos; el panel lo muestra en rojo.
- **Ventana de 24 h tras un cambio de versión:** una caída masiva de sesiones ajena a la actualización también se
  atribuiría a ella (más sensible a propósito; el detalle lo aclara).
