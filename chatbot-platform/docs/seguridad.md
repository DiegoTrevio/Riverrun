# Seguridad: auditoría del 30 de octubre de 2026 y programa por etapas

**Base revisada:** `main` en a5f34e9 (antes del lanzamiento). Cinco revisores de solo lectura, cada uno en un área:
identidad y permisos, cobros y fraude, entradas de datos, IA y Copiloto, servidor y cadena de suministro. Cada hallazgo
alto se comprobó en el código; el de la conversión de HTML, además, midiendo su tiempo.

**Resultado:** ningún crítico, 11 altos, unos 40 medios y unos 30 bajos. Lo que ya estaba bien (aislamiento entre cuentas,
tarjetas que nunca pasan por el servidor, firmas de los avisos de pago, CSP estricta del panel, SSRF, archivos por su
contenido) se dejó igual.

## Etapas

Cada etapa es un PR con pruebas que fallan con el código anterior y pasan con el nuevo, de lo más grave a lo menos grave.

| Etapa | Qué resuelve | Estado |
|---|---|---|
| 1. Altos de la aplicación | ID-1, IN-1, AI-1, AI-2, AI-3, AI-4, PAY-1, INF-1 | ✅ Corregido |
| 2. Identidad | 2FA obligatorio para todos, contraseñas filtradas, sesiones con caducidad por inactividad, límites por cuenta y en la base, dueño distinto de administrador, correo verificado de verdad (ID-2…ID-10) | 2a ✅ (acceso), 2b ✅ (cuenta) |
| 3. Registro y cobros | Captcha → correo → 2FA → tarjeta, topes contra prueba de tarjetas (PAY-2), pruebas gratis por persona (PAY-3), sin IA en pausa (parte de PAY-6); disputas, plan del precio, códigos y cobros a clientes (PAY-4…PAY-16) | 3a ✅ (registro), 3b pendiente (cobros) |
| 4. Abuso de entradas | Límites compartidos en la base, tamaños por ruta, firma del webhook de WhatsApp, adjuntos sin macros, PDF aislados, cuota de IA antes de transcribir (IN-2…IN-14, PAY-6) | Pendiente |
| 5. IA y Copiloto | Tarjetas de confirmación completas, costo de sub-llamados, notas de cotización, fuga de instrucciones (AI-5…AI-13) | Pendiente |
| 6. Secretos y datos | Claves separadas con rotación, credenciales de canales cifradas, retención en Evolution (INF-6…INF-8, INF-13) | Pendiente |
| 7. Detección | Bitácora de seguridad, alertas, avisos al usuario | Pendiente |
| 8. Contenedores | Roles de base de datos, Redis con clave, redes aisladas, límites, imágenes al día (INF-2, INF-3, INF-9, INF-10) | Pendiente |
| 9. Servidor | `./riverrun harden`: firewall (también `DOCKER-USER`), SSH con llave, fail2ban, actualizaciones automáticas, respaldos con cifrado autenticado (INF-11, INF-12) | Pendiente |
| 10. Cadena de suministro | Dependabot, versiones fijadas por SHA y digest, búsqueda de secretos, escaneos programados (INF-4, INF-15) | Pendiente |

