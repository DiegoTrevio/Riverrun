# Plataforma de chatbots multicanal (WhatsApp, Telegram, Messenger, Instagram y chat web)

Plataforma propia para crear, configurar y operar chatbots para varios clientes. Cada **cuenta** (cliente) tiene sus propios usuarios, chatbots y **canales**: WhatsApp (vía Evolution API), Telegram, Facebook Messenger, Instagram y un chat para su sitio web. Un mismo chatbot puede atender varios canales a la vez. Todo lo que cambia de un negocio a otro (prompt, tono, información, imágenes, reglas, datos a recopilar, flujo) vive en **PostgreSQL** y se edita desde un **panel web**, sin tocar código. Para pasar de un hotel a una inmobiliaria se cambia la configuración, no el sistema.

```
WhatsApp (Evolution) ┐                                  ┌► misma plataforma
Telegram             │                                  │
Messenger/Instagram  ├─► Backend (este proyecto) ───────┤
Chat web (widget)    ┘    │                             │
                          ├─ Cuenta → canal → chatbot asignado
                          │
                              ├─ Cola por conversación (agrupa mensajes seguidos)
                              ├─ Contexto controlado: prompt + conocimiento relevante + memoria + mensajes recientes
                              ├─ OpenRouter PROPONE una acción (JSON estricto)
                              ├─ El backend VALIDA: imágenes, datos, precios/links/teléfonos, frases, formato
                              ├─ Ejecuta: texto · texto+imagen · pregunta · guardar dato · no responder · transferir
                              └─ PostgreSQL: chatbots, conocimiento, imágenes, contactos, conversaciones, mensajes, uso de IA, registros
```

## Lo que resuelve

**Búsqueda semántica y evaluaciones.** pgvector permite recuperar conocimiento por significado y Promptfoo comprueba el contexto, las reglas y el motor completo con PostgreSQL temporal y transporte simulado. Consulta [configuración, funcionamiento, costos y pruebas](docs/knowledge-evaluations.md), y [CI protegido, límites y habilitación periódica](docs/quality-production.md), y [piloto, monitoreo y recuperación](docs/production-rollout.md), y [supervisión automática y avisos](docs/knowledge-supervision.md). El desarrollo requiere Node.js 22.22 o posterior; la búsqueda semántica se activa explícitamente y conserva la selección por palabras ante fallos.

