# Seguridad, etapa 2: identidad — diseño

**Fecha:** 30 de octubre de 2026 · **Base:** `claude/seguridad-etapa-1` (PR #90) · **Hallazgos:** ID-2…ID-10 de
[`docs/seguridad.md`](../../seguridad.md), más lo que la auditoría marcó como «capacidades que faltan» (2FA,
verificación reciente para acciones sensibles, avisos por correo, contraseñas filtradas).

Se entrega en dos PR, cada uno con pruebas que fallan con el código anterior:

- **2a · Acceso:** verificación en dos pasos, códigos de recuperación, recordar dispositivo, verificación reciente,
  contraseñas, límites de intentos en la base, caducidad de sesiones, peticiones de otros sitios, avisos de seguridad.
- **2b · Cuenta:** dueño distinto de administrador, transferir la cuenta, correo verificado de verdad, bajas que
  limpian lo que la persona dejó, invitaciones con límites y los bajos ID-7…ID-10.

## Lo que cambia para la gente

- Todos (dueño, administradores, agentes y superadministrador) entran con contraseña **y** un código de 6 dígitos de
  una app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…). La primera vez el panel guía la
  configuración y entrega 10 códigos de recuperación.
- Se puede marcar «Recordar este dispositivo 30 días»: en ese navegador basta la contraseña. El superadministrador
  siempre escribe el código.
- Cambiar la contraseña, el correo, el plan o la tarjeta, crear llaves de API, borrar la cuenta y otras acciones
  delicadas piden el código otra vez si pasaron más de 15 minutos desde el último.
- Contraseñas de 12 caracteres como mínimo, que no aparezcan en filtraciones conocidas.
- La sesión se cierra tras 12 horas sin usar el panel (30 minutos para el superadministrador) y dura 7 días como
  máximo (12 horas para el superadministrador).
- Llega un correo cuando cambia la contraseña, el correo o la verificación en dos pasos, y cuando alguien entra desde
  un dispositivo nuevo.
- Solo el dueño de la cuenta maneja el dinero (plan, tarjeta, facturación), borra o exporta la cuenta, administra a
  los otros administradores y puede transferir la cuenta. Los administradores siguen con agentes, asistente, canales y
  conversaciones.
- Un administrador ya no escribe la contraseña de otra persona: la invita y ella elige la suya.
- Como no se ha lanzado, al desplegar todos vuelven a entrar y configuran su verificación en dos pasos.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Quién usa 2FA | Todos, obligatorio, desde el primer inicio de sesión |
| Método | Código TOTP de una app (sin SMS: se puede robar la línea) |
| Recordar dispositivo | 30 días; nunca para el superadministrador; se olvida al cambiar la contraseña, restablecer el 2FA o «cerrar todas las sesiones» |
| Verificación reciente | 15 minutos |
| Poderes del dueño | Dinero y la cuenta: plan, tarjeta, facturación, borrar y exportar la cuenta, administrar a otros administradores, transferir |
| Contraseñas filtradas | Have I Been Pwned por rango (solo salen los primeros 5 caracteres del hash SHA-1) + lista local de las 100 000 más comunes, que también cubre cuando HIBP no responde |
| Sesiones | Equipo: 12 h sin uso, 7 días máximo. Superadministrador: 30 min sin uso, 12 h máximo |
| Recuperación | El dueño restablece el 2FA de su equipo; el superadministrador, el de cualquiera; `./riverrun admin-password` también restablece el del superadministrador |

---

## PR 2a · Acceso

### 2a.1 Verificación en dos pasos (TOTP)

- RFC 6238 con `node:crypto` (sin dependencia): SHA-1, 6 dígitos, pasos de 30 s, se acepta el paso anterior y el
  siguiente. Un código ya usado no vuelve a servir: se guarda el último paso aceptado (`users.totp_last_step`) y se
  rechaza todo paso igual o anterior, también entre dos peticiones simultáneas (se actualiza con
  `UPDATE … WHERE totp_last_step < $paso`).
