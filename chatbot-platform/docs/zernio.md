# Zernio: una sola llave para todos los negocios

[Zernio](https://zernio.com) (antes Late) es una API unificada para redes sociales. La plataforma usa **una sola llave
de Zernio** (la del administrador de la instalación) y separa a cada negocio con **un perfil de Zernio por negocio**. Es
la arquitectura que Zernio recomienda para plataformas con muchos clientes.

## Cómo se separan los negocios

| Pieza | Dónde | Regla |
|---|---|---|
| Llave de la plataforma | `ZERNIO_API_KEY` en el `.env` o **Sistema → Redes sociales (Zernio)** (cifrada en `platform_secrets`) | Nunca sale al navegador; el `.env` manda. |
| Perfil por negocio | `accounts.zernio_profile_id` y `zernio_profiles` | `externalId` = id del negocio. Se crea al conectar la primera red, con `Idempotency-Key`; nunca dos. |
| Dueño de cada cuenta conectada | `social_accounts` (`zernio_account_id` único) | La única fuente de qué negocio es dueño de cada cuenta (mensajes, comentarios, publicaciones y estadísticas). |
| Conexión de mensajes | `channels` tipo `zernio` | Una cuenta de Zernio en un solo canal (índice único `channels_zernio_account_idx`). |

**Al conectar una red**, el retorno de Zernio (`/zernio/callback/...`) usa un estado de un solo uso que vence a los 30
minutos. La cuenta solo se guarda si Zernio confirma que está en el perfil de **ese** negocio (leído de la base, nunca de
la URL) y es de la red elegida. Armar el retorno a mano con la cuenta de otro negocio responde "no pertenece a este
negocio".

**Desde "Redes sociales"** (o con el enlace que le mandas al cliente) el retorno es `/zernio/return/<estado>`: el estado
se guarda solo como huella en `zernio_connect_sessions`. El del panel sirve una vez y vence a los 30 minutos; el del
enlace sirve 7 días y solo hasta que el cliente conecta (si cancela, puede volver a abrirlo). La regla de propiedad es la
misma: Zernio confirma que la cuenta está en el perfil del negocio y es de la red elegida.

**El negocio nunca ve identificadores**: la API devuelve `config.connected` y oculta `profile_id` y `account_id` (solo el
superadmin los ve). Nadie los puede escribir desde el formulario: solo el flujo de conexión.

## Eventos (webhook único)

Zernio permite máximo 50 webhooks por llave, así que hay **uno solo** para toda la instalación: `POST /zernio/events`,
firmado con `X-Zernio-Signature` (HMAC-SHA256 del cuerpo, con un secreto derivado de `SESSION_SECRET`).

1. Se verifica la firma.
2. Cada evento cuenta **una sola vez** por su id (`X-Zernio-Event-Id` o `id`; si no viene, la huella del cuerpo). Zernio
   reintenta hasta 7 veces con el mismo id y la firma no lleva hora: así un evento capturado no se puede repetir.
3. Los de más de 35 días no se aceptan.
4. Solo llega al canal de la cuenta **y del perfil** que dice el evento; uno de otro perfil se ignora y se registra.
5. Los mensajes (`message.received`, `message.sent`) se guardan al momento. Lo demás va a la cola `zernio_events` y se
   procesa después, para responder a Zernio en menos de 5 s:
   - `account.connected` / `account.disconnected`: estado del canal y de la cuenta, y aviso al negocio.
   - `message.delivered` / `message.read`: `messages.delivered_at` / `read_at`.
   - `message.failed`: el mensaje queda `failed` con `meta.error_code` (p. ej. `TEMPLATE_REQUIRED`).

Una cuenta conectada **directamente en Zernio** (por ti, en su panel) en el perfil de un negocio se **adopta**: aparece
como de ese negocio. Una de un perfil que no es de nadie se ignora.

## Redes sociales del negocio

En **Ajustes → Redes sociales** el negocio ve todas sus redes conectadas (foto, usuario y estado) y conecta otras:

- **Con mensajes directos** (X, Reddit, WhatsApp, Telegram, Bluesky, y Facebook e Instagram si no usas "Conectar con
  Facebook"): elige qué agente contesta. Se crea (o se reutiliza) su conexión de mensajes; al desconectar la red, la
  conexión se conserva con su historial y se vuelve a usar si la conecta de nuevo.
- **Sin mensajes directos** (LinkedIn, TikTok, YouTube, Threads, Pinterest, Google): quedan para comentarios,
  publicaciones y estadísticas.
- Con **"Conectar con Facebook"** activo (app de Meta propia), Facebook e Instagram por Zernio no contestan mensajes, para
  que no haya respuestas dobles.
- **Reconectar** usa `reconnectAccountId`: Zernio conserva la misma cuenta y su historial.
- Telegram y Bluesky terminan en su conexión (código para el bot o contraseña de aplicación).

Cada plan limita cuántas redes se conectan (`social_accounts` en **Planes y cobro**; en la prueba, `TRIAL_MAX_SOCIAL_ACCOUNTS`,
2 por omisión), por cualquier camino: "Redes sociales", la conexión de un agente o el enlace. Una red que ya no cabe se
quita de Zernio en el momento (para no pagar por ella) y el negocio ve el aviso de su plan. Reconectar una que ya tiene
no cuenta como nueva.

**Desconectar** quita la red primero en Zernio: si Zernio falla, se avisa y la red sigue como estaba (nunca queda
"desconectada" en el panel mientras sigue activa y cobrándose en Zernio).

## Llamadas por minuto compartidas

El límite de Zernio es de la llave (60 por minuto con 2 cuentas o menos, 600 hasta 2000 y 1200 con más), así que se
reparte entre todos los procesos con una cubeta en la base (`rate_buckets`), al 90 %. Si Zernio informa el límite real
(`X-RateLimit-Limit`), se usa ese:

- Lo que pide una persona (enviar, conectar) espera hasta 10 s si no hay lugar y luego sigue.
- Lo que corre solo (revisar perfiles, limpiar, sincronizar) deja siempre libre el 30 %; si no alcanza en 60 s, se
  reintenta después.
- Un 429 de Zernio vacía la cubeta: todos esperan a que se reponga.

`ZERNIO_RATE_PER_MIN` fija el número a mano.

## WhatsApp Business (API oficial)

**Conectar (alta guiada).** En **Redes sociales → WhatsApp Business** el panel explica qué se necesita y pregunta si el
negocio quiere **seguir usando la app WhatsApp Business en su teléfono**:

- *Sí* (`onboarding=business_app`, coexistencia): contesta desde el teléfono y el agente también responde en el panel.
- *No* (`onboarding=api`): el número queda solo en la API oficial (un número nuevo o que ya está en otra plataforma).

La autorización es la página de Zernio en español (`signup=hosted`, Embedded Signup de Meta) con la marca del negocio.
**Zernio permite un WhatsApp por perfil**: el segundo número de un negocio se conecta en un perfil adicional suyo
(`zernio_profiles`, `externalId` = `<negocio>:wa2`…); los mensajes de ese número llegan a su conexión.

**PIN de verificación en dos pasos.** Si el número tiene un PIN propio, Meta no deja enviar mensajes hasta registrarlo
(error 133005, o "(#200) You do not have the necessary permission"): botón **PIN** en la tarjeta del número
(`POST /accounts/{id}/whatsapp/register`). El PIN no se guarda.

**Plantillas** (**Redes sociales → Plantillas** del número):

- Se crean en el panel (tipo *Avisos y seguimiento* o *Promoción*, idioma, encabezado, mensaje con `{{1}}`, `{{2}}`…, un
  ejemplo por variable, pie y hasta 3 botones) y van a revisión de Meta (de minutos a 24 h).
- El aviso `whatsapp.template.status_updated` actualiza su estado (*Aprobada*, *Rechazada* con el motivo, *Pausada*…) y
  notifica a los administradores del negocio.
- **Traer de Meta** agrega las creadas fuera del panel y quita las borradas allá. **Borrar** la quita en Meta (el nombre
  no se puede reusar por 30 días).
- Las que tienen foto, video o documento en el encabezado, o variables con nombre, se ven pero se envían desde Meta.

**Fuera de las 24 h** solo se puede enviar una plantilla aprobada:

- Cada mensaje de una regla, una secuencia o una campaña puede llevar *Plantilla de WhatsApp si pasaron 24 h*. Dentro
  de la ventana sale el mensaje normal; fuera, la plantilla, con sus variables llenas con los datos del contacto
  (`{{nombre}}`, `{{telefono}}`…). Sin plantilla, el envío se omite con el motivo "elige una plantilla aprobada".
- En la conversación, el botón **Plantilla** la envía a mano (la persona toma la conversación) y un aviso indica
  cuándo pasaron las 24 h.
- La plantilla debe ser del mismo número de la conversación.

## Comentarios y reseñas

`src/social/engagement.ts` (eventos, revisión, acciones y respuesta automática), `src/social/replies.ts` (sugerencia de
la IA) y `src/routes/social-inbox.ts`; en el panel, **Comentarios** (`#/comentarios`), también para los agentes.

- **Llegan** por el webhook único (`comment.received`, `review.new`, `review.updated`) y por una **revisión diaria**
  (al conectar la red y luego una vez al día por cuenta, con prioridad baja): trae las publicaciones con comentarios de
  los últimos 30 días (solo abre las que cambiaron, hasta 5) y las reseñas. X no avisa de comentarios por webhook y las
  reseñas de Facebook tampoco: esas llegan solo por la revisión (o con **Revisar ahora**).
- **De quién son:** el evento se guarda solo si la cuenta conectada es de un negocio y el perfil (y su `externalId`, si
  viene) es del mismo negocio. Un comentario nunca adopta una cuenta. Cada comentario o reseña se guarda una vez; lo que
  ya se respondió, ocultó o ignoró no cambia al volver a llegar. Los comentarios del propio negocio no aparecen en la
  bandeja; si el negocio contesta desde la red, el comentario queda *respondido (desde la red)*.
- **Acciones** según la red: responder (todas las de comentarios), ocultar (Facebook, Instagram, Threads, X, TikTok),
  me gusta (Facebook, X, Bluesky, Reddit, LinkedIn; Instagram no lo permite por la API), eliminar (solo administradores)
  y **responder en privado** (Instagram y Facebook, una vez por comentario y hasta 7 días después). La respuesta privada
  llega a la conversación del cliente sin pausar al agente. Una respuesta no sale dos veces aunque se pulse dos veces
  (se aparta antes de llamar a la red y lleva `Idempotency-Key`). En `OUTBOUND_MODE=sandbox` no se publica nada.
- **IA:** *Sugerir respuesta* usa el conocimiento y la personalidad del agente (el de los ajustes de la cuenta, el de su
  canal o el primero activo) y cobra en Consumo de IA como «Respuestas a comentarios». Si la sugerencia trae una cifra,
  un enlace o un teléfono que no está en la información del negocio, se marca para revisión. Un mensaje delicado
  (riesgo de daño) no va a la IA: avisa al equipo al momento.
- **Respuesta automática** (por cuenta, en *Redes sociales → Respuestas a comentarios*; por omisión solo sugiere):
  contesta sola solo lo positivo, reciente (menos de 7 días), sin cifras inventadas, reseñas de 4 o 5 estrellas, con
  un tope de respuestas por hora (10 por omisión). Solo contesta comentarios a la publicación o respuestas a un
  comentario del negocio (no conversaciones entre clientes). Nunca contesta quejas, lo neutral, mensajes delicados, lo
  que llega por la revisión diaria ni si el negocio está suspendido. La respuesta pública no puede llevar enlaces,
  correos ni teléfonos que no estén en la información del negocio (aunque los traiga el comentario).
- **Si la red no contesta** (error del servidor o sin respuesta) no se sabe si la respuesta se publicó: queda apartada
  10 minutos (si salió, su eco la marca como respondida) y solo después se puede intentar otra vez.
- **Avisos:** un resumen cada 15 minutos como máximo con lo nuevo (se puede apagar); una reseña de 3 estrellas o menos
  avisa al momento. La primera revisión al conectar no avisa de lo viejo.
- **Datos:** los comentarios y reseñas se borran con la retención de mensajes del negocio y al desconectar la red se
  conservan hasta que se borra la cuenta conectada. El panel nunca ve ids de Zernio ni de la red.
- **Zernio:** necesita el complemento *Inbox* en la cuenta de Zernio de la plataforma (sin él, Zernio responde 403 y el
  panel lo explica). Las lecturas de comentarios y reseñas tienen su propio tope en Zernio (1800 por hora por cuenta de
  Zernio); por eso la revisión diaria va de pocas cuentas a la vez y el panel lee de la base, no de Zernio.

## Publicaciones

`src/social/posts.ts` y `src/routes/social-posts.ts`; en el panel, **Publicaciones** (`#/publicaciones`, solo
administradores), con lista por día y calendario del mes.

- **Escribir una vez:** texto general, fotos o video y las cuentas donde sale; cada cuenta puede llevar su propio texto
  y, según la red, título (YouTube, Pinterest, Reddit) o enlace (Pinterest). El contador de cada red se pone en rojo si
  se pasa (X 280 sin cuenta de pago, Bluesky 300, Threads 500, LinkedIn 3000, Google 1500, Instagram y TikTok 2200…) y
  avisa si falta la foto (Instagram, TikTok, Pinterest) o el video (YouTube). El servidor valida lo mismo antes de
  llamar a Zernio; un borrador puede quedar incompleto.
- **Archivos:** se suben al servidor, se revisa su tipo real (JPG, PNG, WEBP o MP4) y se pasan a Zernio con la extensión
  correcta. Cada archivo queda firmado para el negocio: una publicación no puede usar archivos de otro ni direcciones
  inventadas.
- **Publicar ya o programar** a una hora del horario del negocio (al menos 2 minutos adelante; 20 con YouTube, que sube
  el video antes). TikTok llega a la bandeja de la cuenta (Creator Inbox) y se termina en la app. Zernio acepta 25
  publicaciones por hora en cada cuenta; el panel lo avisa antes.
- **Un solo envío:** el formulario lleva un id (enviarlo dos veces devuelve la misma publicación), la publicación se
  aparta mientras se habla con Zernio y cada envío lleva `Idempotency-Key`. Si Zernio no contesta, queda *Enviando…* y
  la revisión la vuelve a mandar con la misma llave (Zernio no la duplica) o, pasadas 23 h, la marca como fallida.
- **Estado por red:** Zernio avisa por el webhook (`post.*` y `post.platform.*`, sin cuenta arriba: se ubica por el id de
  la publicación y se exige que el perfil del evento sea del negocio) y, si no avisa, una revisión le pregunta. Un
  evento más viejo no cambia lo guardado; una red publicada solo pasa a fallida si Zernio lo dice después. Si falla
  alguna red, el equipo recibe un aviso (una vez) y se puede **reintentar**.
- **Cambiar o cancelar** lo programado (hasta 2 minutos antes): primero se cambia en Zernio (`PUT` con todo, o con
  "publicar ya", o como borrador) y solo si Zernio lo acepta se guarda aquí; si falla, queda como estaba. No se borra
  para volver a crearla: Zernio borraría también sus archivos. Cancelar sí la quita de Zernio (y sus archivos: al
  duplicar una cancelada hay que volver a subirlos). Lo publicado no se cancela; se puede quitar de la lista (en la red
  sigue). Al borrar un negocio, lo programado se quita de Zernio.
- **Si la red la rechaza** (cuenta desconectada, contenido repetido…), queda como borrador con el motivo; corregirla y
  volver a enviarla desde el mismo formulario la manda de nuevo. Si el rechazo llega en un reenvío automático, se avisa
  al equipo. La revisión de cada publicación queda anotada antes de llamar a Zernio y no se rinde si Zernio falla.
- En `OUTBOUND_MODE=sandbox` solo se guardan borradores. Un negocio suspendido o en pausa no publica.

## Estadísticas y salud

`src/social/stats.ts` y `src/social/health.ts`; en el panel, **Reportes → Redes sociales** (`#/estadisticas/redes`,
administradores), el estado de cada red en **Ajustes → Redes sociales** y la tarjeta *Salud de las redes* en
**Sistema → Zernio**.

- **Salud (cada 6 h, una réplica por vuelta):** una sola llamada a `GET /accounts/health` para todas las cuentas.
  - Una cuenta que Zernio marca para reconectar queda *Hay que reconectarla*. Si tiene canal de mensajes, el canal se
    cierra y avisa como cualquier desconexión; si no, los administradores del negocio reciben **un** aviso (notificación
    con enlace a Redes sociales y correo) que agrupa las redes caídas.
  - Al recuperarse vuelve a *Conectada* y el canal se reabre. Las cuentas que Zernio no menciona no se tocan.
  - Meta a veces marca un permiso como vencido sin serlo: hace falta verlo **dos veces seguidas** para darlo por caído.
  - Si se caen más de 5 cuentas y más de la mitad a la vez, parece un problema de Zernio: no se marca ninguna y se
    abre una incidencia para el superadministrador.
  - **Permiso por vencer** (Instagram, Facebook, Threads y LinkedIn, que no lo renuevan solos): un aviso entre 7 y 1 días
    antes, una vez por fecha de vencimiento. La red muestra *Su permiso vence pronto* y el botón *Reconectar*.
  - **Webhook:** Zernio lo apaga tras días de fallas. La revisión lo reactiva (con su secreto) y abre una incidencia con
    aviso al superadministrador; al verlo bien la cierra y avisa que se recuperó.
- **Estadísticas (una vez al día por cuenta, repartidas en el día y con prioridad baja):**
  - Seguidores con `GET /accounts/follower-stats` (hasta 50 cuentas por llamada) y, por día, impresiones, alcance,
    interacciones (me gusta + comentarios + compartidos + guardados), vistas, clics y publicaciones con
    `GET /analytics/daily-metrics?attribution=received` (lo que pasó ese día, no lo de los posts de ese día). Google
    usa `GET /analytics/googlebusiness/performance` (impresiones en Búsqueda y Maps; llamadas, sitio web y rutas como
    interacción).
  - La primera vez trae 35 días; después, los últimos 7 (las redes corrigen cifras unos días). Los días son UTC y se
    guardan por cuenta y día (`social_account_stats`, 400 días); repetir no duplica ni borra lo que ya estaba.
  - Las estadísticas de Zernio son un complemento de pago: si la llave no lo tiene, se anota, no se vuelve a intentar en
    24 h y el panel lo explica. Si Zernio está ocupado, la cuenta queda para la siguiente vuelta.
- El negocio solo ve sus redes, en palabras (sin ids de Zernio ni detalles técnicos).

## Ventana de 24 horas

Solo Meta la exige: Instagram, Messenger y WhatsApp oficial. Fuera de las 24 h desde el último mensaje del cliente no se
envían campañas ni avisos por esas redes. Telegram, X, Bluesky y Reddit no la tienen.

## Manual del administrador

- **Activar las redes:** pega la llave en **Sistema → Redes sociales (Zernio)** y pulsa *Guardar y probar*. Se prueba
  con Zernio antes de guardarla y se registra el webhook (requiere `PUBLIC_BASE_URL` en HTTPS y `SESSION_SECRET`).
- **Salud de las redes** (Sistema → Zernio): cuántas cuentas están bien, con aviso o con problema, cuáles hay que
  reconectar y desde cuándo, el estado del webhook y si la llave tiene el complemento de estadísticas. *Revisar ahora*
  no espera la vuelta de 6 h (máximo 6 por minuto).
- **Probar y reparar:** vuelve a enviar el webhook completo (URL, eventos y secreto). Úsalo si cambiaste
  `SESSION_SECRET` o el dominio, o si Zernio apagó el webhook. También revisa que los perfiles de los negocios sigan
  existiendo; los que ya no existan quedan sin perfil y sus redes, por reconectar (el negocio recibe el aviso).
- **Cambiar la llave a la de otra cuenta de Zernio:** el panel avisa cuántos negocios tienen redes y pide confirmar.
  Al confirmar, esos negocios quedan sin perfil y sus redes, por reconectar.
- **Página Zernio (Sistema → Zernio → "Negocios, enlaces y webhook"):** cada negocio con su perfil, sus redes (con su
  estado) y los mensajes que envió este mes por Zernio, más el costo estimado y las llamadas disponibles ahora.
- **Crear el perfil de un negocio** antes de que conecte nada: botón *Crear perfil*.
- **Mandarle un enlace al cliente:** *Enlace de conexión* → elige la red → *Crear enlace* y cópialo. El cliente lo abre
  sin iniciar sesión, ve tu marca (nombre, color y logo de su marca blanca) y autoriza su red. Sirve 7 días y deja de
  servir al conectar. Telegram y Bluesky no se conectan con enlace (necesitan su conexión de mensajes).
- **Conectar una red tú mismo:** en el panel de Zernio, dentro del perfil del negocio (`externalId` = id del negocio).
  Se adopta sola en cuanto Zernio avisa, o al pulsar *Sincronizar*.
- **Sincronizar:** trae de Zernio las cuentas del perfil; adopta las nuevas y marca *desconectadas* las que ya no están
  (avisando en su conexión de mensajes). Solo marca desconectadas con la lista completa de Zernio, y nunca las que
  cambiaron mientras sincronizaba.
- **Desconectar todo:** quita en Zernio todas las redes del negocio (p. ej. si dejó de pagar). El perfil se conserva.
- **Webhook:** *Ver entregas* muestra lo que Zernio intentó enviar en los últimos 30 días; *Reenviar* repite una entrega
  fallida (con el mismo id: si ya se había procesado, no se duplica).
- **Perfiles sin dueño:** perfiles de tu cuenta de Zernio que no son de ningún negocio (de negocios borrados o creados a
  mano). Revísalos en Zernio si cuestan.
- **Borrar un negocio:** sus redes y su perfil se quitan de Zernio en un trabajo aparte (`zernio_cleanup`), con
  reintentos, para no seguir pagando por ellas.
- **Costos:** Zernio cobra por cuenta conectada (las 2 primeras, gratis) y por mensajes salientes (10 000 al mes
  gratis). Los paga la plataforma.