| Requisito | Cómo se cumple |
|---|---|
| **Conversación natural** | Guía de estilo de WhatsApp en el prompt (frases cortas, una pregunta por turno, no repetir saludo), tono/idioma/longitud/emojis/trato configurables, ejemplos de estilo, formato WhatsApp (`*negritas*`, sin Markdown), división en 1–N mensajes, "escribiendo…" proporcional, y agrupación de mensajes seguidos del cliente (debounce) para contestar una sola vez. |
| **Contexto correcto** | Se envía: prompt + conocimiento (si excede el presupuesto, solo lo relevante + lo marcado como "siempre incluir") + catálogo de imágenes + datos del cliente + notas + resumen + últimos N mensajes. Nunca el historial completo. La parte fija va primero para aprovechar el caché de prompts del modelo (más barato). |
| **Cero invenciones** | 1) Instrucción explícita de usar solo la información cargada. 2) El validador extrae **precios, números, URLs, correos y teléfonos** de la respuesta y verifica que existan en el conocimiento/configuración. Los **montos de dinero** solo se aceptan si vienen del negocio (el cliente no puede "dictar" un precio). Cada cifra debe aparecer **completa**: "$650" no se valida porque exista "$1,650" ni porque esté dentro de un teléfono o de la fecha. Un enlace debe estar en las fuentes (o ser el dominio de una página conocida): una ruta inventada sobre el dominio real ("hotel.mx/promo-50") se rechaza. 3) Si falla, se pide a la IA que corrija; si insiste, se envía un mensaje de respaldo o se transfiere, según la regla configurada. |
| **Preguntas en orden** | Pestaña **Preguntas**: una lista separada de las instrucciones que el asistente sigue paso a paso, una por mensaje y con el texto exacto. El sistema calcula cuál sigue, la agrega si la IA la omite, quita las que se adelantan y no acepta respuestas inventadas. Activadores por palabra clave y desactivador «al responder todas las preguntas» en la pestaña **Activación** ([detalle](docs/preguntas-y-activacion.md)). |
| **Imágenes correctas** | **Mensajes guardados** (texto + foto) que la IA elige por código y se envían tal cual, en un solo mensaje con la foto y el texto como pie ([detalle](docs/image-delivery.md#mensajes-guardados-texto--foto)). La IA solo ve un catálogo con ID, nombre, qué muestra y cuándo usarla. El backend descarta IDs inexistentes o inactivos, evita reenviar la misma imagen, limita cuántas se envían y rechaza respuestas del tipo "te mando la foto" sin imagen válida. Los archivos se validan por su firma real (JPG/PNG/WEBP, máx. 5 MB). |
| **Memoria** | Datos del cliente guardados automáticamente a partir de sus respuestas (nombre, correo y teléfono validados), notas de intereses, nombre, y un **resumen acumulado** de lo antiguo que se genera automáticamente. La IA recibe el resumen + todos los mensajes aún no resumidos (sin huecos), y ve qué datos ya tiene y cuáles faltan, así no vuelve a preguntar. |
| **Transferencia a humano** | Por palabras clave (sin gastar IA), por decisión de la IA según reglas, o manualmente desde el panel. Aviso opcional por WhatsApp a un encargado. Si alguien responde desde el teléfono, el bot se pausa en esa conversación. Retoma automática opcional tras X minutos. |
| **Registros** | Cada error/evento de Evolution, IA, validador, webhook y panel queda en `event_logs` y se ve en el panel. Cada llamada a la IA queda en `ai_runs` con tokens (incluidos los cacheados), latencia, decisión y validación. |
| **Cuentas y usuarios** | Cada cliente es una cuenta con sus usuarios (administradores y agentes). Solo ven lo suyo: cualquier intento de acceder a otra cuenta responde 404. El superadministrador ve y administra todas. Desactivar una cuenta corta el acceso de sus usuarios y detiene sus canales (los mensajes se siguen guardando). |
| **Multicanal** | WhatsApp, Telegram, Messenger, Instagram, chat web y redes sociales por Zernio (Instagram, Facebook, WhatsApp Business, Telegram, X, Bluesky y Reddit, conectadas desde el panel). Cada canal pertenece a una cuenta y se asigna a un chatbot; un chatbot puede atender varios canales con la misma configuración. Webhooks verificados por plataforma (secreto de Telegram, firma `X-Hub-Signature-256` de Meta, firma `X-Zernio-Signature` de Zernio, URL secreta de Evolution). Se puede duplicar un chatbot como plantilla, incluso en otra cuenta. |

### Redes sociales (Zernio)

Instagram, Facebook Messenger, WhatsApp Business (API oficial), Telegram, X, Bluesky y Reddit llegan por [Zernio](https://zernio.com), una API unificada de **mensajes directos**. Implementación: `src/channels/zernio.ts` (API, eventos, envíos) y `src/channels/zernio-connect.ts` (conexión desde el panel).

**La plataforma tiene una sola llave; cada negocio solo conecta sus redes.**

1. El superadministrador pega la llave en **Sistema → Redes sociales (Zernio)** (o define `ZERNIO_API_KEY` en el `.env`, que tiene prioridad), con `PUBLIC_BASE_URL` en HTTPS. La llave se prueba con Zernio antes de guardarse, se guarda cifrada con la clave del servidor, queda activa sin reiniciar en todos los procesos (en menos de un minuto) y nunca sale al navegador: el panel solo muestra sus últimos 4 caracteres. Al guardarla se registra el webhook único y se crea el perfil de las cuentas que aún no lo tienen; **Probar y reparar** repite ambas cosas.
2. En su agente, el negocio pulsa **+ Conectar teléfono u otro canal**, elige la red (Instagram, Facebook, Telegram…) y la conecta desde el panel, sin ver llaves ni identificadores:
   - **Instagram, Facebook, WhatsApp Business, X y Reddit:** se abre la autorización de la red (Zernio aloja la elección de página o número) y al terminar vuelve al canal con la cuenta conectada. El retorno usa un estado de un solo uso que vence a los 30 minutos y se valida contra el perfil del negocio.
   - **Telegram:** el panel muestra un código; el negocio agrega el bot de conexión y le envía el código. El panel revisa cada 3 s hasta que queda conectado.
   - **Bluesky:** usuario y contraseña de aplicación en el mismo panel (la contraseña no se guarda).
3. El servidor crea un **perfil de Zernio por negocio** (se reconoce por `externalId` = id de la cuenta) y registra **un solo webhook** para toda la instalación en `/zernio/events`, firmado con un secreto derivado de `APP_SECRET`. Cada evento se entrega al canal que tiene esa cuenta conectada.

Como con el QR de WhatsApp, el canal muestra la foto, el nombre y el usuario de la cuenta conectada, su estado, y botones para **Reconectar**, **Revisar conexión** y **Desconectar** (quita la cuenta en Zernio). Si Zernio avisa que la cuenta se desconectó (`account.disconnected`, p. ej. token vencido), el canal queda desconectado y los administradores reciben una notificación y un correo.

Mensajes: el cliente se identifica por la conversación de Zernio; el agente contesta en el mismo hilo con «escribiendo…» donde la red lo permite (Instagram, Facebook, WhatsApp, Telegram). Envía texto, fotos y archivos (los archivos se suben a Zernio con URL firmada; Bluesky y Reddit solo admiten texto). Las fotos, notas de voz y documentos del cliente se descargan (los de WhatsApp con la llave de la plataforma) y las notas de voz se transcriben. Los ecos de lo que envía el agente (`message.sent`) se reconocen por el id de la plataforma y aunque vuelvan sin formato. Meta permite escribir solo dentro de la ventana de 24 h; fuera de ella no se envían campañas por estas redes.

Variables: `ZERNIO_API_KEY` (obligatoria para activar las redes) y `ZERNIO_API_URL` (por defecto `https://zernio.com/api/v1`). Los canales creados antes con su propia llave y webhook siguen funcionando.

### Facebook e Instagram con un botón (app de Meta de la plataforma)

Con `META_APP_ID` y `META_APP_SECRET` definidos, cada negocio conecta su página de Facebook (Messenger) y su Instagram profesional con **Conectar con Facebook**, sin copiar tokens ni configurar webhooks. Implementación: `src/channels/meta-connect.ts`.

1. El negocio pulsa **Conectar con Facebook** (en las conexiones del agente o en el paso **Redes** de Primeros pasos), inicia sesión y acepta los permisos. El regreso (`/meta/callback`) usa un estado de un solo uso que vence a los 30 minutos.
2. El servidor cambia el código por un token de larga duración y lee las páginas con su Instagram vinculado. El negocio elige qué conectar (Messenger, Instagram o ambos) y el agente que responde; los tokens nunca llegan al navegador.
3. Cada página elegida se suscribe a la app (`subscribed_apps`) y queda **en línea**. Todos los eventos llegan a **un solo webhook** de la plataforma, `/meta/webhook`, firmado con `X-Hub-Signature-256` usando `META_APP_SECRET`, y se entregan al canal de esa página o cuenta de Instagram. Volver a conectar renueva el token sin duplicar canales; una página ya atendida por otro negocio de la plataforma no se conecta dos veces.
4. Cada 6 horas se revisan los tokens: si Meta los invalidó (contraseña cambiada, permiso retirado), el canal queda **Desconectado** y el negocio recibe el aviso (según sus **alertas de conexión**) con el botón para volver a conectar. **Desconectar** quita la suscripción de la página y borra el token.

Configuración única en Meta for Developers (la hace el administrador de la plataforma): producto *Inicio de sesión con Facebook* (o *Facebook Login for Business*, con `META_CONFIG_ID`) con la URI de redirección `https://TU_DOMINIO/meta/callback`; productos *Messenger* e *Instagram* con el webhook `https://TU_DOMINIO/meta/webhook` y el token `META_VERIFY_TOKEN` (cualquier texto largo que elijas; debe ser el mismo en Meta y en el servidor), campos `messages`, `messaging_postbacks` y `message_echoes`; y la revisión de la app para `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `instagram_basic` e `instagram_manage_messages`. Con el botón activo, Facebook e Instagram ya no aparecen como redes de Zernio; los canales conectados antes con tokens manuales siguen funcionando.

**Perfil de Zernio por cuenta:** al dar de alta una cuenta (registro o superadministrador) se crea su perfil de Zernio y se guarda en la cuenta, para que conectar la primera red no espere; si Zernio no responde en ese momento, se crea al conectar la primera red. Nunca se crean dos perfiles por cuenta.

> **WhatsApp:** la conexión por Zernio es la API oficial de WhatsApp Business (Meta); Zernio no ofrece vinculación por QR. El WhatsApp normal con QR sigue siendo su propio canal (Evolution).

| **Económico** | Todo corre en un VPS con Docker (Evolution, Postgres, Redis, backend). Solo se paga la API de OpenRouter; el contexto acotado, el caché de prompts y el modelo configurable por chatbot mantienen bajo el costo. |

## Instalación en un VPS (Docker)

Requisitos: un VPS con Linux (2 GB de RAM alcanzan para empezar). Si no tiene Docker, el instalador ofrece instalarlo.

```bash
git clone <este repo> && cd Riverrun/chatbot-platform
./riverrun install
```

El instalador hace las preguntas mínimas (dominio, tu correo y la clave de OpenRouter), **genera solo todas las contraseñas y claves**, levanta los servicios, espera a que respondan y te imprime la dirección del panel, el usuario y la contraseña. También se puede instalar sin preguntas con variables (`RIVERRUN_DOMAIN`, `RIVERRUN_ADMIN_EMAIL`, `OPENROUTER_API_KEY`, `SMTP_URL`) y `--non-interactive`.

Un solo comando para todo lo que sigue:

| Comando | Qué hace |
|---|---|
| `./riverrun status` | Servicios, salud, último respaldo y si hay versión nueva |
| `./riverrun preflight [--offline]` | Revisión previa a producción, solo lectura: memoria, disco, configuración, Evolution fijada y dominio. Lo que no puede comprobar sin red o sin servicios queda como **no verificado**, nunca como aprobado |
| `./riverrun update` | Revisa la configuración y la compatibilidad de Evolution, respalda, aplica y comprueba que quedó sana; **si no, vuelve sola a la anterior** (sin bajar Evolution si ya migró su base) |
| `./riverrun backup` | Respaldo inmediato (también corre solo cada noche) |
| `./riverrun restore [archivo]` | Restaura el último respaldo, o un archivo (por ejemplo en un servidor nuevo) |
| `./riverrun logs [servicio]` | Registros en vivo |
| `./riverrun restart` | Aplica cambios hechos a `.env` (antes revisa que la configuración no tenga problemas críticos) |
| `./riverrun rotate-secret` | Cambia `SESSION_SECRET` (respaldo verificado antes, confirmación escrita; cierra sesiones y pide reconectar Google Calendar) |

- Con dominio, `install` activa HTTPS automático (Caddy). Antes apunta el dominio (registro DNS tipo A) a la IP del servidor y abre los puertos 80 y 443. HTTPS es necesario para Telegram, Messenger, Instagram y el chat web.
- Sin dominio, el panel queda en `http://127.0.0.1:3000` del VPS; desde tu computadora: `ssh -L 3000:127.0.0.1:3000 usuario@tu-vps` y visita `http://localhost:3000`.
- Al arrancar se crea el **superadministrador** (tu correo). Si olvidas la contraseña, cámbiala en `.env` y `./riverrun restart`.
- Evolution API solo escucha en `127.0.0.1:8080` (no queda expuesta a internet) y viene **fijada a una versión verificada** (2.3.7, por digest): una descarga futura nunca la cambia. Para cambiarla: `EVOLUTION_IMAGE` en `.env` y `./riverrun update`. Ver [Evolution API: versión, actualización y recuperación](docs/evolution-api.md).
- **Validación de la configuración:** antes de arrancar, el servidor revisa `.env` y distingue problemas **críticos** (no arranca y dice cómo corregirlos), **avisos** (arranca con funciones limitadas) y servicios **opcionales** apagados. Revisión sin arrancar: `npm run config:check` o `docker compose run --rm --no-deps backend node dist/cli/config-check.js`. Ver [configuración](docs/configuracion.md).
- Instalación manual (sin el script): `cp .env.example .env`, edita los valores y `docker compose up -d --build`.

## Respaldos

Un contenedor (`backup`) respalda **cada noche** (03:30 UTC) lo que no se puede perder: la base del chatbot, la base de Evolution, las fotos subidas y las sesiones de WhatsApp. Cada respaldo es **un solo archivo cifrado** (AES-256 con `BACKUP_PASSPHRASE`, que `install` genera y te pide guardar fuera del servidor).

- **Se verifica solo:** después de crear cada respaldo se abre, se comprueban sus sumas y se **restaura en una base temporal**. Si algo falla, el panel (Sistema) y las alertas lo avisan.
- **Retención:** 7 diarios, 4 semanales y 6 mensuales (configurable con `BACKUP_KEEP_*`).
- **Copia en la nube (recomendado):** si el servidor se pierde, los respaldos locales también. Define `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_KEY` y `BACKUP_S3_SECRET` (Backblaze B2, Cloudflare R2, Wasabi, AWS S3…) y cada respaldo se copia ahí.
- **Restaurar:** `./riverrun restore` (detiene el sistema, restaura, lo vuelve a levantar). En un servidor nuevo: `./riverrun install`, baja el archivo de la nube y `./riverrun restore ruta/riverrun-….tar.enc` con la misma `BACKUP_PASSPHRASE`. Antes de restaurar se hace un respaldo de seguridad de lo que hubiera.
- Pruebas automáticas del ciclo completo (respaldar → destruir → restaurar → detectar archivos dañados): `scripts/test-backup.sh`.

## Cobro automático (Stripe y Mercado Pago)

Los clientes contratan y pagan solos: **al crear su cuenta** (eligen el plan en el registro y pasan directo al pago) o después desde **Ajustes → Mi plan y pagos**. Tú no cobras ni activas nada a mano.

1. **Claves:** en `.env` pon `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` y/o `MERCADOPAGO_ACCESS_TOKEN` + `MERCADOPAGO_WEBHOOK_SECRET`; `./riverrun restart`. Cada proveedor se activa solo con sus dos claves.
2. **Webhooks:** en el panel, **Planes y cobro** muestra la dirección exacta que debes registrar en cada proveedor (`/webhook/billing/stripe` y `/webhook/billing/mercadopago`) y qué eventos activar. Siguen siendo necesarios para renovaciones, cobros fallidos y cancelaciones.
3. **Planes:** ahí mismo creas tus planes (nombre, precio mensual, moneda). **No hace falta crear nada en Stripe:** al primer pago de cada plan se crea su producto en Stripe (`riverrun_<clave>`) y se cobra el precio y la moneda del plan; si cambias el precio, los nuevos clientes pagan el nuevo y los que ya pagaban conservan el suyo. Si ya tienes un precio en Stripe (`price_…`), pégalo y se usa ese.

**Registro con pago:** con cobro configurado, el registro (`/#/registro`) muestra tus planes y, si hay prueba gratis, la opción de probar sin tarjeta. Quien elige un plan crea su cuenta y pasa directo a la página de pago; al volver, la cuenta ya está activa. Para enlazar desde tu página de precios usa `https://tu-dominio/#/registro?plan=<clave>` (deja ese plan elegido). Con `TRIAL_DAYS=0` no hay prueba gratis: la cuenta nace en pausa (puede entrar y configurar todo, pero el asistente no responde) y se activa al pagar.

**El pago se confirma aunque el aviso no llegue:** al abrir el pago se guarda su referencia; al volver de la página de pago el panel le pregunta al proveedor y, si ya se cobró, activa la cuenta en ese momento. Si la persona cierra la ventana, la revisión de cada 10 minutos hace lo mismo durante 2 días. El aviso del proveedor (webhook) sigue funcionando igual y nada se aplica dos veces. El regreso del pago (`/pago/stripe`, `/pago/mercadopago`) vuelve al mismo dominio desde el que se pagó (también el de una marca blanca), con la sesión abierta.

**Cobro duplicado:** si alguien paga dos veces (por ejemplo, en dos pestañas), se conserva la suscripción vigente y te llega un aviso (panel y `SUPERADMIN_EMAIL`) para cancelar y reembolsar la otra desde el proveedor.

Qué pasa solo: el pago **activa** la cuenta (sale de prueba o de pausa) y le asigna el plan; la renovación mensual la cobra el proveedor; si un cobro **falla**, la cuenta sigue funcionando `BILLING_GRACE_DAYS` (5 por defecto) mientras se avisa por correo y panel, y luego se **pausa sola**; al pagar, se **reactiva sola**. Al cancelar, el acceso dura hasta el final del periodo ya pagado. El cliente cambia su tarjeta y ve sus facturas en la página de Stripe ("Administrar pago") o cancela desde el panel. Si reactivas a mano una cuenta pausada por pago, el sistema respeta tu decisión. Los avisos de los proveedores se verifican con su firma, se consultan de nuevo al proveedor (llegan repetidos o desordenados sin problema) y las cuentas activadas a mano sin suscripción no se tocan. Nunca pasan datos de tarjeta por tu servidor: el pago ocurre en la página de Stripe / Mercado Pago.

## Monitoreo y alertas

- `GET /health` (el servicio vive), `GET /health/ready` (puede atender: base de datos y tareas; público, **503** solo si esas fallan, sin detalles) para cualquier monitor externo.
- Con `HEALTH_TOKEN` (lo genera `./riverrun install`): `GET /health/functional` (estado de cada componente: operativo, degradado, no disponible, no configurado o no verificado, con qué hacer) y `GET /metrics` (formato Prometheus, sin datos personales). Sin token, ambos responden 404.
- Incidencias con historial, severidad, una sola por componente, silencio (`ALERT_MUTE`) y escalamiento. Detalle, métricas y lo que no está incluido: [docs/observabilidad.md](docs/observabilidad.md). Procedimientos de producción: [docs/produccion.md](docs/produccion.md).
- **Revisión cada minuto** de: base de datos, servicio de Evolution (responde, acepta la llave, versión compatible), **WhatsApp real** (sesiones desconectadas o perdidas, webhooks incorrectos, envíos fallidos y desconexiones tras actualizar Evolution), tareas programadas atrasadas, IA (clave y errores recientes), **antigüedad y éxito del último respaldo** (y su copia en la nube) y espacio en disco. Cada 15 minutos, una revisión más profunda (sesión y webhook de cada WhatsApp, credenciales de IA y correo).
- **Alertas:** un fallo avisa al segundo minuto seguido (evita falsas alarmas), se repite cada 6 h y avisa cuando se recupera. Llegan por correo (`SUPERADMIN_EMAIL` + SMTP) y, si quieres, a un webhook (`ALERT_WEBHOOK_URL`: Slack, Discord, ntfy.sh…).
- **Latido externo (`HEARTBEAT_URL`):** el sistema visita esa dirección cada 5 minutos mientras está sano (healthchecks.io tiene plan gratuito; Uptime Kuma también). Si dejan de llegar, *ellos* te avisan, incluso si el servidor completo cayó, algo que el sistema no puede avisar por sí mismo.
- **Panel → Sistema** (superadmin): todo lo anterior en una pantalla, con versión, tiempo encendido, errores de 24 h, WhatsApp por estado y suscripciones; además **Configuración** (críticos, avisos y opcionales con cómo corregirlos), **Servicios** por niveles (configurado → accesible → credenciales válidas → funcional → listo; sin mostrar nunca claves) y **Evolution API** (versión esperada, imagen configurada, versión detectada o "No verificada", compatibilidad y última verificación).

## Actualizaciones

`./riverrun update` hace, en orden: comprobar que no hay cambios locales → descargar la versión → construirla **sin arrancarla** → revisar que la configuración no tenga problemas críticos para la versión nueva → si cambia Evolution, revisar su compatibilidad y si migrará su esquema (pide confirmación cuando hay riesgo y bloquea versiones incompatibles o bajadas de esquema) → **respaldo** (si falla, no sigue; si cambia Evolution es obligatorio y se verifica restaurando también su base) → levantar → verificar Evolution y que las sesiones abiertas vuelvan → esperar a que `/health` responda y que la salud funcional (o, sin token, `/health/ready`) no tenga fallas nuevas. WhatsApp cuenta: si Evolution estaba bien antes de actualizar y no responde después, la versión nueva se revierte (si ya estaba caída, no bloquea). Cualquier problema antes de levantar deja todo como estaba. Si la versión nueva no queda sana, **vuelve sola** al código y a la imagen anteriores; Evolution solo vuelve a su imagen anterior si su esquema no cambió (si ya migró, se queda fijado en la versión nueva y se explica cómo recuperar desde el respaldo, sin borrar ni recrear sesiones). Las migraciones de base de datos de RiverRun se aplican solas al arrancar y son aditivas, por lo que volver atrás es seguro; en el improbable caso contrario, `./riverrun restore latest`. `./riverrun status` avisa cuando hay cambios nuevos y muestra la versión de Evolution. `scripts/test-cli.sh` prueba este flujo con un docker simulado y `scripts/evolution-compat.sh` corre la suite contra Evolution real (también en CI: `.github/workflows/evolution-compat.yml`). Detalle en [docs/evolution-api.md](docs/evolution-api.md).

## Integración continua

`.github/workflows/ci.yml` corre en cada pull request y en `main`: revisión de tipos, sintaxis del panel, **todas las pruebas** (contra PostgreSQL real), auditoría de dependencias, `shellcheck` de los scripts, la prueba de respaldo y restauración de punta a punta, la del flujo de actualización, la validación del `docker-compose` y la construcción de las imágenes.

El panel también tiene regresión de navegador y accesibilidad: `npm run test:ux`, con Chromium y axe-core. Se ejecuta después de las pruebas del motor, contra una base aislada que el arnés reinicia. CI adjunta los resultados y las capturas. Consulta la [auditoría UX/UI](docs/ux-ui/audit.md) y su [cobertura de implementación, criterios y ejecución](docs/ux-ui/implementation.md).

## IA con OpenRouter

El proveedor predeterminado es OpenRouter. Configura en el servidor (no en el prompt):

```dotenv
OPENROUTER_API_KEY=<tu clave de OpenRouter>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4.1-mini
OPENROUTER_SUMMARY_MODEL=openai/gpt-4.1-mini
OPENROUTER_TRANSCRIPTION_MODEL=google/gemini-2.5-flash
```

`OPENAI_API_KEY` sigue funcionando como variable de compatibilidad; una clave existente de OpenRouter puede quedarse ahí. Las variables `OPENROUTER_*` tienen prioridad sobre las equivalentes `OPENAI_*`. Docker transmite la clave, la URL y los modelos al backend. Después de actualizar y configurar, ejecuta `docker compose up -d --build backend` para recrearlo con los nuevos valores. No basta reiniciar el proceso si cambió el entorno del contenedor.

Los modelos antiguos de cada bot, como `gpt-4.1-mini`, se envían como `openai/gpt-4.1-mini` sin modificar su configuración guardada. Para otros proveedores usa el ID completo de OpenRouter. El modelo del agente debe admitir JSON Schema: se solicita `provider.require_parameters=true` para evitar rutas que ignoren este formato. Los resúmenes usan el modelo de resumen; las notas de voz, si se habilitan, se envían como `input_audio` al modelo de audio, que debe aceptar su formato (WhatsApp suele enviar OGG/Opus).

**Modelos de respaldo.** `OPENROUTER_FALLBACK_MODELS=google/gemini-2.5-flash,anthropic/claude-haiku-4.5` (máximo 2) hace que OpenRouter pruebe el siguiente modelo si el principal falla, está saturado o rechaza la petición; cada asistente puede definir los suyos en *Instrucciones → Opciones avanzadas*. Los modelos de respaldo deben soportar salidas estructuradas (JSON Schema). El consumo se registra con el modelo que realmente respondió. El panel (**Sistema**) consulta el catálogo público de OpenRouter y avisa si algún modelo configurado (global, de respaldo o de un asistente) **ya no existe**, antes de que los clientes se queden sin respuestas.

**Elegir modelo con datos, no a ojo.** El modelo por defecto no se cambia sin medirlo. Las evaluaciones en vivo (`evals/`) están bloqueadas a propósito a `gpt-4.1-mini` para controlar el gasto: probar otro modelo ahí exige primero revisar su precio en `evals/live-budget.mjs`. Mientras tanto, compara con un asistente duplicado que use el candidato (*Asistentes → Duplicar*), las mismas conversaciones en **Probar** y el costo y la latencia por respuesta en **Consumo de IA**. Procedimiento completo en [escalar y modelos](docs/escalar-y-modelos.md).

El servidor necesita acceso HTTPS a `openrouter.ai`, una clave válida y saldo. Los errores de autenticación, saldo o modelo se muestran sin devolver el cuerpo técnico ni fragmentos de la clave. Para mantener OpenAI directo, configura explícitamente `OPENROUTER_BASE_URL=https://api.openai.com/v1`, una clave de OpenAI y los modelos sin prefijo.

## Empresas que se registran solas (modo servicio)

Así funciona para vender el servicio sin que tú entres a configurar nada:

```
Internet ──HTTPS──> Caddy (app.tudominio.com)
                      └─> backend :3000   panel, registro, webhooks, tareas
                            ├─> PostgreSQL   BD "chatbot" (todo) + BD "evolution"
                            ├─> OpenRouter       tu clave; el gasto se registra por cuenta
                            └─> Evolution API :8080  (solo red interna, nunca expuesta)
                                  ├─ Redis
                                  └─ 1 instancia por canal de WhatsApp de cada empresa: "acc<id>_<aleatorio>"
```

1. **Registro** (`/#/registro`, enlazado desde el inicio de sesión): nombre, empresa, tipo de negocio, correo y contraseña. Se crea su cuenta en **prueba** (`TRIAL_DAYS`, 14 por defecto; con `0`, en pausa hasta que pague) con ella como administradora, y entra directo. Con cobro en línea configurado también elige su plan: si elige uno, pasa a pagarlo en ese momento (ver [Cobro automático](#cobro-automático-stripe-y-mercado-pago)). Tú recibes un aviso (panel y `SUPERADMIN_EMAIL`).
2. **Confirmar correo**: le llega un enlace (48 h, un solo uso). Mientras no lo confirme puede configurar y probar todo, pero **no puede conectar WhatsApp** ni otros canales reales.
3. **Primeros pasos** (`/#/inicio`), un asistente de 5 pasos:
   1. *Tu negocio*: zona horaria, horario y su WhatsApp para avisos.
   2. *Tu asistente*: nombre, trato (tú/usted) y su información: productos/servicios con precios, horarios, ubicación, preguntas frecuentes. Se crea el chatbot con la **plantilla de su giro** (restaurante, salud, hotel, tienda, servicios, belleza u otro): personalidad, flujo, datos que pide y reglas (p.ej. "nunca des diagnósticos" en salud). Todo se puede afinar después en la configuración avanzada.
   3. *Fotos* (opcional): catálogo de imágenes.
   4. *Pruébalo*: el simulador.
   5. *WhatsApp*: el QR aparece solo en cada cuenta/canal (también en celular; "Con mi número" queda como alternativa) → se vincula desde *Dispositivos vinculados* → el panel detecta la conexión, muestra el número vinculado y avanza solo.
4. **Si su WhatsApp se desconecta** (teléfono sin internet, sesión cerrada) se le avisa en el panel y por correo con un enlace que abre directo el código para volver a vincularlo.
5. **Fin de la prueba**: 3 días antes se avisa a la empresa y a ti; al vencer la cuenta queda **en pausa**: puede entrar al panel, pero el bot no responde ni salen mensajes. Con cobro en línea, los correos llevan el enlace para pagar y la cuenta se reactiva sola al pagar. Sin cobro en línea, tú, en **Cuentas**, pulsas **Activar plan** (o **Extender prueba**) y `SUPPORT_CONTACT` es lo que ven para contratar.

**Resúmenes y respuestas del cliente.** El asistente guarda las respuestas clave del prompt en el contacto y la conversación, con referencia al mensaje original. Al cerrar, completar el objetivo o transferir a una persona se genera un resumen consultable. En **Conversaciones**, el botón *Generar/Actualizar resumen* lo obtiene en cualquier momento. Los datos se actualizan en una transacción y PostgreSQL impide mezclar cuentas, canales y contactos. Consulta [el esquema y las reglas de almacenamiento](docs/data-storage.md).

**Usuarios y permisos por perfil (subcuentas).** Un perfil de negocio corresponde a una cuenta existente: conserva sus asistentes, hasta cuatro WhatsApps, conversaciones, contactos, agenda, automatizaciones, consumo y registros. No se duplican datos al presentar la cuenta como perfil.

| Nivel | Alcance |
| --- | --- |
| Maestro (`superadmin`) | Todos los perfiles; crea perfiles, asigna usuarios y concede acceso global. |
| Administrador del perfil (`admin`) | Gestiona el perfil asignado y sus usuarios; no puede cambiar de perfil ni conceder acceso maestro. |
| Operador del perfil (`agent`) | Conversaciones, contactos, agenda y notificaciones de su perfil. |

En **Configuración → Perfiles**, el maestro crea el perfil junto con su primer administrador. En **Usuarios y permisos**, selecciona el perfil de cada usuario o concede acceso maestro. Cada usuario tiene un único perfil; varios usuarios pueden compartirlo. La reasignación se aplica a las sesiones ya abiertas en la siguiente petición y retira al usuario como propietario del perfil anterior para evitar sus alertas. Las rutas y las APIs conservan `account_id` por compatibilidad.

La migración `009_master_access.sql` asigna una sola vez acceso maestro al usuario existente y verificado **diegoa.trevio@gmail.com**, conservando su contraseña. Si ese usuario aún no existe o su correo no está confirmado, no lo crea ni le concede acceso. Después de registrar y verificar el correo, el operador del servidor puede ejecutar:

```bash
npm run user:master -- diegoa.trevio@gmail.com
```

En una imagen de producción ya compilada: `docker compose exec backend node dist/cli/grant-master.js diegoa.trevio@gmail.com`. El comando usa la base de datos configurada y no cambia la contraseña. El registro público nunca concede acceso maestro por el correo enviado.

**Conectar WhatsApp (QR).** Tiene su propio botón en el menú (**📱 Conectar WhatsApp**, `#/conectar`), un mosaico en Ajustes y un aviso amarillo en todas las pantallas mientras el número no esté conectado. La página crea el canal si no existe, muestra el QR (o el código "Con mi número"), confirma la conexión, permite enviar un mensaje de prueba y desvincular para conectar otro número; con varios números lista cada uno con su estado.

**Navegación y perfiles.** El menú agrupa todas las herramientas en cuatro apartados: Asistentes y conexiones, Conversaciones, Operación y Configuración. En *Asistentes y conexiones → WhatsApp y otros canales*, cada cuenta puede crear hasta **cuatro perfiles de WhatsApp**, cada uno con instancia, QR y webhook propios. Cada perfil elige un asistente de su misma cuenta; varios perfiles pueden compartirlo. *Ver QR* abre la vinculación del teléfono elegido. Las conversaciones siguen separadas por canal. Desactivar o desconectar un perfil conserva su lugar; eliminarlo libera uno y elimina sus conversaciones. Los otros tipos de canal no consumen estos lugares. Las cuentas que ya tengan más de cuatro conservan sus perfiles, pero no pueden crear otros hasta quedar por debajo del límite.

**WhatsApp por empresa, aislado.** Todas las empresas comparten tu servidor de Evolution, pero cada canal tiene su propia instancia (su sesión de WhatsApp, su QR, su webhook secreto). El nombre de la instancia lo genera el servidor y el cliente **no puede** cambiarlo, ni apuntar su canal a otro servidor de Evolution, ni ver tu `EVOLUTION_API_KEY`. Solo el superadministrador puede asignar a un canal otro servidor de Evolution (útil para repartir clientes grandes) y, en ese caso, debe darle su propia llave: la llave global nunca se envía a otra URL. Al borrar un canal o una cuenta, su instancia se cierra y se elimina de Evolution.

**Gasto de IA por cuenta.** Cada llamada a la IA vía OpenRouter (respuestas, resúmenes y notas de voz) guarda el costo en USD reportado por OpenRouter; si no lo reporta, lo estima con la tabla de precios (**Consumo de IA → Precios por modelo**, editable; verifica en openrouter.ai/models). Tú ves el gasto del mes por cuenta en **Cuentas** y **Consumo de IA**; cada empresa ve el suyo (por día, por tipo y costo promedio por conversación). No hay límite: con `AI_ALERT_USD_PER_ACCOUNT` recibes un aviso cuando una cuenta lo supera en el mes.

**Para producción:**

- Configura `SMTP_URL` (cualquier proveedor: tu hosting, Amazon SES, SendGrid, Brevo…). Sin SMTP los correos solo quedan en **Registros**; en ese caso usa `SIGNUP_REQUIRE_EMAIL=false` o nadie podrá conectar WhatsApp.
- Servidor recomendado para empezar: 4 vCPU / 8 GB. Cada sesión de WhatsApp vive en Evolution; vigila su memoria (`docker stats`) conforme crecen las empresas.
- **Respaldos y restauración**: conservar las bases `chatbot` y `evolution`, archivos y sesiones. Consulta la [revisión inicial de producción y herramientas de respaldo](docs/production-review.md). Sin las sesiones de Evolution las empresas podrían necesitar volver a escanear sus QR; sin `uploads` se perderían fotos referenciadas en la base.
- Evolution ya viene fijado a una versión verificada. Antes de cambiarla, pruébala con `scripts/evolution-compat.sh <imagen>` y aplícala con `./riverrun update` ([docs/evolution-api.md](docs/evolution-api.md)).
- Evolution conecta WhatsApp como "dispositivo vinculado" (no es la API oficial de Meta). El registro lo advierte: las campañas masivas a números que no te escribieron pueden provocar el bloqueo del número.
- Para cerrar el registro: `SIGNUP_ENABLED=false` (puedes seguir creando cuentas a mano en **Cuentas**).

## Cuentas, usuarios y roles

| Rol | Qué puede hacer |
|---|---|
| **Superadministrador** | Todo, en todas las cuentas. Crea cuentas (con su primer administrador), las activa/desactiva o elimina, activa planes, pausa o extiende pruebas y ve el gasto de IA de todas. Tiene un selector de cuenta en el menú para trabajar dentro de una o ver todas. |
| **Administrador** | Todo dentro de su cuenta: chatbots, canales, usuarios, conversaciones y registros. |
| **Agente** | Solo conversaciones de su cuenta: verlas, tomarlas, responder, devolverlas al bot y editar datos del cliente. No ve la configuración ni credenciales. |

Al cambiar una contraseña, las demás sesiones abiertas de ese usuario se cierran. Desactivar un usuario le quita el acceso al instante. Cualquiera puede recuperar su contraseña con **¿Olvidaste tu contraseña?** (enlace por correo de 1 hora y un solo uso).

*Desactivar* una cuenta le quita todo acceso; *pausarla* (o que venza su prueba) le deja el panel pero detiene el bot y los envíos.

## Primeros pasos en el panel

1. **Cuentas** (superadministrador): crea la cuenta del cliente y, opcionalmente, su primer administrador.
2. **Asistentes → + Nuevo asistente**: elige el nombre y tipo de negocio. La configuración tiene cuatro secciones:
   - **Instrucciones**: escribe cómo debe atender, qué debe preguntar y cuál es su objetivo. El estilo y las opciones avanzadas quedan plegados.
   - **Conocimiento**: agrega productos, precios, horarios y preguntas frecuentes, o usa **⚡ Llena todo por mí**: pega la dirección de tu página (o un Google Sheets compartido), sube un PDF, una foto del menú o un CSV, o pega texto. La IA lo ordena en secciones, tú lo revisas y lo guardas; **🔄 Volver a sincronizar** lo actualiza desde la misma página. Solo se usa lo que está en la fuente (no inventa) y las páginas internas están bloqueadas. Excel y Word: guárdalos como CSV/PDF.
   - **Fotos**: sube imágenes y explica cuándo enviarlas; las reglas de envío son opcionales.
   - **Probar**: conversa como un cliente y revisa los datos guardados automáticamente. Los detalles técnicos de cada respuesta quedan plegados. Funciona aunque el asistente esté apagado.
   Quien administra su propia cuenta ve un **menú simple** (Conversaciones, Mi asistente, Probar mi asistente, Agenda, Ajustes y Notificaciones); el resto vive en **Ajustes** o en «☰ Mostrar todas las opciones». El asistente de **Primeros pasos** tiene 5 pasos (negocio → asistente → prueba → redes → WhatsApp); las fotos y las redes son opcionales. En **Redes** el negocio conecta Facebook e Instagram con un botón y las demás redes (X, Telegram, Bluesky, Reddit, WhatsApp Business) por Zernio, o lo omite.
3. **Canales → Nuevo canal**: elige la plataforma, asígnale el asistente y sigue las instrucciones de conexión (abajo).
4. En **Instrucciones**, marca **Asistente encendido** y guarda.

No hay que crear campos para guardar las respuestas. Por ejemplo, si las instrucciones dicen «pregunta la dirección para entregar» y el cliente responde «Av. Reforma 25», el asistente propone guardar `direccion: Av. Reforma 25` y el backend verifica que ese valor aparezca en un mensaje del cliente. Los datos se ven en la ficha de la conversación y en **Probar**; se reutilizan para evitar preguntas repetidas y se actualizan cuando el cliente los corrige. Nombre, correo y teléfono se normalizan y validan. Los campos de configuraciones anteriores siguen siendo compatibles.

Cada ajuste del panel indica si está **✓ Garantizado** (el sistema lo revisa antes de enviar y, si no se cumple, corrige la respuesta o pide otra) o si es una **Guía** para la IA (la sigue casi siempre; compruébalo en Probar):

| Garantizado por el sistema | Guía para la IA |
|---|---|
| No inventar precios, cantidades, teléfonos, correos ni enlaces · mensaje de respaldo · qué hacer si falta un dato | Instrucciones y tono |
| Trato tú/usted · largo de las respuestas · emojis · número y tamaño de mensajes | Cuándo pasar con una persona (situaciones) |
| Temas prohibidos (no los saca por su cuenta) · frases prohibidas | Reglas de tu negocio (texto libre) · de qué puede hablar |
| Palabras que pasan con una persona · callarse si contesta el equipo | Cuándo mandar fotos |
| Fotos solo del catálogo, sin repetir, con máximo por respuesta | Recorrido de la conversación |
| Datos del cliente con formato válido · agenda solo con horarios reales | |
| Recorrido: el objetivo solo cuenta con los datos "importantes" · acción al cumplirlo (pasar a una persona o avisar), una vez | |

**Reglas generales del agente.** Todo asistente sigue las mismas reglas de seguridad y conversación, aplique o no el negocio: emergencias pasan a una persona con un mensaje fijo, los contestadores no se contestan, los bucles se pausan, los datos sensibles no se guardan y lo que el asistente promete le llega al equipo. Qué se garantiza, qué depende del modelo y cómo se prueba: [docs/agente.md](docs/agente.md).

**Recorrido de la conversación** (Opciones avanzadas): objetivo, etapas y qué hacer al cumplirlo. En cada turno la IA indica en qué etapa queda y si se cumplió el objetivo; el sistema lo guarda y se lo recuerda en el siguiente turno, junto con los datos importantes que faltan, para que no repita etapas ni preguntas. El objetivo se acepta solo si ya están todos los datos marcados como "Importante". Cuando se marca (una sola vez por recorrido) el sistema, en este orden: envía las fotos de objetivo, **genera el resumen y el análisis**, **pasa la conversación a una persona** o **avisa al equipo** (según lo elegido) —el aviso del panel y de WhatsApp lleva el resumen, los datos confirmados y los pendientes— y dispara las reglas «Se cumple el objetivo» (con el reporte ya listo, por ejemplo para `Enviar reporte`) y los webhooks `goal.completed` / `conversation.handoff`, que incluyen resumen, análisis y datos. Cada cambio de etapa dispara la regla «El recorrido llega a una etapa» (una etapa concreta o cualquiera) y envía las fotos de esa etapa. Las fotos que no cupieron en la respuesta o que la plataforma rechazó se reintentan solas (ver `docs/image-delivery.md`). La etapa y el objetivo se ven en cada conversación; al cerrarla y que el cliente vuelva a escribir, el recorrido empieza de nuevo (también las fotos «una sola vez»). El asistente conoce el horario de atención y la zona horaria de **Horario y ajustes** (sabe si en este momento está abierto).

Consejo: si una regla del negocio tiene cifra (precio, descuento, anticipo), escríbela también en **Conocimiento**; así queda garantizada por la verificación de datos.

Para ver un ejemplo completo: `npm run seed:demo` (o `docker compose exec backend node dist/cli/seed-demo.js`) crea la cuenta "Demo" con un chatbot de hotel y un canal de chat web.

## Conectar cada plataforma

| Plataforma | Qué necesitas | Cómo se conecta |
|---|---|---|
| **WhatsApp** | Un teléfono con WhatsApp (normal o Business) | Al abrir el canal (o el paso 5 de Primeros pasos) el código **aparece solo** y se renueva solo, con cuenta regresiva: **Escanear código QR** es la opción inicial en todos los dispositivos; como alternativa, **Con mi número**: escribe tu número, recibes un código de 8 letras y en WhatsApp → Dispositivos vinculados → *Vincular con el número de teléfono* lo tecleas. El panel detecta la conexión y muestra "Conectado como …". Dos pestañas reutilizan el QR vigente sin reiniciar la vinculación. Si Evolution responde sin código durante un tiempo, se comprueba otra vez el estado antes de recuperar una instancia trabada; los fallos de autorización o de API se muestran como errores, sin eliminar la sesión. |
| **Telegram** | Un bot creado con **@BotFather** | Pega el token, guarda y pulsa **Conectar con Telegram**: se valida el token y se registra el webhook con un secreto (los mensajes sin ese secreto se rechazan). Solo chats privados. |
| **Facebook e Instagram (botón)** | Ser administrador de la página; Instagram profesional vinculado a ella | **Conectar con Facebook**: inicia sesión, elige páginas e Instagram y el agente. Requiere que la plataforma tenga su app de Meta (ver arriba). |
| **Messenger (manual)** | Una app en Meta for Developers con el producto Messenger y una página de Facebook | Pega el token de la página y la clave secreta de la app. En la app de Meta configura el webhook con la **URL** y el **token de verificación** que muestra el panel, suscrito a `messages`, `messaging_postbacks` y `message_echoes`. Pulsa **Verificar y suscribir la página**. |
| **Instagram** | Cuenta profesional de Instagram vinculada a la página, en la misma app de Meta | Igual que Messenger, en la sección Instagram de la app. |
| **Chat web** | Nada | Personaliza título, color y bienvenida; copia el código `<script …>` en el sitio del cliente. Opcional: limita los dominios que pueden insertarlo. Hay una **vista previa** en el panel. |

Detalles por plataforma:

- Si alguien del equipo responde **directamente** desde WhatsApp o desde la bandeja de la página de Facebook/Instagram, el bot se pausa en esa conversación.
- El formato `*negritas*` se usa en WhatsApp; en las demás plataformas se envía como texto plano.
- Messenger e Instagram descargan las imágenes desde una URL pública firmada (`/media/…`), por eso necesitan HTTPS.
- Los avisos de transferencia al encargado salen siempre por un WhatsApp activo de la cuenta, aunque la conversación sea de otra plataforma.
- Un canal **sin chatbot** asignado guarda los mensajes pero no responde; al asignarle uno, empieza a atender.

## Automatización

Menú **Automatización** (administradores). Todo corre sobre tareas programadas guardadas en PostgreSQL, así que sobreviven a reinicios del servidor.

### Reglas: "cuando pase X, si se cumple Y, haz Z"

| Cuándo (disparador) | Solo si (condiciones) | Hacer (acciones) |
|---|---|---|
| El cliente escribe (palabras clave, frase exacta, texto o cualquier mensaje; opcional: solo el primer mensaje) | Canal | Enviar mensaje o foto (con espera opcional) |
| Cliente nuevo | Dentro/fuera del horario del negocio | Alertar al equipo (panel + WhatsApp) |
| **Intención detectada por la IA** ("quiere cotizar", "queja"… las defines tú) | Tiene / no tiene etiqueta | Agregar / quitar etiqueta |
| Se guarda un dato (p. ej. correo) | Dato del cliente presente, vacío, igual o que contiene | Guardar un dato |
| Se agrega una etiqueta | Estado de la conversación (bot, persona, cerrada) | Pasar a una persona / devolver al bot / cerrar |
| **No responde en X minutos** (seguimiento automático, una sola vez por silencio) | | Iniciar / detener secuencias |
| Pasa a una persona | | **Webhook** a otro sistema (n8n, Zapier, CRM), firmado con `X-Signature` |
| Cita agendada / cancelada | | |
| Se da de baja | Asistente activo / en pausa | Pausar al asistente (con reactivación opcional en N horas) / activarlo |
| Se cumple el objetivo | | **Enviar reporte de la conversación** (resumen, análisis y datos; panel, correo y WhatsApp) |
| **El recorrido llega a una etapa** (una concreta o cualquiera) | | Asignar a alguien del equipo (por turnos) |
| El asistente se desactiva | | |

- **Plantillas rápidas:** bienvenida, fuera de horario, palabra urgente → alerta, seguimiento, queja → persona, listo para comprar → ventas, correo → CRM, palabra → pausar / activar al asistente, agradecer cita, objetivo cumplido → reporte al equipo.
- **🧪 Probar palabras:** escribe un mensaje de ejemplo y ve qué reglas se activarían (✅/❌ con el motivo), sin IA y sin enviar nada.
- **Detener la IA:** una regla puede impedir que la IA responda el mensaje que la disparó.
- **Variables en los textos:** `{{nombre}}`, `{{cliente}}`, `{{telefono}}`, `{{negocio}}`, `{{mensaje}}`, `{{link}}`, `{{dato.CAMPO}}`, `{{cita.servicio}}`, `{{cita.fecha}}`, `{{cita.hora}}`, `{{cita.lugar}}`.

### Activadores y desactivadores del asistente

Pestaña **Activación** de cada asistente. Lo aplica el sistema (no la IA), por conversación:

- **Cuándo empieza a responder:** siempre, o **solo después de que el cliente escriba una palabra de activación** ("info", "hola asistente"…). Las mismas palabras lo **reactivan** si está en pausa.
- **Cuándo se apaga:** si el cliente escribe ciertas palabras ("ya no", "gracias, es todo"), al **cumplirse el objetivo**, al **agendar una cita** o cuando el cliente **ya dio todos los datos elegidos** (p. ej. nombre y teléfono: responde ese mensaje y después se apaga).
- **Qué pasa al apagarse:** pausa en silencio, pasar a una persona (con aviso al equipo) o cerrar la conversación; mensaje opcional; reactivación automática tras N horas (0 = solo con palabra, regla o el botón **Reactivar asistente** de la conversación).
- **Cómo probarlo:** el **probador de palabras** (en la misma pestaña) dice, sin IA, si el asistente respondería y qué reglas se dispararían; el **Simulador** muestra en cada mensaje "Qué se activó" y el estado del asistente.

### Secuencias (flujos programados)

- Serie de mensajes con espera entre ellos (minutos, horas o días) y hora del día opcional ("1 día después a las 10:00" = al día siguiente a las 10:00).
- Cada paso puede tener condiciones propias.
- Respetan el horario del negocio: lo que caiga fuera se pasa a la siguiente apertura.
- Se detienen si el cliente responde, si se da de baja o si una persona toma la conversación.
- Si la cuenta está en pausa o el canal apagado, esperan (reintentan cada hora hasta 7 días) en lugar de perderse.
- Se inician con una regla o manualmente desde la conversación.

### Campañas

- Mensaje a un segmento: con o sin ciertas etiquetas, o que escribieron en los últimos N días. Envío inmediato o programado.
- Se envían a ritmo controlado (mensajes por minuto) para proteger el número.
- Por defecto solo se envían en horario de atención: lo que no alcance sale en la siguiente apertura, al mismo ritmo.
- Siempre excluyen a quien se dio de baja y no interrumpen conversaciones que está atendiendo una persona. Muestran vista previa de destinatarios y estadísticas por destinatario.

### Horario y ajustes

- Zona horaria, horario semanal y días festivos.
- **Bajas:** "BAJA"/"STOP" (configurable) deja de enviar mensajes promocionales; "ALTA" los reactiva. Los recordatorios de citas sí llegan.
- Aviso al equipo cuando una conversación pasa a una persona.
- URL del calendario `.ics` y clave de los webhooks.

### Reglas de las plataformas

- **Messenger e Instagram:** solo se escribe a quien envió un mensaje en las últimas 24 horas (regla de Meta). Lo demás se omite y queda registrado.
- **WhatsApp:** envía solo a clientes que esperan saber de ti y con ritmo moderado, porque WhatsApp puede bloquear números que envían mensajes masivos no deseados.

## Agenda: citas y llamadas

Menú **Agenda**, para administradores y agentes.

- **Servicios:** cita o llamada, con duración, descanso entre citas, clientes a la vez, anticipación mínima, días a futuro, lugar, horario propio o del negocio, y personas que atienden.
- **La IA agenda por el chat:**
  - Ve los horarios realmente libres y ofrece 2 o 3 opciones.
  - Agenda cuando el cliente elige y cancela sus citas a pedido.
  - El backend valida el horario y la cita en una transacción bloqueada, así que no hay dobles reservas.
  - Si la IA propone un horario que no existe, se rechaza y se ofrecen horarios reales.
- **Recordatorios** automáticos al cliente (por defecto 1 día y 1 hora antes) y **aviso al equipo** (a quien atiende) al agendar o cancelar.
- **Desde el panel:**
  - vista semanal en la hora del negocio;
  - nueva cita;
  - agendar desde una conversación (el cliente recibe la confirmación por su chat);
  - reprogramar, completar, marcar "no asistió" y cancelar (con aviso al cliente).
- **Calendario suscribible** (`.ics`) para Google Calendar, Outlook o Apple.
- **Simulador:** las citas de prueba quedan marcadas "prueba", no ocupan horarios reales y no avisan al equipo. Las alertas y webhooks de las reglas se muestran como notas en el chat de prueba.

## Alertas al equipo

- Cada usuario ve sus **notificaciones** en el panel (con contador).
- Quien activa "Recibir alertas por WhatsApp" en **Mi perfil** (o su administrador en **Usuarios**) las recibe también en su WhatsApp, a través de un canal de WhatsApp de la cuenta.

## Conversaciones

- Lista filtrable por chatbot, plataforma, canal, estado (bot / humano / cerrada) y búsqueda.
- Detalle con el historial (imágenes incluidas), datos del cliente editables, notas y resumen de memoria.
- **Tomar conversación** (el bot deja de responder), **responder manualmente** desde el panel, **devolver al bot** (los mensajes que llegaron mientras atendía una persona no se contestan en automático) y **borrar memoria**.

- **Exportar a CSV**: menú **Exportar** en Conversaciones (contactos, conversaciones y mensajes; solo administradores, queda en el registro).

## Planes y límites

Cada plan define mensajes del mes, canales, usuarios y asistentes (0 o vacío = sin límite); la prueba gratuita usa `TRIAL_MAX_*`, y el superadmin puede dar una excepción por cuenta (**Cuentas → Límites**). Al llegar al 80 % y al 100 % de mensajes se avisa al administrador; al agotarse, el asistente deja de responder solo (sin llamar a la IA) hasta el mes siguiente o hasta subir de plan, y una campaña mayor al cupo restante no se lanza. El simulador no gasta cupo.

## Varios números de WhatsApp

Una cuenta puede conectar varios WhatsApp. Las **campañas** pueden salir de varios números a la vez (cada uno con su ritmo y su tope diario, **Ajustes → Horario y avisos**), y un **enlace de reparto** (`/wa/<token>`, en Canales) manda a cada cliente nuevo al número conectado menos ocupado o por turnos.

## Cumplimiento

- **Consentimiento**: las campañas y secuencias solo escriben a contactos con consentimiento (se registra la fecha y el origen; por palabra clave de alta, casilla en el contacto o al reanudar). Se puede desactivar por cuenta.
- **Baja**: la palabra de baja ("STOP") ya existía; los mensajes promocionales llevan un pie configurable con las instrucciones.
- **Retención**: borrado automático de mensajes y de contactos inactivos tras los días que elijas (cada 6 horas).
- **Derechos del titular**: descarga de todos los datos de un contacto (JSON) y borrado definitivo desde el panel o `DELETE /api/contacts/:id`.
- Los términos y el aviso de privacidad se enlazan desde el registro (`TERMS_URL`, `PRIVACY_URL`).

## Crear un agente sin escribir un prompt

En **Asistentes → + Nuevo asistente** hay un asistente de cuatro pasos: tu empresa, hasta dónde llega el agente (solo filtrar, agendar citas, atender o tomar pedidos; datos que pide; límites; cómo suena), tus documentos (web, PDF, foto, CSV o texto) y una revisión final. De ahí se genera solo el prompt con los lineamientos de siempre (natural, sin dar información de más, sin inventar y sin salirse de su papel), las reglas, el conocimiento y, si agenda, el servicio de la agenda. Detalle en [docs/agent-creation.md](docs/agent-creation.md).

## Asignación por turnos (round robin) y avisos internos

- **Reparto automático** (Automatización → Ajustes → *Reparto de conversaciones por turnos*): cada conversación que pasa a una persona se asigna a la siguiente del turno entre los roles (y, si quieres, solo entre las personas que elijas). Solo esa persona recibe la notificación en el panel (y por WhatsApp si la tiene activada); puedes avisar además a todo el equipo. El turno recuerda a quién le tocó la última vez, así que si alguien se desactiva o se ausenta no se descompone, y es seguro con varias réplicas.
- **Disponibilidad**: cada persona se marca *disponible / fuera de turno* en **Mi perfil** (o un administrador en **Usuarios**) y se salta en el reparto. Si nadie está disponible, la transferencia avisa a todo el equipo como antes.
- **En las reglas**: la acción *Asignar a alguien del equipo (por turnos)* (con opción de pasar la conversación a una persona) y la opción *avisar a una sola persona, por turnos* en *Alertar al equipo*.
- **A mano**: en cada conversación se ve quién atiende; cualquiera se la queda ("Quedármela"), y un administrador la pasa a una persona o a la siguiente del turno. Quien toma una conversación sin dueña se queda con ella. La lista filtra *Asignadas a mí / Sin asignar*.
- **Avisos internos manuales**: en **Notificaciones → Enviar un aviso interno** (administradores) a todo el equipo, a un rol, a personas o a quien toque por turnos; también por API (`POST /api/v1/notifications`, `GET /api/v1/team`, `PUT /api/v1/conversations/:id/assign`) para que Zapier, Make o tu CRM avisen al equipo.

## Integraciones

Canal de **correo electrónico** (IMAP/SMTP, Gmail y Outlook), inicio de sesión con Google, Google Calendar, webhooks firmados (Zapier, Make, n8n) y API v1 con llaves y especificación OpenAPI: ver [docs/integraciones.md](docs/integraciones.md).

## Marca blanca

El superadmin crea **marcas** (**Marca blanca** en el menú) con nombre, color, logo, correo de soporte y, opcionalmente, un dominio propio (`panel.miagencia.com`). Se asigna a cada cuenta (**Cuentas → Marca**) y quien se registre desde ese dominio queda con ella. Cambia el nombre, el color y el logo del panel, del inicio de sesión y del registro, y el nombre del remitente y los enlaces de los correos. Para un dominio propio, el cliente apunta un registro DNS al servidor y Caddy genera el certificado HTTPS al primer acceso (solo para dominios registrados). Es marca blanca para **tus** clientes: no hay todavía un panel donde un revendedor administre sus propias cuentas (eso sigue siendo del superadmin).

## Cómo decide y valida (el núcleo)

> **Nuevo — afirmaciones sin números.** Además de precios, teléfonos y enlaces, el sistema revisa lo que la respuesta *afirma que el negocio tiene o hace* ("sí tenemos alberca", "aceptamos mascotas", "incluye desayuno"): eso debe estar en la información cargada (o ser un sinónimo: alberca ≈ piscina, estacionamiento ≈ parking…). Lo que el cliente haya dicho **no** cuenta como respaldo, ni lo que el propio bot dijo antes. Si no está, se pide corregir y, si insiste, sale el mensaje seguro. Tres modos por asistente (*Reglas → No afirmar lo que no esté en tu información*): **rápido** (sin costo, por defecto), **estricto** (una segunda IA barata también juzga la respuesta; se registra como consumo `verify`) y **sin revisar**. Es deliberadamente conservador: prefiere dejar pasar una paráfrasis a bloquear una buena respuesta.

La IA responde siempre con este JSON (structured outputs con JSON Schema vía OpenRouter):

```json
{
  "thinking": "análisis interno breve",
  "action": "reply | reply_with_image | ask | no_reply | handoff",
  "messages": ["mensaje 1", "mensaje 2"],
  "image_ids": ["habitacion_doble"],
  "save_data": [{ "field": "correo", "value": "ana@mail.com" }],
  "remember": ["Viaja con dos niños"],
  "handoff_reason": "",
  "info_not_found": false
}
```

El backend (`src/engine/validator.ts`) nunca confía en la propuesta:

- JSON válido y acción conocida.
- Imágenes: solo IDs del catálogo del chatbot, activas, sin repetir, con límite por turno.
- Datos: admite respuestas útiles sin campos predefinidos, siempre que el valor aparezca en los mensajes originales del cliente. Se normalizan las claves y se validan nombre, correo y teléfono. Los campos antiguos conservan su validación de formato.
- Hechos: precios/números/links/correos/teléfonos deben existir en las fuentes (dinero: solo fuentes del negocio).
- Estilo: frases prohibidas, temas prohibidos (si el cliente no los mencionó), trato tú/usted, emojis (máximo 2 en "pocos"), largo según la configuración, Markdown → formato WhatsApp, número y tamaño de mensajes.
- Mensajes fijos (transferencia y respaldo): al cambiar el trato, los de fábrica se ajustan a tú/usted.
- Coherencia: `no_reply` sin mensajes, respuestas vacías, promesas de foto sin imagen.

Problemas corregibles → se reintenta **una vez** con la corrección. En el último intento:

- Problemas de **estilo** se corrigen solos: se quitan las oraciones con frases o temas prohibidos, con promesas de fotos inexistentes o con el trato equivocado (tú/usted), y una respuesta demasiado larga se recorta por oraciones completas al máximo por mensaje y al largo configurado. Si las correcciones vacían la respuesta, sale la pregunta pendiente o el mensaje de respaldo (el cliente no se queda sin respuesta).
- Las **frases prohibidas** se buscan como palabras completas, sin importar acentos, mayúsculas ni signos ("ia" no coincide dentro de "día"; "¿En qué más puedo ayudarte?" se detecta aunque la IA agregue ", Juan").
- Los **temas prohibidos** se reconocen por la raíz de sus palabras: "política" también detecta "políticos" y "armas" detecta "arma".
- Un **dato obligatorio** (los marcados "Importante", que bloquean el objetivo) solo se acepta si el cliente lo dio o confirmó lo que propuso el asistente ("¿Le reservo el 15?" → "sí"): la IA puede normalizarlo ("el 1 de noviembre" → fecha, "2 adultos y 1 niño" → 3, "1,500" → 1500, "la segunda" → la segunda opción), pero no inventarlo. Si lo intenta, se le pide confirmarlo con el cliente.
- En cada **solicitud nueva** se vuelven a pedir las preguntas (salvo nombre, correo y teléfono) y, de los datos sin pregunta, las fechas y cantidades: una segunda reserva no se cumple con las fechas de la anterior, y la dirección, la empresa o el RFC se conservan. `per_request` en cada dato siempre manda.
- **Devolver al asistente después de N minutos**: si nadie del equipo escribe en ese tiempo, la conversación vuelve al asistente aunque el cliente no escriba otra vez, y si el cliente quedó esperando (en las últimas 24 h) se le contesta. Se revisa cada minuto. Una transferencia por emergencia o riesgo para la vida nunca vuelve sola al asistente.
- Las **notas de voz** se transcriben aunque la cuenta tenga presupuesto de IA: se reserva y cobra por la duración que informa la plataforma (o estimada por el tamaño del audio).
- Datos **no verificables** → respuesta de respaldo o transferencia, según la regla configurada.
- Respuesta **inválida** (JSON roto o vacía) → no se envía nada; se registra el error y se reintenta en 1 minuto.

Las cotizaciones simples (precio del catálogo × cantidad que dijo el cliente, p. ej. 3 noches) se aceptan; cualquier otro monto se rechaza. Si la regla es "transferir cuando falta un dato" y la IA marca `info_not_found`, el backend transfiere aunque la IA haya propuesto solo responder. Además, si el cliente escribe mientras la IA piensa, la respuesta se descarta y se vuelve a generar con todos los mensajes; si una persona toma la conversación mientras tanto, no se envía nada.

## Desarrollo local

```bash
npm install
cp .env.example .env   # usa las variables de "desarrollo local"
npm run migrate
npm run dev            # http://localhost:3000
```

Pruebas (unitarias + integración de extremo a extremo con PostgreSQL real, IA y WhatsApp simulados):

```bash
TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test npm test
```

> La base de pruebas se borra por completo en cada ejecución. Si no está disponible, las pruebas de integración se omiten.

## Estructura

```
src/
  engine/
    context.ts     construcción del contexto (prompt, conocimiento relevante, memoria, historial)
    decision.ts    esquema de la decisión de la IA
    validator.ts   validación y saneamiento de la propuesta
    engine.ts      pipeline: IA → validar → reintentar → ejecutar → memoria
    memory.ts      resumen acumulado de la conversación
    queue.ts       cola por conversación (agrupar mensajes, sin respuestas cruzadas) + arrendamiento en PostgreSQL (varios procesos)
    claims.ts      verificación de afirmaciones sin números ("sí tenemos alberca") y juez de IA opcional
    transport.ts   interfaz de salida común y simulador
    text.ts        normalización, extracción de hechos, formato WhatsApp / texto plano
  automation/      reglas, secuencias, campañas, agenda, alertas, envíos proactivos y programador de tareas
  channels/        un adaptador por plataforma (whatsapp, telegram, meta, webchat): webhook, firma, envío, conexión
  evolution/       cliente de Evolution API v2 y parser del webhook
  ai/provider.ts   cliente compatible con OpenRouter (chat, resúmenes, audio, modelos de respaldo)
  ai/models.ts     catálogo de OpenRouter: avisa de modelos configurados que ya no existen
  billing/         cobro automático: Stripe y Mercado Pago (sin SDK), planes y estado de suscripciones
  monitor.ts       salud del sistema, alertas, latido externo y estado para el panel
  knowledge-import.ts   importar conocimiento desde web, PDF, foto, CSV o texto
  routes/          API del panel (cuentas, usuarios, chatbots, canales, conversaciones, primeros pasos, consumo) y rutas públicas (registro, webhooks, chat web, imágenes)
  templates/       plantillas de chatbot por tipo de negocio (asistente de primeros pasos)
  lifecycle.ts     fin de pruebas, avisos de gasto y de WhatsApp desconectado
  mailer.ts        correo saliente (SMTP)
  access.ts        reglas de acceso por cuenta y rol
  auth.ts          usuarios, contraseñas (scrypt) y sesiones
  store/           acceso a PostgreSQL
migrations/        esquema SQL
public/            panel web: index.html + app.js (entrada) + js/*.js (20 módulos ES nativos, sin build: core, shell, bot, conversations, channels, automation, billing, …),
                   styles.css, widget del chat web (widget.js) y la guía del cliente (ayuda.html)
scripts/           check-frontend (imports del panel), test-backup, test-cli
test/              pruebas
```

## API (resumen)

Panel (bajo `/api`, con sesión por cookie; todo se limita a la cuenta del usuario):

- Sesión: `POST /api/login`, `GET /api/me`, `PUT /api/me/password`, `POST /api/me/resend-verification`
- Primeros pasos: `GET /api/onboarding`, `POST /api/onboarding/{business,assistant,import,step,whatsapp}` (`import` lee una web, archivo o texto y devuelve la propuesta de conocimiento)
- Consumo de IA: `GET /api/usage?month=AAAA-MM`, `/api/ai-prices` (superadmin)
- Cuentas: `/api/accounts`
- Usuarios: `/api/users`
- Chatbots: `/api/chatbots`, `/:id/duplicate`, `/:id/knowledge` (`POST /:id/knowledge/import`: propuesta, o guardado con `save`), `/:id/images`, `/:id/playground`, `/:id/test-message` (probador de palabras: reglas, activadores y desactivadores, sin IA)
- Canales: `/api/channels`, `/:id/setup`, `/:id/status`, `/:id/rotate-token`, `/:id/whatsapp/{session,connect,logout,test}` (`session`: crea la instancia si hace falta y devuelve el QR vigente o el código por número; el panel la consulta cada 3 s)
- Conversaciones: `/api/conversations`, `/:id/{takeover,release,close,send,send-image,reset-memory,automation,sequences}`
- Automatización: `/api/automations`, `/api/sequences`, `/api/campaigns` (`/:id/{preview,launch,cancel,recipients}`), `/api/settings`
- Agenda: `/api/services` (`/:id/slots`), `/api/appointments` (`/:id/cancel`), `/api/agenda/info`
- Notificaciones: `/api/notifications`, `/api/notifications/read`
- Contactos: `/api/contacts/:id`
- Registros, uso de IA y estadísticas: `/api/logs`, `/api/ai-runs`, `/api/stats`
- Cobro: `GET /api/billing`, `POST /api/billing/{checkout,confirm,portal,cancel}`, `/api/plans` (crear/editar: superadmin), `GET /api/billing/overview` (superadmin)
- Sistema: `GET /api/system/status` (superadmin)

Públicas:

- Registro y contraseñas: `GET /api/signup/info` (incluye los planes que se pueden pagar), `POST /api/signup` (con `plan` y `provider` opcionales: devuelve `checkout_url` para pagar en ese momento), `POST /api/verify-email`, `POST /api/forgot-password`, `POST /api/reset-password` (con límite de intentos por IP).
- Salud: `GET /health`, `GET /health/ready`. Cobro: `POST /webhook/billing/{stripe,mercadopago}` (firmados) y `GET /pago/{stripe,mercadopago}` (regreso desde la página de pago al panel).
- Webhooks: `GET|POST /webhook/:token`. El token es una URL secreta por canal; `GET` sirve para la verificación de Meta.
- Chat web: `/webchat/:token/{config,session,messages}`, con CORS y límite de 15 mensajes por minuto por sesión.
- Imágenes firmadas: `GET /media/:id?e=…&s=…`.
- Calendario: `GET /calendar/:token.ics`.

Actualización desde la versión anterior: la migración `002` pasa automáticamente todo a una "Cuenta principal" y convierte el WhatsApp de cada chatbot en un canal, **conservando la URL del webhook** para que Evolution siga funcionando sin reconfigurar.

## Operación y resiliencia

- Si PostgreSQL se reinicia, el backend se reconecta solo (no hace falta reiniciarlo).
- Si el backend se reinicia a mitad de una conversación, al arrancar retoma los mensajes sin responder de los últimos 15 minutos.
- Si la IA no responde ni al reintentar, el equipo recibe el aviso "⚠️ Un cliente espera respuesta" con el enlace a la conversación.
- Los webhooks salientes validan la IP de destino al conectar (bloquean la red interna, también ante DNS cambiante) y no siguen redirecciones.
- Detalles de la última auditoría y una lista de verificación para el servidor: [AUDITORIA.md](AUDITORIA.md).

## Notas y límites de esta versión

- La cola es durable y segura con varios procesos, sin Redis: cada conversación se atiende con un arrendamiento (*lease*) en PostgreSQL (un solo proceso a la vez) y un barrido cada 30 s retoma mensajes sin responder si se perdió un temporizador o un proceso murió a la mitad (ventana de 15 min; los errores de la IA no se reintentan en bucle). Los límites de intentos (inicio de sesión, registro, chat web) siguen siendo por proceso; con varias réplicas, cada una aplica el suyo. Detalle en [escalar y modelos](docs/escalar-y-modelos.md).
- La recuperación de conocimiento es por palabras clave por defecto y solo entra en juego si el conocimiento excede el presupuesto; con catálogos grandes activa la **búsqueda semántica** (pgvector) con `./riverrun semantic` (ver [activación](docs/semantic-activation.md)): conserva las palabras clave como respaldo si el proveedor falla.
- Se ignoran grupos, estados y canales de WhatsApp.
- El cobro es automático con Stripe y/o Mercado Pago (ver arriba). Sin ninguno configurado, sigue siendo manual: activas el plan en **Cuentas**.
- Los mensajes con más de 30 minutos de antigüedad (p. ej. al reconectar el teléfono) se guardan pero no se contestan automáticamente.
- Una conversación **cerrada** se reabre (con su memoria) cuando el cliente vuelve a escribir.
- La verificación cubre cifras, links, correos, teléfonos y afirmaciones de "tenemos / ofrecemos / incluye / aceptamos" (ver *Cómo decide y valida*). Lo que no sea una afirmación de ese tipo (tono, recomendaciones, matices) sigue dependiendo del prompt; el modo estricto añade un juez de IA para esos casos.
