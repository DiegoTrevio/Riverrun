# Lista de producción: los 10 puntos y dónde está cada uno

Resumen para quien publica Riverrun. Cada punto dice qué hay hoy, dónde vive y qué falta. Revisado el 2026-11-13.

| # | Punto | Estado |
|---|---|---|
| 1 | Panel comprimido y sin mapas de código | Listo |
| 2 | Cada negocio solo ve sus datos (RLS) | Aislamiento listo en el código; RLS en la base, segunda fase |
| 3 | Control de versiones y vuelta atrás | Listo |
| 4 | API para conectar otras herramientas | Lista |
| 5 | Hosting y despliegue en vivo | Listo para instalar; falta el dominio |
| 6 | Seguridad | Lista (verificación en dos pasos apagada por decisión) |
| 7 | Límite de peticiones | Listo |
| 8 | Caché y compresión | Listo |
| 9 | Escalar | Funciona en un servidor; camino de crecimiento abajo |
| 10 | Monitoreo | Listo |

## 1. Panel comprimido y sin mapas de código

- Al construir la imagen, `scripts/minify-public.mjs` comprime cada archivo `.js` y `.css` del panel (sin espacios, sin comentarios y con nombres internos cortos): baja de unos 1,270 KB a unos 900 KB antes de gzip. El repo sigue legible; solo la copia de la imagen va comprimida.
- Ni el panel ni el backend llevan mapas de código (`sourceMap: false` en `tsconfig.json`), así que nadie puede reconstruir el código original desde el navegador ni desde la imagen.
- Las llaves nunca viajan al navegador: viven en `.env` o cifradas en la base. `test/production-build.test.ts` revisa que ningún archivo del panel contenga algo con forma de llave (OpenAI, OpenRouter, Stripe, Spaces, Resend, claves privadas o contraseñas de base de datos), que el panel comprimido conserve cada import y export y que la imagen no copie el panel legible.
- Ojo: todo JavaScript que corre en un navegador se puede leer. Comprimirlo lo vuelve difícil de seguir, no secreto; por eso lo importante es que no contenga llaves, y eso es lo que se comprueba.

## 2. Cada negocio solo ve sus datos

**Hoy:** cada consulta filtra por la cuenta del usuario (`account_id`) y la base impide mezclar cuentas en las relaciones (ver [data-storage.md](data-storage.md)). `test/isolation.test.ts` recorre **todas** las rutas del panel, leídas del código (una ruta nueva queda cubierta sola), entrando con usuarios de otra cuenta y con los IDs de los datos ajenos, y falla si alguna los expone. La API v1 limita cada llave a su cuenta.

**RLS (Row Level Security), segunda fase.** Sería un segundo candado dentro de PostgreSQL: aunque una consulta olvidara el filtro, la base no devolvería filas de otra cuenta. Se dejó para después de abrir (decisión del 2026-11-13) porque son unas 1,600 consultas y 126 tablas, y hacerlo a días de abrir arriesga romper algo. Plan cuando toque:

1. Guardar la cuenta de cada petición en un contexto (`AsyncLocalStorage`) y abrir cada consulta del panel en una transacción con `SET LOCAL app.account_id`.
2. Un usuario de PostgreSQL solo para el panel, sin `BYPASSRLS` y que no sea dueño de las tablas; los procesos internos (cola, barridos, superadministrador) siguen con el usuario actual.
3. Activar RLS tabla por tabla, empezando por las de clientes y mensajes (`contacts`, `conversations`, `messages`, `quotes`), con la política `account_id = current_setting('app.account_id')::uuid`.
4. Correr `test/isolation.test.ts` con el usuario restringido y medir el costo de la transacción extra por consulta.

## 3. Control de versiones y vuelta atrás