- Secreto de 20 bytes aleatorios, guardado cifrado con `encryptSecret` (AES-256-GCM, llave derivada de
  `SESSION_SECRET`). Nunca se devuelve después de configurarlo.
- **`./riverrun rotate-secret`** re-cifra los secretos de 2FA (activos y pendientes) antes de cambiar `SESSION_SECRET`:
  un comando `dist/cli/rekey-mfa.js` que descifra con el secreto actual (el de su entorno) y recibe el nuevo por la
  entrada (no queda en la lista de procesos), en una transacción con `FOR UPDATE`; si uno no se puede leer, no cambia
  nada y `.env` conserva el secreto anterior. Sin esto, rotar el secreto dejaría a todos fuera. Las demás credenciales
  cifradas siguen como hoy hasta la etapa 6.
- Código QR para la app: se genera en el servidor como SVG con `qrcode-generator` (sin dependencias, versión fija). El
  panel también muestra el secreto en texto para escribirlo a mano. La URI `otpauth://` lleva como emisor el nombre de
  la marca de la cuenta (la misma de sus correos; «Panel de Chatbots» si no tiene) y como cuenta el correo.
- Mientras configura (o cambia de app), el secreto queda pendiente (`totp_pending`, `totp_pending_at`): durante una
  hora, recargar, abrir otra pestaña o volver a entrar muestra el mismo QR, para que la app ya escaneada siga sirviendo;
  después se cambia por uno nuevo (nadie que sepa la contraseña deja uno preparado para cuando la persona lo configure).

### 2a.2 Códigos de recuperación

- 10 códigos de 12 caracteres (base32 de Crockford, unos 60 bits cada uno), mostrados como `xxxx-xxxx-xxxx`. Se
  guardan solo sus hashes SHA-256 (tabla `user_recovery_codes`). Cada uno sirve una vez.
- Se muestran al terminar la configuración, con «Copiar», «Descargar .txt» y «Ya los guardé» (el panel no avanza
  sin confirmar).
- Usar uno manda un aviso por correo y el panel dice cuántos quedan; con 2 o menos, un aviso fijo en Mi perfil.
- «Generar códigos nuevos» (con verificación reciente) invalida los anteriores.

### 2a.3 Cómo se entra: las cinco puertas

Hoy hay cinco lugares que abren una sesión: contraseña (`admin.ts:74`), cambio de contraseña (`admin.ts:142`),
invitación aceptada (`invitations.ts:216`), Google (`google-login.ts:75` y `:141`) y registro (`signup.ts:114`).
Todos pasan por una sola función, `beginLogin(reply, user, via)`, que decide:

1. Si la persona tiene 2FA y el navegador trae un dispositivo recordado válido para ella (y no es superadmin): sesión
   completa.
2. Si tiene 2FA: no hay sesión todavía. Se pone una cookie de reto (`cp_mfa`, firmada, HttpOnly, 15 minutos para
   dar tiempo a instalar la app, con `uid`, versión de contraseña, `via`, propósito `verify` y un identificador de
   reto) y se responde `{ mfa: 'verify' }`.
3. Si no tiene 2FA: igual, con propósito `enroll` y respuesta `{ mfa: 'enroll' }`.

`setSessionCookie` deja de exportarse: solo la llaman `beginLogin` (caso 1) y la terminación del reto. Una prueba por
puerta comprueba que sin código no hay sesión.

Rutas del reto (solo funcionan con la cookie de reto; no aceptan una sesión):

- `POST /api/login/2fa { code, remember? }`: código TOTP o de recuperación. Cinco intentos por reto; después hay que
  volver a escribir la contraseña. Éxito: sesión completa, se borra el reto y, si pidió recordar (y no es superadmin),
  cookie de dispositivo recordado.