## Etapa 1: lo que se corrigió

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| ID-1 | `/api/me` y `/api/accounts` entregaban a cualquier rol, también al agente, el token del calendario (descarga sin sesión todas las citas con datos de clientes) y el secreto de los webhooks. | `publicAccount()` quita `settings` de toda respuesta de cuenta; el administrador los ve solo en Ajustes. | `audit-high-fixes.test.ts` |
| IN-1 | La conversión de HTML a texto era cuadrática: un correo de 10 MB congelaba el proceso horas para todas las cuentas (y en bucle tras cada reinicio). | Conversión en una sola pasada (1 MB hostil en milisegundos) que conserva los datos estructurados del `<head>`; del correo se convierten a lo más 2 MB de HTML. | `html-to-text.unit.test.ts` |
| AI-1 | Una lista con mensajes de varios clientes ampliaba lo que el Copiloto cambia sin confirmar a todos ellos. | Una lectura con texto de clientes solo amplía el alcance si es de un único cliente. | `copilot.test.ts` |
| AI-2 | «Editar cobro» cambiaba monto y enlace de pago sin confirmar (desvío de pagos). | Monto y enlace se confirman siempre. | `copilot.ops.test.ts` |
| AI-3 | Tras leer mensajes de clientes, el Copiloto podía escribir texto que llega al cliente (datos de otro cliente, «deposita a esta cuenta») sin confirmar. | Tras leer texto de clientes se confirman: editar una ficha, el concepto de un cobro y las notas o conceptos libres de una cotización. | `copilot.test.ts`, `copilot.ops.test.ts` |
| AI-4 | El chat web aceptaba sesiones inventadas: cada una, un cliente y una respuesta de IA; la cuota mensual se agotaba en minutos. | Sesiones emitidas y firmadas por el servidor para cada canal. Topes: 30 sesiones por hora por conexión, 120 mensajes por hora por conexión, 300 por día por sesión y 300 clientes nuevos por hora por canal (pedir sesiones no cuenta, para que nadie cierre el chat a los demás). IPv6 agrupada por /64 (`ipKey`). El widget se recupera solo de una sesión vieja. | `channels.test.ts`, `ip-key.unit.test.ts` |
| PAY-1 | En Mercado Pago, subir de plan daba el plan caro de inmediato y lo cobraba hasta la renovación (repetible); igual con una sustitución (mensual ↔ anual, o contratar otro tras cancelar), y cambiar de plan con un cobro fallido daba la cuenta por pagada. | El plan nuevo empieza con el primer cobro de su monto pactado (también en sustituciones); volver al actual lo cancela; con un cobro fallido, primero se cambia la tarjeta; no se borra un plan programado. | `billing-plan-change.test.ts` |
| INF-1 | La contraseña inicial del superadministrador (en `.env`) se reimponía en cada arranque. | Solo crea; recuperación explícita con `./riverrun admin-password`; el instalador la quita de `.env`. | `superadmin-access.test.ts` |

**Revisión independiente de la etapa 1.** Encontró que PAY-1 seguía abierto por las sustituciones de Mercado Pago, que
el JSON-LD del `<head>` se perdía, que el concepto de un cobro y las notas de una cotización también se escribían sin
confirmar, dos casos del instalador sin contraseña visible y que el tope por canal del chat web se agotaba solo con pedir
sesiones. Todo eso quedó corregido, con su prueba. Lo que señaló y queda para después:
- Avisar al superadmin si un plan programado no empieza en un periodo más la gracia (etapa 7).
- Mostrar las notas en la tarjeta de «aprobar y enviar» una cotización (etapa 5, AI-6).
- Contaminación de un cliente que alcanza a otro que la persona estaba viendo (2 en vez de 30; etapa 5).
- Volver al plan actual justo cuando entra el cobro del nuevo (carrera de segundos; etapa 3).
- Sesiones del chat web que no caducan, y el cupo mensual que una sola conexión aún agota en horas (etapa 4).
- `ADMIN_PASSWORD` que quedó en `.env` en instalaciones con `--no-start` (aviso del preflight; etapa 9).

**Cambios que nota la gente:**
- Un cliente de Mercado Pago que sube de plan (o cambia a anual) recibe el plan nuevo con su siguiente cobro (antes, al momento). «Mi plan» lo muestra programado y puede quedarse con el actual.
- En Mercado Pago, con un cobro fallido primero se cambia la tarjeta y después el plan (en Stripe no cambia nada).
- El chat web abre una sesión nueva a quien tenía una del formato anterior (solo instalaciones de prueba: no se ha lanzado).

## Etapa 2a: lo que se corrigió

