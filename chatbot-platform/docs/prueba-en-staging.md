# Prueba en un servidor de pruebas

Lo que las pruebas automáticas no pueden comprobar sin un servidor real: la llave de datos, los respaldos cifrados, la
conversión de plantillas aislada, la actualización que espera al CI, `harden` y el bloqueo automático de IP. Cada paso
dice qué escribir y qué debe salir. Si algo no sale como dice, detente ahí y anota el mensaje completo.

Tiempo: unas 2 horas. Usa un servidor que se pueda tirar: nada de esto debe hacerse primero en producción.

## 0. Preparación

1. Un VPS nuevo de 2 GB con **Debian 12 o Ubuntu 24.04**. Si vas a usar AlmaLinux o Rocky en producción, repite la
   sección 8 en uno de esos.
2. Un dominio de prueba (por ejemplo `prueba.tudominio.com`) apuntando a su IP.
3. **Tu llave SSH** en la cuenta con la que entras (`ssh-copy-id usuario@IP`). Comprueba que entras sin contraseña:
   `ssh usuario@IP` no debe pedirla.
4. Abre **dos terminales** con SSH al servidor y no cierres la primera hasta terminar la sección 8.
5. Para recibir los avisos de seguridad (sección 7), define en `.env` `SMTP_URL` y `SUPERADMIN_EMAIL`, o
   `ALERT_WEBHOOK_URL`.
6. Instala:
   ```bash
   git clone <este repo> && cd Riverrun/chatbot-platform
   ./riverrun install
   ```
   Contesta con el dominio de prueba y tu correo.

## 1. Las llaves no se imprimen solas (INF-12)

| Haz | Debe salir |
|---|---|
| Lee la salida del `install` | La dirección del panel, tu usuario y la contraseña inicial. **No** deben aparecer `BACKUP_PASSPHRASE`, `SESSION_SECRET` ni `DATA_KEY`; sí la línea «Guarda las llaves fuera del servidor… ./riverrun keys las muestra». |
| `./riverrun keys` | Las llaves (`BACKUP_PASSPHRASE`, `SESSION_SECRET`, `DATA_KEY` y, si hay, `DATA_KEYS_OLD`). Guárdalas en tu gestor de contraseñas. |
| `./riverrun keys > /tmp/x` | Falla con «La salida no es una terminal…». `/tmp/x` queda vacío. |
| `./riverrun preflight` | Entre los avisos: «El servidor no se ha endurecido: sudo ./riverrun harden…». |

## 2. Respaldo cifrado (INF-11)

| Haz | Debe salir |
|---|---|
| `./riverrun backup` | Termina sin error. |
| `docker compose exec backup /usr/local/bin/backup.sh list` | Un archivo `riverrun-AAAAMMDD-HHMMSS.gpg.tar`. |
| `docker compose exec backup sh -c 'tar tf /backups/riverrun-*.gpg.tar \| head'` | Todas las partes terminan en `.gpg` (incluido `SHA256SUMS.gpg`). Ninguna en claro (`.sql`, o `.tar` sin `.gpg`). |
| `docker compose exec backup /usr/local/bin/backup.sh verify` | Lo da por bueno, sin errores. |

## 3. Restaurar

1. En el panel, crea un contacto de prueba llamado **«Prueba de respaldo»**.
2. `./riverrun backup`.
3. Borra ese contacto en el panel.
4. `./riverrun restore latest` y escribe `RESTAURAR`.

**Debe salir:** «Respaldo de seguridad hecho», luego la restauración sin errores y el sistema arriba. En el panel, el
contacto «Prueba de respaldo» volvió. Si conectaste WhatsApp antes del respaldo, sigue conectado sin escanear el QR.

## 4. Llave de datos separada (INF-6 e INF-7)

1. En el panel, activa la verificación en dos pasos en tu usuario y conecta un canal de prueba. Telegram es el más
   rápido: un bot de @BotFather.
2. `grep -c '^DATA_KEY=' .env` → `1`.
3. `./riverrun rotate-data-key` y escribe `ROTAR DATA_KEY`.

| Debe salir | Comprueba después |
|---|---|
| «DATA_KEY cambiada y todo re-cifrado…» y «DATA_KEYS_OLD conserva las anteriores…». | Entra al panel: tu código de 2FA funciona. Manda un mensaje al bot: el canal lo recibe y responde. `grep -c '^DATA_KEYS_OLD=' .env` → `1`. |

4. `./riverrun rotate-secret` y escribe `ROTAR SESSION_SECRET`.

**Debe salir:** «SESSION_SECRET cambiado…». Te saca del panel, y eso es lo esperado. Al volver a entrar, el 2FA y el
canal siguen funcionando **sin reconectar nada**.