- `GET /api/2fa/enroll`: crea (o reemplaza) un secreto pendiente (`users.totp_pending`, cifrado) y devuelve
  `{ secret, otpauth, qr }` (`qr` es una imagen SVG como `data:`; la CSP del panel ya permite `img-src data:`).
- `POST /api/2fa/enroll { code }`: comprueba el código contra el pendiente, lo activa (`totp_secret`,
  `totp_enabled_at`), genera los 10 códigos de recuperación y abre la sesión completa. Devuelve los códigos.

Detalles de cada puerta:

- **Google** no cuenta como segundo paso (es otro primer paso). El regreso de Google pone la cookie de reto y
  redirige a `/#/login/codigo`.
- **Invitación y registro:** la persona elige su contraseña (o entra con Google) y pasa a configurar el 2FA antes de
  ver el panel. El orden completo del registro (captcha → correo → 2FA → pago) se cierra en la etapa 3.
- **Cambio de contraseña** (`PUT /api/me/password`): pide la contraseña actual y verificación reciente; la sesión
  nueva conserva la verificación; se cierran las demás sesiones y se olvidan los dispositivos recordados.
- **Restablecer la contraseña por correo** ya no abre sesión: después se entra normal, con código. Cierra todas las
  sesiones y olvida los dispositivos.

Las llaves de API y los webhooks de entrada no cambian: no usan sesión.

### 2a.4 Dispositivos

Una tabla `user_devices` con dos usos:

- **Dispositivo conocido** (`cp_device`, 1 año, valor aleatorio; se guarda su hash): si alguien entra desde uno que
  esa persona no había usado, le llega un correo «Nuevo inicio de sesión» con fecha, navegador e IP, y cómo cerrar
  todas las sesiones.
- **Dispositivo recordado** (`cp_trust`, 30 días, valor aleatorio aparte; se guarda su hash y `trusted_until`):
  solo salta el código, nunca la contraseña. Ligado a la persona y a su versión de contraseña. Mi perfil lista los
  recordados (navegador, último uso) con «Olvidar».

Se olvidan todos los recordados al cambiar o restablecer la contraseña, al restablecer el 2FA, al «cerrar todas las
sesiones» y al dar de baja a la persona. Entrar con un dispositivo recordado no da verificación reciente.

### 2a.5 Verificación reciente (15 minutos)

- `user_sessions.mfa_at`: cuándo escribió el código por última vez en esa sesión.
- Las rutas delicadas se marcan con `config: { stepUp: true }` y un gancho responde `403 { code: 'step_up' }` si
  `mfa_at` tiene más de 15 minutos o está vacío.
- `POST /api/2fa/step-up { code }` actualiza `mfa_at`. El panel, al recibir `step_up`, abre una ventana que pide el
  código y repite la petición una vez.
- Rutas marcadas (una prueba recorre la lista y comprueba cada una):
  - Mi perfil: cambiar contraseña, cambiar correo (2b), cambiar de autenticador, generar códigos nuevos.
  - Equipo: invitar o cambiar a administrador, cambiar rol, desactivar o borrar a alguien, restablecer su 2FA.
  - Integraciones: crear o revocar llaves de API, crear o editar webhooks, ver o cambiar el secreto de los webhooks y
    el enlace del calendario. Ajustes ya no los devuelve (`webhook_secret`, `calendar_token` e `ics_url` vacíos con
    `secrets_hidden: true`): el panel los muestra con «Mostrar» (`GET /api/settings/secrets`, con verificación
    reciente).
  - Cuenta: cambiar plan, cambiar tarjeta, datos de facturación, exportar, borrar, transferir (2b).
  - Superadministrador: secretos de la plataforma, crear cuentas, cambiar usuarios de otras cuentas, restablecer
    contraseñas o 2FA ajenos.
- El Copiloto actúa con la sesión de la persona: el plan comprueba que ninguna de sus herramientas llegue a una ruta
  de la lista (si alguna llega, pide la verificación como el panel).

### 2a.6 Contraseñas