Diseño: [`superpowers/specs/2026-10-30-seguridad-etapa-2-identidad-design.md`](superpowers/specs/2026-10-30-seguridad-etapa-2-identidad-design.md).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| ID-3 | Límite de intentos de entrar solo por conexión, en memoria y con carrera; scrypt con los parámetros por omisión. | Límites en la base (`rate_limits`, una sola sentencia atómica, compartidos entre procesos): 8 contraseñas fallidas por conexión en 15 min (IPv6 por /64), 10 por cuenta en 1 h (salvo desde un dispositivo recordado de esa persona; recuperar por correo reinicia el contador), 5 códigos por reto y 10 por persona en 1 h (bloquea el 2FA una hora y avisa por correo). Cada intento se cuenta antes de revisar la contraseña. scrypt con N=2^15, r=8, p=3 y los parámetros dentro del hash (los de antes se recalculan al entrar); a lo más 4 cálculos a la vez y 64 en espera. | `rate-limit.test.ts`, `identity-limits.test.ts`, `password-hash.test.ts` |
| ID-9 | Cookies de sesión sin sesión registrada (no se podían cerrar), firma sin prefijo, y la contraseña actual equivocada en Mi perfil no contaba como intento. | Toda cookie lleva su sesión registrada y la firma el prefijo `session:`; la contraseña actual equivocada cuenta para el límite por cuenta. | `sessions.test.ts`, `identity-sessions.test.ts`, `identity-limits.test.ts` |
| Faltaba | Verificación en dos pasos. | Obligatoria para todos con una app de autenticación (TOTP, sin SMS). Cada código sirve una vez, también con dos peticiones a la vez. El secreto va cifrado y nunca se devuelve después de configurarlo; el que se está configurando se vuelve a mostrar durante una hora (recargar, otra pestaña) y después se cambia, para que nadie que sepa la contraseña deje uno preparado. Cinco puertas (contraseña, Google, invitación, registro, restablecer) pasan por el mismo reto. | `totp.unit.test.ts`, `identity-login.test.ts`, `test:identity:ux` |
| Faltaba | Recuperar el acceso sin el teléfono. | 10 códigos de recuperación de un solo uso (al entrar con uno, el panel abre Mi perfil y pide configurar la app otra vez); «Restablecer 2FA» en Equipo; `./riverrun admin-password` también restablece el del superadministrador y sus límites; `rotate-secret` vuelve a cifrar los secretos (todo o nada) antes de cambiar `SESSION_SECRET`. | `identity-profile.test.ts`, `superadmin-access.test.ts`, `rekey-mfa.test.ts`, `test-cli.sh` |
| Faltaba | Verificación reciente para lo delicado. | 26 rutas (contraseña, app y códigos, equipo, llaves y webhooks, secretos, plan y tarjeta, exportar y borrar la cuenta, ajustes de la plataforma) y algunos cambios (rol, baja, contraseña o correo de otra persona, invitar a un administrador) piden el código si el último tiene más de 15 minutos. Entrar desde un dispositivo recordado no cuenta como código escrito. El Copiloto no llega a ninguna. | `identity-step-up.test.ts`, `test:identity:ux` |
| Faltaba | Secretos a la vista en Ajustes. | El secreto de los webhooks y el enlace del calendario ya no vienen en Ajustes: «Mostrar» los pide con verificación reciente. | `identity-step-up.test.ts` |
| Faltaba | Contraseñas cortas o filtradas. | De 12 a 128 caracteres, sin la parte local del correo ni el nombre del negocio, fuera de las 100 000 más comunes (lista local) y de las filtradas que reporta Have I Been Pwned (solo salen los primeros 5 caracteres del hash). Se aplica al registrarse, aceptar una invitación, restablecer o cambiar la contraseña, crear usuarios y en `admin-password --stdin`. | `passwords.test.ts` |
| Faltaba | Sesiones que no caducan sin uso. | Equipo: 12 h sin usar el panel y 7 días como máximo; superadministrador: 30 min y 12 h. Lo que el panel consulta solo (la campana, refrescar la pantalla) no cuenta como uso: un panel abierto sin nadie enfrente también se cierra. Cambiar el rol de alguien cierra sus sesiones. Con HTTPS, cookies `__Host-`, que también se borran con `Secure` (si no, el navegador ignora el borrado). | `identity-sessions.test.ts`, `secure-cookies.test.ts`, `identity-profile.test.ts`, `test:identity:ux` |
| Faltaba | Dispositivos recordados. | «Recordar este dispositivo 30 días» salta el código (nunca la contraseña, nunca para el superadministrador) y se olvida al cambiar o restablecer la contraseña, restablecer el 2FA, cerrar las demás sesiones o dar de baja a la persona. | `identity-devices.test.ts` |
| Faltaba | Peticiones de otros sitios (segunda capa sobre `SameSite=Strict`, que no frena a otro subdominio). | Con la cookie del panel, lo que cambia algo y viene de otro sitio (`Sec-Fetch-Site`, o `Origin` distinto del host) se rechaza con 403. | `origin-guard.test.ts` |
| Faltaba | Avisos de seguridad. | Correo al cambiar o restablecer la contraseña, configurar, cambiar o restablecer el 2FA, usar un código de recuperación, generar códigos nuevos, bloquearse el 2FA y entrar desde un dispositivo nuevo. | `security-notices.test.ts` |

