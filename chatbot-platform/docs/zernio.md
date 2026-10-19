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

## Ventana de 24 horas

Solo Meta la exige: Instagram, Messenger y WhatsApp oficial. Fuera de las 24 h desde el último mensaje del cliente no se
envían campañas ni avisos por esas redes. Telegram, X, Bluesky y Reddit no la tienen.

## Manual del administrador

- **Activar las redes:** pega la llave en **Sistema → Redes sociales (Zernio)** y pulsa *Guardar y probar*. Se prueba
  con Zernio antes de guardarla y se registra el webhook (requiere `PUBLIC_BASE_URL` en HTTPS y `SESSION_SECRET`).
- **Probar y reparar:** vuelve a enviar el webhook completo (URL, eventos y secreto). Úsalo si cambiaste
  `SESSION_SECRET` o el dominio, o si Zernio apagó el webhook. También revisa que los perfiles de los negocios sigan
  existiendo; los que ya no existan quedan sin perfil y sus redes, por reconectar (el negocio recibe el aviso).
- **Cambiar la llave a la de otra cuenta de Zernio:** el panel avisa cuántos negocios tienen redes y pide confirmar.
  Al confirmar, esos negocios quedan sin perfil y sus redes, por reconectar.
- **Conectar una red por un cliente:** puedes conectarla tú en el panel de Zernio, dentro del perfil del negocio
  (`externalId` = id del negocio). Se adopta sola en cuanto Zernio avisa.
- **Borrar un negocio:** sus redes y su perfil se quitan de Zernio en un trabajo aparte (`zernio_cleanup`), con
  reintentos, para no seguir pagando por ellas.
- **Costos:** Zernio cobra por cuenta conectada (las 2 primeras, gratis) y por mensajes salientes (10 000 al mes
  gratis). Los paga la plataforma.