- Entre 12 y 128 caracteres. No pueden contener la parte local del correo ni el nombre del negocio.
- Se rechazan las de la lista local (las 100 000 más comunes, comparadas en minúsculas; archivo comprimido en el repo,
  de SecLists, licencia MIT) y las que HIBP reporta filtradas. A HIBP solo van los primeros 5 caracteres del SHA-1,
  con `Add-Padding: true` y 1,5 s de tiempo máximo; si no responde, decide la lista local y queda en la bitácora. La
  URL es configurable (`PWNED_PASSWORDS_URL`; `off` la apaga) para pruebas e instalaciones sin salida a internet.
- Se aplica en: registro, invitación aceptada, restablecer, cambiar, `./riverrun admin-password --stdin` y el
  `ADMIN_PASSWORD` del primer arranque (config-check avisa si es corta).
- Las contraseñas existentes no se revisan al entrar: no hay usuarios reales todavía y todas las nuevas pasan por
  estas reglas.
- **scrypt más fuerte:** N=2^15, r=8, p=3 (unos 32 MiB, recomendación de OWASP), con los parámetros dentro del hash
  (`scrypt$ln=15,r=8,p=3$sal$hash`). Los hashes de antes (`scrypt$sal$hash`) se siguen aceptando y se recalculan al
  entrar. Como la versión de contraseña de la cookie sale del hash, ese primer inicio cierra las otras sesiones de esa
  persona (una sola vez; aceptable antes del lanzamiento).
- A lo más 4 cálculos de scrypt a la vez y 64 en espera; más allá, `503` «Hay muchos intentos, prueba en unos
  segundos». Así una avalancha de intentos no agota la memoria del servidor.
- `PASSWORD_HASH_COST=test` (N=2^10, p=1) solo para la suite de pruebas; config-check lo marca como crítico con HTTPS.

### 2a.7 Límites de intentos en la base

Tabla `rate_limits (key, hits, expires_at)` y `countHit(key, windowMs)` con un solo
`INSERT … ON CONFLICT DO UPDATE … RETURNING` (atómica, sin carrera, compartida entre procesos y sobrevive a
reinicios; una ventana vencida vuelve a empezar en 1). Cada intento se cuenta **antes** de revisar la contraseña
(así una ráfaga simultánea no se salta el tope) y se devuelve (`releaseHit`) si entra o si se rechaza sin revisarla
(p. ej. por el límite de la cuenta), para no bloquear oficinas con IP compartida. La limpieza de ventanas vencidas va
en la tarea horaria. La etapa 4 mueve aquí el resto de los límites.

| Límite | Valor | Al pasarlo |
|---|---|---|
| Contraseña fallida por conexión (IPv6 por /64) | 8 en 15 min | 429 |
| Contraseña fallida por cuenta | 10 en 1 h | Se rechaza la contraseña para ese correo, salvo desde un dispositivo recordado de esa persona; restablecer por correo sigue funcionando y reinicia el contador |
| Código fallido por reto | 5 | Hay que volver a escribir la contraseña |
| Código fallido por persona (entrar y verificación reciente) | 10 en 1 h | El 2FA se bloquea 1 h y llega un correo: alguien tiene su contraseña |
| Contraseña actual equivocada en `PUT /api/me/password` | Cuenta como fallida por cuenta | (ID-9) |
| Recuperar contraseña | 5 por hora por conexión, 3 por hora por correo | Ver ID-7 y ID-8 en 2b |

El límite por cuenta no deja a la víctima fuera: entra desde su dispositivo recordado o restablece por correo.
`./riverrun admin-password` limpia los límites del superadministrador.

### 2a.8 Sesiones

- `expires_at` según el rol al crearla (7 días o 12 h). En cada petición se exige además
  `last_seen_at > now() - inactividad` (12 h o 30 min); `last_seen_at` se actualiza como mucho una vez por minuto.
  Si cambia el rol de alguien, se cierran sus sesiones (sin olvidar sus dispositivos recordados); un cambio de cuenta
  aplica al momento en las sesiones abiertas, porque el usuario se vuelve a leer en cada petición.