**Revisión independiente de la etapa 2a.** Encontró que la campana del panel (cada 20 s) contaba como uso y la sesión
nunca vencía por inactividad con la pestaña abierta, que con HTTPS salir no borraba la cookie `__Host-` (faltaba
`Secure` al borrarla), que un secreto pendiente se volvía a mostrar para siempre (quien supiera la contraseña podía dejar
uno preparado) y que entrar con un código de recuperación solo mostraba un aviso pasajero. Todo eso quedó corregido, con
su prueba. Lo que señaló y queda para después (lo de la 2b ya quedó corregido, ver abajo):
- `rotate-secret`: quien configura su app justo entre el re-cifrado y el reinicio queda con el cifrado anterior; sus
  códigos de recuperación sí sirven (etapa 6).

**Cambios que nota la gente:**
- Al desplegar se cierran todas las sesiones. La próxima vez que entra, cada persona configura su app de autenticación (QR o clave) y guarda 10 códigos de recuperación; después entra con su contraseña y el código de 6 dígitos.
- En la pantalla del código puede marcar «Recordar este dispositivo 30 días» (el superadministrador siempre escribe el código).
- Cambiar la contraseña, el plan o la tarjeta, crear llaves de API, exportar o borrar la cuenta y otras acciones delicadas piden el código otra vez si pasaron más de 15 minutos («Confirma que eres tú»).
- Ajustes ya no muestra el secreto de los webhooks ni el enlace del calendario: hay que pulsar «Mostrar».
- Contraseñas nuevas de 12 caracteres como mínimo, que no estén filtradas ni contengan el correo o el nombre del negocio.
- Quien entra con un código de recuperación llega a Mi perfil con un aviso para configurar su app otra vez.
- La sesión se cierra tras 12 horas sin usar el panel (30 minutos el superadministrador) y dura 7 días como máximo (12 horas).
- Cambiar el rol de alguien cierra sus sesiones: vuelve a entrar con sus permisos nuevos.
- Con 10 contraseñas equivocadas en una hora, esa cuenta solo entra desde un dispositivo recordado o recuperando la contraseña por correo.
- Mi perfil tiene «Verificación en dos pasos» (cambiar de app, códigos que quedan y «Generar códigos nuevos», dispositivos recordados con «Olvidar»); Equipo muestra «2FA activo» o «2FA pendiente» y «Restablecer 2FA».
- Llegan correos de aviso de seguridad (ver la tabla).