- El código vive en Git y cada cambio entra por PR con las pruebas del CI (`.github/workflows/ci.yml`, `security.yml` y las de calidad del asistente).
- Las migraciones de la base están numeradas en `migrations/`, se aplican solas al arrancar y son aditivas: la versión anterior sigue funcionando con la base nueva.
- `./riverrun update` respalda, construye, levanta, comprueba la salud y, si la versión nueva falla, **vuelve sola** a la anterior. Volver atrás no es lo mismo que restaurar un respaldo: ver [produccion.md](produccion.md#revertir-no-es-restaurar). Cada imagen lleva su versión (`APP_VERSION`, el commit).
- Los agentes tienen su propio historial de versiones para deshacer un cambio de instrucciones ([agent-versions-and-tests.md](agent-versions-and-tests.md)).

## 4. API para conectar otras herramientas

API v1 versionada en `/api/v1` con llaves de lectura o escritura, paginación, errores con código fijo y documentación OpenAPI en `/api/v1/docs`. También webhooks firmados para Zapier, Make o n8n. Ver [integraciones.md](integraciones.md) y [api-sencilla.md](api-sencilla.md).

## 5. Hosting y despliegue en vivo

Todo listo para un Droplet de DigitalOcean (4 GB) con Docker y HTTPS automático (Caddy). Pasos en [publicar-digitalocean.md](publicar-digitalocean.md). Lo pendiente es del dueño: comprar el dominio, apuntarlo al servidor y correr `./riverrun install`.

## 6. Seguridad

Revisiones completas en [revision-seguridad-2026-11-12.md](revision-seguridad-2026-11-12.md) y anteriores, y el detalle en [seguridad.md](seguridad.md). Entre lo que hay: contraseñas largas y revisadas contra filtraciones, cookies seguras, protección contra peticiones desde otros sitios, encabezados de seguridad (CSP, HSTS), llaves cifradas en la base, usuarios de PostgreSQL por servicio, firewall y swap con `./riverrun harden`, `./riverrun preflight` antes de publicar y topes de gasto de IA por cuenta. La verificación en dos pasos existe pero está apagada (`MFA_REQUIRED=false`) por decisión del dueño; se recomienda encenderla.

## 7. Límite de peticiones

Contadores en PostgreSQL (`src/identity/rate-limit.ts`), compartidos por todos los procesos y que sobreviven a un reinicio: inicio de sesión (por conexión y por cuenta), códigos de verificación, registro, reservas, chat web, webhooks rechazados, API v1 (600 por minuto por conexión, 300 por llave y 60 escrituras por minuto) y llamadas a Zernio. El gasto de IA tiene además su tope por cuenta ([contact-workspace-and-ai-budgets.md](contact-workspace-and-ai-budgets.md)). Caddy corta cuerpos de más de 64 MB y conexiones que mandan los encabezados demasiado lento.

## 8. Caché y compresión

- Caddy comprime cada respuesta con zstd o gzip (lo que acepte el navegador).
- Los archivos del panel se sirven con `ETag`: el navegador pregunta y recibe "sin cambios" (304) sin descargarlos otra vez, y una versión nueva se ve al instante, sin limpiar caché.
- Logos, fotos y adjuntos llevan su propio tiempo de caché; lo privado (exportaciones, datos del contacto) va con `no-store`.
- Dentro del backend se guardan en memoria las comprobaciones de salud, la lista de modelos de IA, los PDF de cotizaciones y la disponibilidad de los calendarios.

## 9. Escalar

Un Droplet de 4 GB atiende, según la estimación de la revisión del 2026-11-12 (no medida), unas 12 a 20 respuestas de IA por minuto (unos 15 a 20 negocios chicos en hora pico) y de 8 a 12 números de WhatsApp. El límite es la IA y WhatsApp, no el servidor web. Camino de crecimiento, en orden:

1. **Subir el Droplet** a 8 GB al pasar de 10 a 15 números de WhatsApp o si la memoria pasa de 80 %; subir `QUEUE_CONCURRENCY` y `worker_limits` ([escalar-y-modelos.md](escalar-y-modelos.md)).
2. **Base de datos administrada** (DigitalOcean Managed PostgreSQL) cuando la base crezca o se quieran respaldos automáticos con recuperación a cualquier minuto.
3. **Varias copias del backend** detrás de Caddy: la cola ya lo permite (cada conversación la toma un solo proceso) y los límites de peticiones ya se comparten en la base.
4. **Evolution (WhatsApp) en su propio servidor** cuando sean decenas de números.

No conviene adelantar estos pasos: cada uno cuesta cada mes y hoy no hay carga que lo pida.

## 10. Monitoreo

- Tres niveles de salud (`/health`, `/health/ready`, `/health/functional`), métricas en `/metrics` e incidencias con aviso al equipo ([observabilidad.md](observabilidad.md)).
- Latido a healthchecks.io (`HEARTBEAT_URL`): avisa si el servidor entero deja de responder ([publicar-digitalocean.md](publicar-digitalocean.md)).
- Registro de seguridad en el panel y registros de cada servicio con `./riverrun logs`.