- Se rechazan las cookies sin `sid` (ID-9) y la firma de la sesión lleva el prefijo `session:` como el resto de los
  HMAC (ID-9). Las cookies actuales dejan de valer al desplegar (es lo que se quiere).
- Con `SECURE_COOKIES=true` las cookies llevan el prefijo `__Host-` (`__Host-cp_session`, `__Host-cp_mfa`,
  `__Host-cp_trust`, `__Host-cp_device`): el navegador exige HTTPS, `Path=/` y ningún dominio. Sin HTTPS (desarrollo)
  van sin prefijo.
- Una sesión vencida por inactividad responde `401 { code: 'session_idle' }` y el panel dice «Tu sesión se cerró por
  inactividad». Lo que el panel consulta solo (la campana, refrescar una pantalla) va con `x-panel-background: 1` y no
  cuenta como uso: un panel abierto sin nadie enfrente también se cierra.
- Las cookies se borran con las mismas opciones con que se ponen (con `Secure`): el navegador ignora el borrado de una
  cookie `__Host-` sin él.

### 2a.9 Peticiones de otros sitios

`SameSite=Strict` ya las frena en navegadores actuales. Como segunda capa, toda petición que cambia algo (no `GET`,
`HEAD` ni `OPTIONS`) y trae cookie del panel se rechaza con 403 si `Sec-Fetch-Site` existe y no es `same-origin` ni
`none`, o si no existe y `Origin` no coincide con el `Host` de la petición (el panel también se sirve en dominios de
marca, por eso se compara con el `Host` y no con una lista). Sin ninguna de las dos cabeceras se deja pasar: no viene
de un navegador, y sin navegador no hay ataque de este tipo. Un `Origin` que no se puede leer (`null`) cuenta como de
otro sitio. Webhooks, rutas públicas y la API con llave no se tocan; el chat de la web del cliente (`/webchat/*`) se
salta aunque el navegador mande la cookie (quien administra el panel lo prueba en su web de otro subdominio y esas rutas
no usan la sesión).

### 2a.10 Recuperar el acceso

| Quién perdió el teléfono | Cómo vuelve |
|---|---|
| Cualquiera con códigos de recuperación | Entra con uno; el panel le pide configurar el autenticador de nuevo |
| Agente | Un administrador o el dueño pulsa «Restablecer 2FA» en Equipo |
| Administrador | El dueño (2b; en 2a, cualquier administrador) |
| Dueño | El superadministrador, desde su panel, después de comprobar su identidad por fuera |
| Superadministrador | `./riverrun admin-password` en el servidor: contraseña nueva y 2FA restablecido |

Restablecer el 2FA de alguien borra su secreto y sus códigos, cierra sus sesiones, olvida sus dispositivos y le avisa
por correo; vuelve a configurarlo en su siguiente inicio de sesión (con su contraseña).

### 2a.11 Avisos de seguridad por correo

`src/identity/notices.ts` con `notifyUser(user, kind, details)`: correo de texto con la marca de su cuenta, sin
enlaces con token, que siempre termina con «Si no fuiste tú: cambia tu contraseña y cierra todas las sesiones desde
Mi perfil». Se manda sin detener la respuesta y un fallo queda en la bitácora. En 2a: contraseña cambiada o
restablecida, 2FA configurado, cambiado o restablecido, código de recuperación usado, códigos nuevos, 2FA bloqueado
por intentos y entrada desde un dispositivo nuevo. 2b agrega correo cambiado, transferencia y cambio de rol.

### 2a.12 Panel

- **Entrar:** después de la contraseña, la pantalla del código (6 dígitos, «Usar un código de recuperación»,
  «Recordar este dispositivo 30 días», oculto para el superadministrador).
- **Configurar (primera vez):** tres pasos: escanear el QR (o escribir el secreto), escribir el código, guardar los
  códigos de recuperación.