## Etapa 2b: lo que se corrigió

Diseño: el mismo de la 2a. Plan: [`superpowers/plans/2026-10-30-seguridad-etapa-2b-cuenta.md`](superpowers/plans/2026-10-30-seguridad-etapa-2b-cuenta.md).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| ID-2 | Cualquier administrador equivalía al dueño: podía cambiarle la clave, degradarlo, borrar o exportar la cuenta. | Cada cuenta tiene un solo dueño (`accounts.owner_user_id`, siempre un administrador activo de ella; sin uno válido, el administrador activo más antiguo, y queda guardado). Solo el dueño (o el superadministrador) maneja el plan, los pagos y la facturación, descarga o borra la cuenta, cancela el borrado e invita, promueve o maneja a los administradores (también reenvía, cancela o reemplaza sus invitaciones); a los demás les responde `owner_only` antes de pedir el código. Al dueño nadie lo desactiva, degrada, mueve ni borra: «Primero transfiere la cuenta a otro administrador». «Hacer dueño» transfiere a un administrador activo con su correo verificado y su 2FA (en una sola escritura condicionada), queda en la bitácora y avisa a los dos; la sesión del anterior pierde lo del dueño al momento. Mi plan es de solo lectura para quien no es dueño. | `account-owner.test.ts`, `account-transfer.test.ts`, `test:account:ux` |
| ID-2 | Nadie debía escribir la contraseña de otro, pero el equipo se creaba con contraseña inicial y se le podía cambiar la clave o el correo a otro. | Al equipo se le invita y cada persona elige su contraseña al aceptar: `POST /api/users` responde 410; cambiar la contraseña o el correo de otra persona responde 400 (ni el superadministrador). Una cuenta nueva se crea con una invitación a su dueño, que al aceptarla queda como dueño. | `invite-only.test.ts`, `harness-helpers.test.ts` |
| ID-4 | Cuentas «verificadas» sin prueba de control del correo; el login con Google entraba a ellas (y cambiaba su contraseña). | Un usuario creado sin decir lo contrario queda sin verificar. Google entra por su identificador estable (`sub`); por correo solo se liga si los dos lados lo tienen verificado; con el correo sin verificar aquí no entra ni toca la contraseña. El pase del registro con Google solo sirve en el navegador que entró (cookie `cp_gpass`) y ya no viaja en la URL de la API. Cambiar el correo pide la contraseña actual y la verificación reciente (con la sesión sola no se cambia: el correo abre «Olvidé mi contraseña»), topa 5 pedidos por hora contando también los correos ocupados, se aplica al abrir el enlace que llega al correo nuevo (si alguien lo tomó mientras tanto, no cambia nada) y avisa al anterior con qué correo entrar y cómo volver a poner el suyo. | `google-login.test.ts`, `email-change.test.ts`, `invite-only.test.ts` |
| ID-5 | Al dar de baja a alguien sobrevivían sus invitaciones, llaves de API y webhooks. | Desactivar, borrar o pasar a otra cuenta a alguien revoca sus llaves (de la cuenta de antes), pausa sus webhooks («Lo creó …, que ya no está en el equipo») y cancela sus invitaciones; reactivarlo no revive nada. La confirmación del panel dice qué se va. | `offboarding.test.ts`, `test:account:ux` |
| ID-6 | Las invitaciones servían para mandar correo con texto controlado, también desde una cuenta sin verificar. | Texto fijo con los nombres limpios (sin enlaces ni dominios) y entre «»; solo invita quien tiene su correo verificado y con el del dueño verificado; topes en la base (20 por día por cuenta, 3 por día al mismo correo, 50 pendientes). Si el correo no sale (sin SMTP), el panel lo dice. | `invitation-limits.test.ts` |
| ID-7 | Recuperar la contraseña delataba qué correos existen (por el tiempo) y su límite estaba en memoria. | Responde al momento y lo mismo exista o no el correo; el resto va en segundo plano. Topes en la base: 5 por hora por conexión y 3 por hora al mismo correo. | `password-recovery.test.ts` |
| ID-8 | Los enlaces para restablecer seguían vigentes tras cambiar la contraseña; uno nuevo invalidaba al anterior aunque llegara antes. | Quedan vivos los 3 más nuevos (sirve cualquiera); usar uno, cambiar la contraseña o confirmar un cambio de correo invalida los demás. Restablecer por correo quita también el bloqueo del 2FA. | `password-recovery.test.ts`, `email-change.test.ts` |
| ID-10 | Los enlaces con token iban al dominio de la marca blanca. | Todo enlace con token (verificar, restablecer, invitación, cambio de correo, borrar la cuenta) va al dominio principal; el remitente sigue con su marca. | `brand.test.ts` |
| INF-13 (parte) | Sin SMTP, la bitácora guardaba el correo completo, con sus enlaces. | La bitácora guarda el texto con los tokens como `[oculto]`. | `mailer.test.ts` |
| 2a | Lo que la revisión de la 2a dejó para después. | Un `cp_trust` copiado a otro navegador ya no salta el código (hace falta su `cp_device`); con muchos códigos malos a la vez llega un solo correo de bloqueo; dos «Generar códigos nuevos» a la vez dejan 10; «Cerrar las demás sesiones» y «Olvidar» un dispositivo piden verificación reciente. | `identity-devices.test.ts`, `identity-limits.test.ts`, `identity-profile.test.ts`, `identity-step-up.test.ts` |

