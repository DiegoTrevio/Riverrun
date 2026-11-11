# Publicar Riverrun en DigitalOcean

Guía de principio a fin para dejar Riverrun en internet en un servidor (Droplet) de DigitalOcean, con tu dominio,
HTTPS, correo, respaldos y avisos. Tiempo: unas 2 horas la primera vez. Lo que dice **Tú** lo haces en una página web
o en tu computadora; lo que está en un bloque de código lo escribes en el servidor.

El detalle de cada pieza está en [produccion.md](produccion.md); aquí va solo el camino, en orden.

## 0. Lo que necesitas antes de empezar

| Qué | Para qué | Dónde |
|---|---|---|
| Cuenta de DigitalOcean con tarjeta | El servidor | digitalocean.com |
| Un dominio (por ejemplo `tumarca.com`) | La dirección del panel y HTTPS (obligatorio para Telegram, Messenger, Instagram y el chat web) | Cualquier registrador |
| Llave de OpenRouter con saldo | La IA que contesta | openrouter.ai → Keys |
| Cuenta de Resend con tu dominio verificado | Correos: verificación, recuperar contraseña y avisos | resend.com → Domains y API Keys |
| Llaves de Cloudflare Turnstile (gratis) | Captcha del registro público; sin ellas el registro queda cerrado | dash.cloudflare.com → Turnstile |
| Un chequeo en healthchecks.io (gratis) | Te avisa si el servidor completo se cae | healthchecks.io |
| Un gestor de contraseñas | Guardar las llaves que el servidor no debe ser el único en tener | El que uses |