- **Mi perfil → Seguridad:** estado del 2FA, cambiar de autenticador, códigos restantes y «Generar nuevos»,
  dispositivos recordados con «Olvidar», sesiones abiertas (ya existe) con «Cerrar todas».
- **Equipo:** etiqueta «2FA activo» o «2FA pendiente» y el botón «Restablecer 2FA».
- **Verificación reciente:** una ventana que pide el código y repite la acción.

### 2a.13 Datos (migración 095)

- `users`: `totp_secret text`, `totp_pending text`, `totp_enabled_at timestamptz`, `totp_last_step bigint`,
  `mfa_locked_until timestamptz`.
- `user_recovery_codes (id, user_id, code_hash, used_at, created_at)`.
- `user_devices (id, user_id, device_hash, trust_hash, trusted_until, user_agent, ip, first_seen_at, last_seen_at)`.
- `user_sessions`: `mfa_at timestamptz` (`via` sigue diciendo por qué puerta entró; si pasó por un dispositivo
  recordado se sabe porque `mfa_at` queda vacío).
- `rate_limits (key text PRIMARY KEY, hits integer, expires_at timestamptz)`, con índice en `expires_at`.
- Se cierran todas las sesiones abiertas (`revoked_at = now()`).

---

## PR 2b · Cuenta

### 2b.1 Dueño y administradores (ID-2)

- El dueño es `accounts.owner_user_id` (ya existe). Las cuentas sin dueño toman al administrador activo más antiguo
  (migración).
- Un gancho `requireOwner` protege: plan, tarjeta, facturación y CFDI, borrar y exportar la cuenta, transferir, y
  crear, editar, desactivar o borrar administradores (también cambiar a alguien a administrador). El superadministrador
  pasa, con verificación reciente.
- Un administrador maneja agentes, asistente, canales y conversaciones; no puede tocar al dueño ni a otros
  administradores (`manageable()` en `admin.ts`).
- Al dueño no se le puede desactivar, degradar ni borrar: primero transfiere. El superadministrador puede reasignar
  el dueño.
- En el panel, un administrador ve «Mi plan» en solo lectura y, donde no puede actuar, «Solo el dueño de la cuenta
  (Nombre) puede hacer esto».

### 2b.2 Transferir la cuenta

`POST /api/account/transfer { user_id }`: dueño y verificación reciente. El destino debe ser un administrador activo
de la misma cuenta con 2FA configurado y correo verificado. Es inmediato: el anterior queda como administrador y los
dos reciben correo. La facturación (RFC, datos fiscales) no cambia sola; el nuevo dueño la revisa.

### 2b.3 Correo verificado de verdad (ID-4)

- Nadie escribe la contraseña de otro: `POST /api/users` con contraseña desaparece y en su lugar se invita (flujo de
  `account_invitations` que ya existe). El superadministrador, al crear una cuenta, invita a su dueño. Aceptar la
  invitación prueba que el correo es suyo.
- Solo marcan `email_verified_at`: el enlace de verificación del registro, aceptar una invitación, confirmar un cambio
  de correo y Google con `email_verified`.
- **Cambiar el correo** (`PUT /api/me/email`, verificación reciente): manda un enlace al correo nuevo; el cambio se
  aplica al abrirlo y llega un aviso al anterior.
- **Google por `sub`:** `users.google_sub`. Google entra a un usuario por su `sub`; la primera vez se liga por correo
  solo si nuestro correo está verificado y Google dice `email_verified`. Si después cambia el correo aquí, el `sub`
  sigue.
- Los usuarios que ya existen no se tocan: son de prueba.

### 2b.4 Bajas (ID-5)

Desactivar o borrar a alguien cierra sus sesiones y olvida sus dispositivos (ya pasa con las sesiones), revoca sus
invitaciones pendientes y las llaves de API que creó, y pausa los webhooks que creó (`webhook_endpoints.created_by`,
columna nueva; motivo «Lo creó Nombre, que ya no está en el equipo»). La ventana de confirmación dice cuántas llaves y
webhooks se van (`GET /api/users/:id/offboarding`).