**Cambios que nota la gente:**
- Cada cuenta tiene un dueño (el administrador que la creó o el primero que aceptó). Solo él cambia el plan y la tarjeta, ve la facturación, descarga o borra la cuenta, e invita o maneja a los administradores; los demás administradores ven Mi plan sin botones. En Equipo aparece «Dueño» y, para el dueño, «Hacer dueño» en los administradores que pueden recibir la cuenta.
- Ya no se crean usuarios con contraseña inicial ni se cambia la contraseña de otro: se invita (Equipo → Invitar a tu equipo). El superadministrador crea una cuenta invitando a su dueño.
- El correo propio se cambia en Mi perfil → Correo, con la contraseña actual: llega un enlace al correo nuevo y el cambio se aplica al abrirlo; al anterior le llega un aviso.
- Entrar con Google: si el correo de la cuenta no está verificado, primero hay que entrar con la contraseña y verificarlo.
- Desactivar, borrar o pasar a otra cuenta a alguien revoca sus llaves de API, pausa sus webhooks y cancela sus invitaciones (la confirmación lo dice).
- Para invitar hay que tener el correo verificado (y el dueño también); hay topes por día.
- Los enlaces de los correos (verificar, restablecer, invitación, cambio de correo, borrar la cuenta) van al dominio principal también en cuentas con marca blanca.

**Revisión independiente de la etapa 2b.** Encontró que con una sesión robada se podía cambiar el correo sin la
contraseña y, con «Olvidé mi contraseña» al correo nuevo, quedarse con la cuenta. Además subí a importantes que preguntar
por correos ocupados al cambiar el correo no tenía tope, que quien aceptaba una invitación de administrador podía quedar
como dueño antes que un administrador más antiguo, que un administrador que no es el dueño podía cancelar, reenviar o
cambiar por una de agente la invitación de administrador del dueño, y que al pasar a alguien a otra cuenta su llave de
la cuenta de antes seguía entrando. Todo eso quedó corregido, con su prueba. Lo que señaló y queda para después:
- Crear una invitación no es atómico: un doble clic al mismo correo puede responder 500 (y gastar un intento del tope).
- Cambiar el correo e invitar al dueño de una cuenta nueva no dicen si el correo salió (sin SMTP el panel dice «te
  mandamos…»); las invitaciones del equipo sí lo dicen.