## 5. Plantillas en su contenedor aparte (IN-6/7)

| Haz | Debe salir |
|---|---|
| `docker compose ps pdf` | El servicio `pdf` corriendo (`Up`). |
| En el panel: Cotizaciones → sube una plantilla DOCX y genera una cotización en PDF | El PDF se descarga y se ve bien. |
| `docker compose exec pdf env \| grep -Ei 'secret\|key\|password\|token'` | Nada: el convertidor no tiene secretos. |
| `docker compose exec pdf sh -c 'getent hosts example.com \|\| echo sin-red'` | `sin-red`: no sale a internet. |

## 6. Actualizar espera al CI (INF-4)

Cuando haya un cambio nuevo en `main` (o al día siguiente):

| Haz | Debe salir |
|---|---|
| `./riverrun update` | Antes de tocar nada, revisa el CI de ese commit en GitHub. Si está en verde, respalda y aplica; si está en rojo o corriendo, se detiene sin cambiar nada y lo dice. |
| Corta la salida a internet un momento y repite | «No se pudo consultar el CI… No se aplicó nada». |

## 7. Bitácora de seguridad y bloqueo automático (etapa 7)

1. Entra al panel → **Sistema → Seguridad**: deben verse tus entradas, el 2FA y las rotaciones.
2. Desde **otra conexión** (el teléfono con datos, no tu red: esa IP quedará bloqueada una hora), prueba una lista de
   contraseñas:
   ```bash
   for i in $(seq 1 10); do
     curl -s -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
       -d "{\"email\":\"lista$((i % 6))@ejemplo.mx\",\"password\":\"mala-$i\"}" https://prueba.tudominio.com/api/login
   done
   ```
   **Debe salir:** varios `401` y luego `429`.
3. Desde esa misma conexión, entra con **tu correo y tu contraseña buena**: también `429`, porque la IP está bloqueada.
4. Te llega el aviso «🔐 Muchos accesos fallidos desde una IP… Esa IP ya no puede entrar durante 60 minutos».
5. En Sistema → Seguridad, filtro **IP bloqueadas**: aparece la fila con su botón **Desbloquear**. Púlsalo: desde esa
   conexión ya puedes entrar.

## 8. Endurecer el servidor (`harden`)

**Con la primera terminal abierta todo el tiempo.**

1. `sudo ./riverrun harden` y confirma.

   **Debe salir:** «Actualizaciones de seguridad automáticas», «fail2ban vigila SSH», «SSH solo con llave», «Firewall
   activo…» y «Servidor endurecido».

2. **Desde la segunda terminal**, sin cerrar la primera:

| Haz | Debe salir |
|---|---|
| `ssh usuario@IP` | Entras con tu llave. **Si no entras, no cierres la primera terminal**: ahí corre `sudo rm /etc/ssh/sshd_config.d/01-riverrun.conf` y luego `sudo systemctl reload ssh` (en AlmaLinux/Rocky, `sudo systemctl reload sshd`), y avísame. |
| `ssh -o PubkeyAuthentication=no usuario@IP` | `Permission denied (publickey)`: ya no acepta contraseña. |
| `sudo ufw status` (en AlmaLinux/Rocky: `sudo firewall-cmd --list-all`) | Solo SSH, 80 y 443 permitidos. |
| `sudo fail2ban-client status sshd` | La cárcel `sshd` activa. |
| `systemctl status unattended-upgrades` (en AlmaLinux/Rocky: `systemctl list-timers 'dnf-automatic*'`) | Activo. |
| `curl -I https://prueba.tudominio.com` desde tu computadora | Responde: el panel sigue visible por HTTPS. |
| `./riverrun preflight` | Ya no avisa «no se ha endurecido». |

3. **Lo que publica Docker queda cerrado hacia afuera.** En el servidor:
   ```bash
   docker run -d --rm --name prueba-puerto -p 8099:80 nginx:alpine
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8099   # 200: desde el servidor sí responde
   ```
   Desde tu computadora, `curl --max-time 5 http://IP:8099` **no debe responder**. Después, `docker stop prueba-puerto`.

4. **Reinicia el servidor** (`sudo reboot`) y repite `ssh usuario@IP`, `curl -I https://prueba.tudominio.com` y el
   paso 3: todo debe seguir igual después de reiniciar.

## Al terminar

Anota cada sección como ✅ o ❌ con el mensaje que salió. Si todo es ✅, aplica lo mismo en producción en este orden:
`./riverrun update` → `./riverrun keys` (guarda las llaves) → `sudo ./riverrun harden` (con una sesión SSH abierta).