### 2b.5 Invitaciones (ID-6)

- Solo invita una cuenta cuyo dueño tiene el correo verificado, y solo quien tiene el suyo verificado.
- Topes: 20 por día por cuenta, 50 pendientes, el mismo correo 3 veces por día.
- El nombre que escribe quien invita se limpia: sin enlaces (`http`, `www.`, dominios), sin saltos de línea ni
  caracteres de control, 60 caracteres como máximo. El texto del correo es fijo y el nombre va entre comillas.
- Los tokens salen de la URL: el panel lee el token del fragmento (`#/invitacion/<token>`) y lo manda por `POST`
  (`/api/invitation/peek`); lo mismo con `/api/signup/google` (ID-9). El pase del registro con Google queda ligado al
  navegador con una cookie (ID-9).

### 2b.6 Bajos

- **ID-7:** recuperar contraseña tarda lo mismo exista o no el correo: el trabajo (buscar, firmar, mandar) va en
  segundo plano y la respuesta es siempre igual.
- **ID-8:** cambiar o restablecer la contraseña y cambiar el correo invalidan todos los `auth_tokens` abiertos de esa
  persona. Pedir otro enlace ya no anula el anterior (hasta 3 vivos) y el límite por correo cuenta aparte de los
  intentos por conexión, para que un tercero no bloquee la recuperación legítima.
- **ID-9:** lo de arriba, más: sin SMTP, la bitácora guarda el texto del correo con los enlaces de token tachados (el
  buzón en memoria de desarrollo y pruebas lo conserva completo).
- **ID-10:** los enlaces sensibles (restablecer, verificar, invitación, cambio de correo) siempre van al dominio
  principal (`publicBaseUrl`), nunca al de una marca. Los demás enlaces de marca no cambian.

### 2b.7 Datos (migración 096)

- `users.google_sub text UNIQUE`.
- `webhook_endpoints.created_by uuid REFERENCES users(id) ON DELETE SET NULL`.
- `accounts.owner_user_id` relleno donde falte.
- `auth_tokens.kind` admite `'change_email'` (y su correo destino en una columna nueva `email`).

---


### 2b.8 Lo que cambió al implementar

- **Dueño:** se resuelve al leerlo (`accountOwner`): si el guardado ya no es un administrador activo de la cuenta, lo es
  el administrador activo más antiguo y queda guardado. Al aceptar una invitación de administrador en una cuenta sin
  dueño válido, el dueño es el administrador activo más antiguo (quien acaba de entrar, si no hay otro). La lista del equipo marca al dueño (`is_owner`) para que el superadministrador vea sus
  controles. Al dueño tampoco se le mueve de cuenta.
- **Transferir:** una sola escritura condicionada (dueño anterior y destino elegible); si la cuenta cambió de dueño
  mientras tanto, 409. Si la reasigna el superadministrador, el aviso al anterior dice quién fue.
- **Avisos nuevos:** «Transferiste tu cuenta», «Ahora eres dueño de la cuenta», «Cambiaste tu correo» y «Tu rol
  cambió». Los de la transferencia y el cambio de correo se esperan antes de responder (nunca fallan).
- **Cambiar el correo:** pide también la contraseña actual (con la sesión sola no se cambia: el correo abre «Olvidé
  mi contraseña»); rechaza correos desechables y topa 5 pedidos por hora por persona, contando también los correos
  ocupados (el tope va antes de decir si el correo tiene cuenta). El aviso al anterior no lleva enlace: dice con qué
  correo entrar y cómo volver a poner el suyo. Confirmarlo no
  cierra sesiones (la contraseña no cambia; el aviso llega al correo anterior). Restablecer la contraseña por correo
  también marca el correo como verificado, como antes: el enlace prueba que es suyo.