- El superadministrador sin cuenta elegida ve «Hacer dueño» y el servidor responde «Elige la cuenta»; tampoco ve
  exportar o borrar la cuenta en Mi plan (la API sí se lo permite con `?account_id`).

## Etapa 3a: lo que se corrigió

Registro con tarjeta y una prueba gratis por persona. El diseño completo (también lo que queda para la 3b) está en
[la especificación](superpowers/specs/2026-10-30-seguridad-etapa-3-registro-cobros-design.md).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| PAY-2 | Prueba de tarjetas robadas: el registro abría una sesión de pago sin correo verificado, con captcha opcional y límites en memoria; la sesión no vencía pronto y aceptaba cualquier cupón. | El orden es captcha → correo → 2FA → tarjeta → prueba. El registro ya no abre el pago: la cuenta nueva espera su tarjeta (en pausa, motivo `card`) y la verificación se abre desde Mi plan, solo con el correo del dueño verificado y verificación reciente. La sesión de Stripe vence a los 31 minutos, siempre pide tarjeta, pide 3D Secure cuando el banco lo tiene y no acepta cupones sueltos; la sesión vigente se reutiliza. Topes en la base: 5 verificaciones por día por cuenta, 10 por conexión (IPv6 por /64) y 300 en toda la plataforma. Si en una hora se abren 20 o más y se completan menos del 20 %, un freno cierra las nuevas una hora y avisa con urgencia; lo quita el superadministrador. El captcha (Turnstile) es obligatorio en producción, en el formulario y en el registro con Google, y cerrado ante fallas: si Cloudflare no responde, «No pudimos comprobar el captcha» (503) y un aviso por hora. Registros: 5 intentos por hora por conexión, 3 cuentas por hora o 10 por día, y `SIGNUP_DAILY_MAX` (200) por día en la plataforma, con aviso al 80 %. | `card-check.test.ts`, `signup.test.ts`, `signup-limits.test.ts`, `google-login.test.ts`, `test:signup:ux` |
| PAY-3 | Pruebas gratis sin límite (correo sin normalizar, sin huella de la tarjeta). | Una prueba por persona: marcas del correo normalizado (sin `+etiqueta`; en Gmail también sin puntos), de la cuenta de Google y de la tarjeta (la huella de Stripe; en Mercado Pago, primeros 6, últimos 4, vencimiento y titular), guardadas 2 años como HMAC con una llave que vive en la base. Sin prueba disponible, agregar la tarjeta es el primer cobro. Una tarjeta que ya tuvo prueba: en Stripe la prueba termina al momento y se cobra; en Mercado Pago se cancela esa suscripción. La prueba empieza al confirmarse la tarjeta, con el fin que dice el proveedor, una sola vez aunque el aviso se repita; no se pausa al vencer mientras su suscripción siga viva. Las cuentas que ya existían dejan marcado el correo de su dueño. | `trial-claims.test.ts`, `trial-start.test.ts`, `migration.test.ts` |
| PAY-6 (parte) | Cuentas en pausa seguían gastando IA. | Una sola puerta (`assertAiAllowed`) en el envoltorio de las llamadas de IA y al empezar cada ruta con IA (Copiloto, asistente de instrucciones, pruebas del agente, simulador, «Probar mensaje», flujos con IA, importar): una cuenta en pausa o desactivada responde 402 `ai_paused`, y los audios e imágenes que llegan se guardan sin transcribir. En el panel esos botones se ven deshabilitados con el motivo. Lo de las cuentas sin cupo va en la etapa 4. | `ai-gate.test.ts`, `knowledge-preparation.test.ts`, `test:signup:ux` |