Opcionales, cuando los vayas a usar: Stripe, Mercado Pago y Facturapi (cobro y facturas), la app de Meta (Facebook e
Instagram con un botón) y Zernio (otras redes). Sus pasos están en [produccion.md](produccion.md#pasar-a-cobro-real),
en el [README](../README.md#facebook-e-instagram-con-un-botón-app-de-meta-de-la-plataforma) y en [zernio.md](zernio.md).

## 1. Crear el servidor (Tú)

1. Si no tienes llave SSH en tu computadora, créala: `ssh-keygen -t ed25519` (Enter a todo) y copia lo que imprime
   `cat ~/.ssh/id_ed25519.pub`.
2. En DigitalOcean: **Create → Droplets**.
   - **Region:** la más cercana a tus clientes (para México, *San Francisco* o *New York*).
   - **Image:** Ubuntu 24.04 (LTS) x64.
   - **Size:** *Basic → Regular*, **4 GB de RAM / 2 CPU**. Con 2 GB cabe, pero queda justo: PostgreSQL, WhatsApp
     (Evolution), el convertidor de PDF de las cotizaciones y el backend corren juntos.
   - **Authentication:** *SSH Key* → *New SSH Key* → pega tu llave pública. No uses contraseña.
   - Activa **Backups** (copia semanal de todo el disco; es aparte de los respaldos de Riverrun y sirve si el disco
     se daña).
   - **Hostname:** por ejemplo `riverrun`.
3. Cuando esté listo, copia su **IP pública** (ipv4).
4. Recomendado: en el Droplet → **Networking → Reserved IP** asígnale una IP fija. Así, si algún día reconstruyes el
   servidor, el dominio no cambia. Si la asignas, usa esa IP en el paso 2.

## 2. Apuntar el dominio (Tú)

En el registrador de tu dominio (o en **Networking → Domains** de DigitalOcean si delegas el dominio ahí), crea un
registro **A**:

| Tipo | Nombre | Valor |
|---|---|---|
| A | `app` (o el subdominio que quieras; `@` para el dominio solo) | la IP del paso 1 |

Comprueba desde tu computadora que ya responde con la IP: `nslookup app.tumarca.com`. Puede tardar unos minutos.
No sigas hasta que salga la IP correcta: el certificado HTTPS se pide al instalar y falla si el dominio aún no apunta.

## 3. Instalar Riverrun (en el servidor)

Entra desde tu computadora: `ssh root@IP` (la primera vez pregunta si confías en el servidor: escribe `yes`).

```bash
apt-get update && apt-get -y upgrade
git clone https://github.com/DiegoTrevio/Riverrun.git
cd Riverrun/chatbot-platform
./riverrun install
```

Si el repositorio es privado, `git clone` pide usuario y contraseña de GitHub: usa tu usuario y un *token* (GitHub →
Settings → Developer settings → Personal access tokens, con permiso de solo lectura del repositorio).

El instalador:

- Ofrece instalar Docker (responde `s`).
- Pregunta el **dominio** (`app.tumarca.com`), **tu correo** (serás el superadministrador) y la **llave de OpenRouter**.
- Pregunta el correo saliente (`SMTP_URL`): **déjalo vacío** (Enter) y configúralo en el paso 4 con Resend.
- Genera solo todas las contraseñas internas, levanta los servicios, pide el certificado HTTPS y al final imprime la
  dirección del panel, tu usuario y la **contraseña inicial**. Anótala.

Guarda en tu gestor de contraseñas las llaves que imprime:

```bash
./riverrun keys
```

Sin `BACKUP_PASSPHRASE` no se puede abrir ningún respaldo, y sin `DATA_KEY` no se leen los datos cifrados: si el
servidor se pierde y no las tienes, se pierde todo.

## 4. Correo, avisos y captcha (en el servidor)

**DigitalOcean bloquea la salida a los puertos de correo 25, 465 y 587** en las cuentas nuevas. Por eso:

- Con **Resend** (recomendado) basta con su llave: Riverrun ya usa el puerto 2465, que no está bloqueado.
- Con otro proveedor, usa su puerto alterno en `SMTP_URL`, por ejemplo `smtp://usuario:clave@smtp-relay.brevo.com:2525`
  (Brevo, Mailgun y SendGrid aceptan el 2525).

Edita el archivo de configuración con `nano .env` (guardar: Ctrl+O, Enter; salir: Ctrl+X) y pon estos valores:

```bash
RESEND_API_KEY=re_...                                # resend.com → API Keys
MAIL_FROM=Tu Marca <no-responder@tumarca.com>        # del dominio que verificaste en Resend
SIGNUP_REQUIRE_EMAIL=true                            # el instalador la apagó al no tener correo: vuelve a encenderla
SUPERADMIN_EMAIL=tu@correo.com                       # aquí te llegan los avisos urgentes
HEARTBEAT_URL=https://hc-ping.com/...                # healthchecks.io → tu chequeo → la URL de ping
TURNSTILE_SITE_KEY=0x...                             # Cloudflare → Turnstile → agrega tu dominio
TURNSTILE_SECRET_KEY=0x...
```

Aplica los cambios (antes revisa que no haya problemas críticos):

```bash
./riverrun restart
```

## 5. Copia de los respaldos fuera del servidor (Tú y el servidor)

Riverrun respalda cada noche, cifrado, pero en el mismo disco. Para que sobreviva si el servidor se pierde, cópialo a
**DigitalOcean Spaces** (almacenamiento tipo S3):

1. **Tú:** *Spaces Object Storage → Create Bucket*, en la misma región, privado. Luego *API → Spaces Keys →
   Generate New Key*; copia la llave y el secreto.
2. **Servidor:** agrega a `.env`:

   ```bash
   BACKUP_S3_PROVIDER=DigitalOcean
   BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com   # la región de tu bucket
   BACKUP_S3_BUCKET=nombre-del-bucket
   BACKUP_S3_KEY=...
   BACKUP_S3_SECRET=...
   ```

3. `./riverrun restart` y luego un respaldo de prueba: `./riverrun backup`. En `./riverrun status` debe salir el
   respaldo nuevo y su copia en la nube.

## 6. Endurecer el servidor (en el servidor)

Firewall (solo entran SSH, 80 y 443, también para lo que publica Docker), SSH solo con llave, fail2ban y
actualizaciones de seguridad automáticas:

```bash
sudo ./riverrun harden
```

**Antes de cerrar tu sesión**, abre otra terminal y comprueba que sigues entrando con `ssh root@IP`. Si no entra, en
la primera sesión revisa lo que dijo `harden`; DigitalOcean también tiene la consola web del Droplet (*Access →
Launch Droplet Console*) por si te quedas fuera.

## 7. Revisión antes de abrir (en el servidor)

```bash
./riverrun preflight
```

Debe terminar en **APROBADO CON ADVERTENCIAS** o mejor, sin ningún ✕. Revisa cada `!`:

- «Correo: no se pudo conectar…» significa que el puerto del correo está bloqueado: vuelve al paso 4.
- «update no exige firma» es normal si mezclas los cambios con el botón de GitHub (ver
  [Firma de las actualizaciones](produccion.md#firma-de-las-actualizaciones)).

Después, desde tu navegador:

1. Abre `https://app.tumarca.com`, entra con tu correo y la contraseña inicial y configura la verificación en dos
   pasos (te la pide al entrar). Cambia la contraseña en **Mi perfil**.
2. **Sistema → Correo saliente → Mandarme un correo de prueba**: debe llegarte.
3. Crea un agente de prueba, vincula un WhatsApp con el QR y mándale un mensaje desde otro teléfono.
4. Genera una cotización de prueba y descarga su PDF.
5. En healthchecks.io el chequeo debe aparecer en verde.

## 8. Protege el repositorio (Tú, en GitHub)

En GitHub → el repositorio → **Settings → Branches → Add rule** para `main`: exigir pull request y CI en verde, sin
force push ni borrado. Activa la verificación en dos pasos de tu cuenta de GitHub. Quien pueda escribir en `main`
decide qué se instala en el servidor con `./riverrun update`.

## Después: el día a día

| Para | Escribe en el servidor |
|---|---|
| Ver cómo está todo | `./riverrun status` |
| Instalar la versión nueva de `main` | `./riverrun update` (respalda, aplica y, si algo falla, vuelve sola a la anterior) |
| Ver registros | `./riverrun logs backend` |
| Recuperar tu acceso si pierdes el teléfono | `./riverrun admin-password` |

Una vez al mes, corre el [simulacro de restauración](produccion.md#simulacro-de-restauración) en otra máquina para
confirmar que los respaldos de Spaces sí se abren.

## Si algo sale mal

| Qué ves | Qué hacer |
|---|---|
| El panel no abre con HTTPS después de instalar | El dominio todavía no apunta a la IP (paso 2), o los puertos 80 y 443 están cerrados por un firewall de DigitalOcean (*Networking → Firewalls*). Corrígelo y corre `./riverrun restart`; `./riverrun logs caddy` muestra por qué no salió el certificado. |
| No llegan correos | `./riverrun preflight` dice si el servidor llega al puerto del correo. En Resend, revisa que el dominio esté verificado y que `MAIL_FROM` sea de ese dominio. |
| El asistente no contesta | Revisa la llave y el saldo de OpenRouter; `./riverrun status` lo muestra. |
| Cualquier otra cosa | La tabla [Qué hacer ante cada fallo](produccion.md#qué-hacer-ante-cada-fallo). |