- **Google:** el pase lleva también el `sub`. Un usuario ya ligado a otro `sub` con el mismo correo no entra
  (`google=otra-cuenta`); sin `sub`, error. La cookie del pase (`cp_gpass`) va con `path=/api`.
- **Invitaciones:** los topes aplican también al superadministrador (solo queda exento de los correos verificados).
  Crear y reenviar dicen si el correo salió (`mail_sent`); sin SMTP el panel avisa que la invitación quedó guardada.
- **Bajas:** quedan en la bitácora con lo que se fue. Pasar a alguien a otra cuenta también es una baja en la de antes.
- **Invitaciones de administrador:** reenviarlas (con verificación reciente), cancelarlas o reemplazarlas por otra al
  mismo correo es del dueño, como crearlas.
- **Recuperar contraseña:** el trabajo va en segundo plano con `setImmediate`; el tope por conexión responde 429 y el
  del correo es silencioso.

## Pruebas

- **TOTP** contra los vectores del RFC 6238; reutilizar un código; dos peticiones simultáneas con el mismo código.
- **Una prueba por puerta** (contraseña, Google, invitación, registro, cambio y restablecimiento de contraseña): sin
  código no hay sesión; con código sí.
- Recordar dispositivo (salta el código, nunca para superadmin, se olvida con cada evento), verificación reciente
  (la lista completa de rutas), límites (carrera con peticiones simultáneas, IPv6 /64, bloqueo por cuenta que respeta
  el dispositivo recordado), sesiones (inactividad y máximo por rol, cookie sin `sid`), `Sec-Fetch-Site` y `Origin`.
- Contraseñas: lista local, HIBP con un servidor falso (filtrada, limpia, sin respuesta), rehash de scrypt, tope de
  cálculos simultáneos.
- 2b: cada poder del dueño contra un administrador, transferencia, cambio de correo, Google por `sub`, bajas,
  invitaciones, ID-7 (mismo tiempo), ID-8, ID-10.
- **La suite actual:** el arnés hace el 2FA solo, por la API (configura en el primer inicio, recuerda el secreto por
  correo y reinicia `totp_last_step` en la base de pruebas para poder entrar varias veces en el mismo medio minuto).
  Las contraseñas de prueba pasan a 12 caracteres o más. Los 7 archivos que llaman `/api/login` directo y los que
  crean usuarios con contraseña (unas 86 llamadas) usan ayudantes del arnés.
- Panel con Playwright: configurar, entrar, recordar, código de recuperación, verificación reciente, Mi perfil →
  Seguridad.
- `scripts/test-cli.sh`: `admin-password` restablece el 2FA; `rotate-secret` re-cifra y el 2FA sigue funcionando.

## Riesgos

| Riesgo | Cómo se cubre |
|---|---|
| Rotar `SESSION_SECRET` deja a todos sin 2FA | `rotate-secret` re-cifra antes de cambiar; prueba en `test-cli.sh` |
| El límite por cuenta deja fuera a la víctima | Dispositivo recordado y restablecer por correo siguen funcionando |
| Sin SMTP no llegan avisos ni invitaciones | config-check ya avisa; en 2b el panel lo dice al invitar |
| HIBP caído o sin internet | Decide la lista local; nunca bloquea el registro |
| Avalancha de intentos agota la memoria (scrypt) | Tope de 4 cálculos a la vez y 64 en espera |
| La suite se rompe en masa | Ayudantes del arnés; se migran por archivo y se corre completa antes de cada commit |

## Fuera de esta etapa

- Captcha, verificar el correo antes de pagar y el orden completo del registro (etapa 3).
- El resto de los límites en memoria pasan a la tabla `rate_limits` (etapa 4).
- Llaves separadas y rotación con versiones para todas las credenciales cifradas (etapa 6).
- Bitácora de seguridad y alertas al superadministrador (etapa 7).
- Llaves de seguridad físicas o passkeys (WebAuthn): se puede agregar después sobre el mismo reto; no entra ahora.