**Cambios que nota la gente:**
- Para empezar la prueba de 14 días hay que agregar una tarjeta en Mi plan, después de confirmar el correo y configurar la verificación en dos pasos. No se cobra nada hasta que termina, y si se cancela antes no se cobra. Mientras tanto el panel sirve para preparar el asistente, sin IA y sin responder a clientes.
- Una persona tiene una sola prueba: el mismo correo (aunque lleve `+etiqueta`), la misma cuenta de Google o la misma tarjeta ya no dan otra. Sin prueba, agregar la tarjeta es contratar.
- El registro pide el captcha, también el registro con Google.
- Mientras la cuenta está en pausa, los botones que usan IA se ven deshabilitados con el motivo.
- Cuentas (superadministrador): «Esperando tarjeta», «Activar sin tarjeta» para excepciones reales (queda en la bitácora y gasta la prueba de esa persona) y «Quitar freno».

## Hallazgos pendientes por etapa

Abreviaturas: ID identidad, PAY cobros, IN entradas, AI IA y Copiloto, INF servidor.

### Altos (en la etapa 8)
- **INF-2** Un solo superusuario de PostgreSQL compartido por el backend, Evolution y el respaldo; Redis sin contraseña (guarda las claves de las sesiones de WhatsApp); red plana.
- **INF-3** `./riverrun update` nunca actualiza Caddy, Node, Redis ni PostgreSQL.

### Medios
- **PAY-4/5** Disputas: un aviso fuera de orden re-pausa para siempre; una disputa abierta no detiene los cobros.
- **PAY-6** Cuentas sin cupo siguen gastando IA (transcripción, Copiloto, herramientas con IA); las que están en pausa ya no, desde la 3a.
- **PAY-7** El plan se toma de la metadata de Stripe sin comparar con el precio; portal sin configuración propia; cupones de toda la cuenta.
- **PAY-8** Un pago reactiva cuentas pausadas a mano; la conciliación pisa el plan que asignó el superadmin.
- **PAY-9** El CFDI ignora la moneda del plan.
- **AI-5…AI-9** Nombre del contacto en el prompt del Copiloto sin marcar como texto de cliente; tarjetas de confirmación que recortan lo que se ejecuta; notas de cotización sin verificar; sin detector de fuga de instrucciones; sub-llamados de IA fuera del tope de costo.
- **IN-2** El webhook de Evolution no tiene firma (solo el token en la URL) y su ruta es pública en Caddy.
- **IN-3** Cuerpo de hasta 10 MB que se lee completo antes de verificar firmas; cada rechazo escribe en la bitácora; sin tiempo máximo de petición.
- **IN-5** Adjuntos con macros de Office.
- **IN-6/7** Plantillas DOCX que procesa LibreOffice dentro del backend, con todos los secretos en su entorno; cola de PDF única para todas las cuentas.
- **INF-4** `update` despliega lo que haya en `main` sin verificar firma ni CI.
- **INF-6** `rotate-secret` rompe más de lo que avisa (Zernio, Outlook, llaves guardadas); no hay versiones de clave.
- **INF-7** Credenciales de canales (IMAP/SMTP, Meta, Telegram) en claro en la base.
- **INF-8** Evolution guarda todos los mensajes sin retención; el borrado de datos no llega a su base.
- **INF-9/10** Contenedores sin límites de memoria ni rotación de registros; `PANEL_BIND=0.0.0.0` salta el firewall sin aviso.
- **INF-11** Respaldo: directorio de trabajo en claro, credencial de S3 que puede borrar, cifrado sin autenticación.

### Bajos
PAY-10…PAY-16, AI-10…AI-13, IN-8…IN-14 (calendario `.ics` sin escapar, asunto
reflejado, textos de la URL en el panel, reservas como relé de correo, `unsafe-inline` en páginas públicas, plazos de
descarga, analizador JSON propio), INF-12…INF-15 (secretos impresos por el instalador, cuerpos de correo en la bitácora sin
SMTP —los tokens ya van ocultos desde la 2b—, `.gitignore`, acciones por etiqueta). `privacy.md` y `terms.md` (sitio de GitHub Pages) dicen «Viralize» y prometen
«encriptamos todos los datos»: lo revisa el dueño o su abogado.
