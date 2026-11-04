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
| 2. Identidad | 2FA obligatorio para todos, contraseñas filtradas, sesiones con caducidad por inactividad, límites por cuenta y en la base, dueño distinto de administrador, correo verificado de verdad (ID-2…ID-10) | 2a ✅ (acceso), 2b ✅ (cuenta), 2c ✅ (revisión del 31 de octubre) |
| 3. Registro y cobros | Captcha → correo → 2FA → tarjeta, topes contra prueba de tarjetas (PAY-2), pruebas gratis por persona (PAY-3), sin IA en pausa (parte de PAY-6); disputas, plan del precio, códigos y cobros a clientes (PAY-4…PAY-16) | ✅ Corregido (3a registro, 3b cobros) |
| 3b′. Cobros de la revisión del 31 de octubre | PAY-17…PAY-23 y bajos de cobros | ✅ Corregido |
| 3c. Revisión del 31 de octubre | Los altos de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md): dos caídas del proceso, atajos para sacar o borrar datos, cobros del agente, la ficha en el Copiloto (IN-15, IN-16, ID-11…ID-14, AI-5 en parte) | ✅ Corregido |
| 4. Abuso de entradas | Límites compartidos en la base, tamaños por ruta, firma del webhook de WhatsApp, adjuntos sin macros, PDF aislados, cuota de IA antes de transcribir (IN-2…IN-14, PAY-6) | 4′ ✅ (revisión del 31 de octubre: IN-17…IN-20, IN-22, IN-5, parte de IN-8…IN-14 y límites en la base); IN-2 e IN-3 ✅; IN-21 ✅ en la 6′; IN-6/7 ✅ en la 6″; PAY-6 ✅ en la 5″ |
| 5. IA y Copiloto | Tarjetas de confirmación completas, costo de sub-llamados, notas de cotización, fuga de instrucciones (AI-5…AI-13) | 5′ ✅ (revisión del 31 de octubre: AI-14 y bajos de IA); 5″ ✅ (AI-5…AI-9 y PAY-6); AI-10…AI-13 ✅ en los bajos (auditoría del 4 de noviembre) |
| 6. Secretos y datos | Claves separadas con rotación, credenciales de canales cifradas, retención en Evolution (INF-6…INF-8, INF-13) | 6′ ✅ (revisión del 31 de octubre: ZIP sin secretos, `HTTP_LOG` sin tokens, IN-21); 6″ ✅ (INF-6…INF-8, IN-6/7); INF-13 ✅ en los bajos |
| 7. Detección | Bitácora de seguridad, alertas, avisos al usuario | ✅ Corregido (bitácora de seguridad, reglas con aviso al superadmin; los avisos al usuario ya estaban desde la 2a) |
| 8. Contenedores | Roles de base de datos, Redis con clave, redes aisladas, límites, imágenes al día (INF-2, INF-3, INF-9, INF-10) | 8 ✅ (los altos: INF-2 e INF-3); INF-9 e INF-10 ✅ en la 6″ |
| 9. Servidor | `./riverrun harden`: firewall (también `DOCKER-USER`), SSH con llave, fail2ban, actualizaciones automáticas, respaldos con cifrado autenticado (INF-11, INF-12) | 9′ ✅ (revisión del 31 de octubre: claves de ejemplo en producción); INF-11 ✅ en la 6″; 9 ✅ (`harden` e INF-12) |
| 10. Cadena de suministro | Dependabot, versiones fijadas por SHA y digest, búsqueda de secretos, escaneos programados (INF-4, INF-15) | 10′ ✅ (revisión del 31 de octubre: Docker sin `curl \| sh`); INF-4 ✅ en la 6″; INF-15 ✅ en los bajos |

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

## Etapa 2c: lo que se corrigió

Los medios y bajos de identidad de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md). Plan:
[`superpowers/plans/2026-10-31-seguridad-revision-correcciones.md`](superpowers/plans/2026-10-31-seguridad-revision-correcciones.md) (PR 3).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| ID-15 | El tope de códigos se revisaba antes y se contaba solo el código malo: 200 a la vez en un reto revisaban muchos más que 5. | Cada intento se cuenta antes de revisar el código: 5 por reto, 10 por persona en una hora (después se bloquea) y uno nuevo de 5 por sesión en 15 minutos para la verificación reciente y «Cambiar de app». Un código bueno devuelve su intento. | `identity-limits.test.ts` |
| ID-16 | El primer enrolamiento de 2FA (todas las cuentas al desplegar la 2a, tras «Restablecer 2FA», usuarios que crea un administrador) se hacía solo con la contraseña: quien la tuviera filtrada enrolaba su app primero. | Quien entra solo con la contraseña recibe un enlace al correo antes de ver el QR (token de 256 bits guardado como SHA-256, una hora, un solo uso) y solo sirve en el navegador que tiene el reto. Registro, invitación y Google ya prueban el correo. Restablecer la contraseña por correo quita una app que no se configuró por correo. Migración 108. | `identity-login.test.ts`, `test:identity:ux` |
| ID-17 | Al dar de baja a alguien, su Google u Outlook seguía recibiendo las citas, también si pasó a otra cuenta. | Desactivar, borrar o mover a alguien deja sus citas futuras sin asignar (antes las quita de su calendario) y desconecta su calendario; bajarle el rol no. La sincronización solo escribe en el calendario de una persona activa de la misma cuenta. | `offboarding.test.ts` |
| Bajos | Verificación reciente en planes, cuentas, precios de IA, marcas y tipo de cambio. | Las rutas del superadmin que cambian dinero, dominios o límites piden el código reciente. | `identity-step-up.test.ts` |
| Bajos | El agente veía la configuración de los canales y datos internos de la cuenta. | Lista blanca: del canal, nombre, tipo y estado; de la cuenta, sin límites especiales, dueño, borrado ni datos internos. | `visibility.test.ts` |
| Bajos | El Copiloto podía llegar a una ruta delicada con el código reciente de la persona. | Sus llamadas llevan `x-copilot`; la verificación reciente y lo del dueño responden 403 `copilot_blocked`. | `identity-step-up.test.ts` |
| Bajos | El enlace para borrar la cuenta servía varias veces y sobrevivía a cancelar o transferir. | Un solo uso (`accounts.deletion_nonce`, migración 109): el mismo enlace otra vez es 410; pedir otro, cancelar o transferir lo invalida. | `owner-self-service.test.ts` |
| Bajos | Invitar o cambiar el correo decía si un correo estaba registrado. | La respuesta es la misma; al titular le llega un aviso sin enlace. Registrarse con un correo ocupado le avisa «Alguien intentó registrarse con tu correo». | `invitations.test.ts`, `email-change.test.ts`, `signup.test.ts` |
| Bajos | El id_token de Google no se revisaba (emisor ni cliente). | Solo con `iss` de Google y `aud` igual a `GOOGLE_CLIENT_ID`; en producción, `GOOGLE_OAUTH_URL` o `GOOGLE_AUTH_URL` no oficiales impiden arrancar. | `google-login.test.ts`, `config-check.test.ts` |
| Bajos | Quien pegaba su contraseña en el campo del correo la dejaba en la bitácora. | El acceso fallido guarda el correo solo si tiene forma de correo. | `identity-limits.test.ts` |

**Cambios que nota la gente:**
- Quien entra por primera vez con su contraseña (o después de «Restablecer 2FA») ve «Revisa tu correo»: abre el enlace en el mismo navegador y después escanea el QR. Hay «Mandar otro enlace».
- Al restablecer la contraseña por correo, una app de verificación configurada antes de este cambio se quita y se configura otra vez.
- El Copiloto ya no hace nada que pida el código o que sea del dueño: lo hace la persona desde el panel.
- Dar de baja a alguien deja sus citas futuras sin asignar.
- El enlace para borrar la cuenta sirve una vez.

**Queda para después:**
- Registrarse con un correo que ya tiene cuenta sigue diciéndolo (la cuenta se crea al momento): ocultarlo pide que el registro pase primero por el correo. Hoy lo frenan el captcha y los topes, y el titular recibe el aviso.

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

**Revisión independiente de la etapa 3a.** Encontró que dos cuentas de la misma persona que confirmaban la misma
tarjeta al mismo tiempo recibían las dos su prueba: ahora la marca decide (candado por marca, y la prueba y sus marcas
se guardan juntas). También, que en Mercado Pago «Contratar» después de una tarjeta repetida no cobraba hoy y podía
dejar a la persona en un ciclo, y que las páginas de tarjeta por sustitución (cambiar tarjeta, reanudar, mensual ↔
anual) quedaban fuera de los topes y del freno. Todo eso quedó corregido, con su prueba. Lo menor que señaló se
corrigió en el PR siguiente, también con su prueba:
- A quien se le negó la prueba por su correo o su cuenta de Google ya no se le dice «Esta tarjeta ya tuvo una prueba
  gratis», sino «Ya usaste tu prueba gratis».
- Con una tarjeta que ya tuvo prueba en Stripe, mientras llega el primer cobro, el panel dice «Estamos activando tu
  plan» y ya no ofrece «Usar otra tarjeta».
- La página de pago se reutiliza 25 minutos (Stripe la cierra a los 31), y dos clics a la vez en «Agregar tarjeta»
  abren una sola.
- El aviso del 80 % de registros sale una vez al día; si un aviso falla, el registro responde igual (también con el
  captcha caído).
- El correo «tu prueba está por terminar» a quien ya canceló dice que no se cobrará.
- La retención dice «nunca agregó su tarjeta» (y al dueño, «agrega tu tarjeta») en las cuentas que esperaban tarjeta.
- Las marcas vencidas y las verificaciones de más de 30 días se depuran solas.
- Mi plan solo calcula el estado de la tarjeta con la cuenta esperándola, y el mantenimiento del conocimiento sigue
  con una prueba vencida que ya tiene su suscripción.

## Etapa 3c: lo que se corrigió

Los altos de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md), con su
[plan](superpowers/plans/2026-10-31-seguridad-revision-correcciones.md). Los medios y bajos de esa revisión están
repartidos en las etapas 3b, 2c, 4, 5, 6, 9 y 10 del mismo plan.

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| IN-15 | Las expresiones de enlaces, correos y montos de la verificación de hechos eran cuadráticas y ningún mensaje entrante tenía tope: un WhatsApp de 65 000 caracteres («a.a.a.…») tardaba 17 s por pasada y congelaba el proceso para todas las cuentas, en cada turno. | Repeticiones acotadas (lineal: 20 000 caracteres en ~50 ms, 1 MB en ~2 s) y cada mensaje entrante cortado en 8 000 caracteres con «…[mensaje recortado]»; del correo se revisan los primeros 50 000 antes de quitar lo citado. | `fact-redos.unit.test.ts`, `email.test.ts` |
| IN-16 | El guardia de las plantillas DOCX sumaba los tamaños que declara el ZIP: un archivo de 199 KB que decía pesar 400 B se inflaba a 200 MB (a gigas con 5 MB). | `checkZip` lee el índice a mano y descomprime cada parte con tope (300 partes, 8 MB por parte, 30 MB en total, medidos); 4 MB de texto por parte; 2 000 marcas; 10 subidas por hora por cuenta (en la base). Los Word de clientes con más de 1 000 partes no se abren. | `quotes-template.unit.test.ts`, `media-library.test.ts`, `quotes-routes.test.ts` |
| ID-14 | Crear un webhook y descargar el ZIP pedían el código, pero una regla «mensaje → webhook a cualquier URL» (o reporte a un correo o número externo, o aviso a un número) y los CSV de contactos, conversaciones, cotizaciones y mensajes, no. | Los cuatro CSV piden el código; una regla lo pide al crearse o cambiarse si manda datos a un destino nuevo. | `identity-step-up.test.ts` |
| ID-12 | Bajar a un administrador a agente no revocaba sus llaves, webhooks ni invitaciones, y la llave no miraba a su creador. | Bajar de administrador es una baja (el panel lo avisa); la API v1 solo acepta llaves de un administrador activo de esa cuenta (o del superadmin). | `offboarding.test.ts` |
| ID-13 | Cualquier administrador, o una cookie robada, ponía la retención en 1 día: en menos de 6 h se borraban mensajes y contactos. Igual al borrar un canal con historial. | La retención la cambia el dueño con el código; para borrar, 30 días como mínimo; lo que borra más entra a los 7 días con correo al dueño (cancelable); valores en la bitácora. Borrar un canal con conversaciones es del dueño con el código. Migración 098: lo de 1 a 29 días sube a 30. | `retention.test.ts`, `compliance.test.ts`, `migration.test.ts` |
| ID-11 | El agente veía y operaba los cobros de todos los clientes, y podía crear uno con su propio enlace de pago a un cliente ajeno (desvío de pagos). | Como en conversaciones: el agente solo ve y opera cobros y pagos recurrentes de sus contactos asignados (lo demás, 404); el enlace de pago solo lo pone un administrador. | `visibility.test.ts`, `receivable-origins.test.ts` |
| AI-5 (parte) | El nombre del contacto de la página abierta entra al prompt del Copiloto y el turno contaba como limpio: con un nombre armado como instrucción, cambiaba la configuración sin tarjeta. | Una página de cliente marca el turno como contaminado (la configuración se confirma; lo de esa ficha sigue directo) y el nombre va marcado como escrito por el cliente. | `copilot.test.ts` |

**Revisión independiente de la etapa 3c.** Encontró que `checkZip` se saltaba con un fin de índice que declara menos
partes de las que trae (PizZip lee mientras haya firma: una bomba como segunda parte pasaba), que borrar los datos de un
contacto seguía sin código (otra vía para vaciar el historial), que el agente podía quitar el enlace de pago que puso un
administrador y que la página contaminada del Copiloto no quedaba guardada en el turno. Todo eso quedó corregido, con su
prueba. Lo que señaló y queda para después:
- Las llaves de API sin creador (`created_by` nulo, solo por borrados hechos directo en la base) ya no entran: revisar en producción antes de desplegar si hay alguna.
- El agente aún escribe texto libre que llega al cliente en el concepto y la referencia del cobro (podría poner ahí una cuenta).
- Un host con una etiqueta de más de 63 caracteres ya no se reconoce como enlace (solo su sufijo); no resuelve en DNS.
- Un `PUT /api/settings` con `retention.pending: null` cancela lo programado aunque venga de un panel desactualizado (borra menos y queda en la bitácora).

**Cambios que nota la gente:**
- Borrar los datos de un contacto pide el código si el último tiene más de 15 minutos.
- Descargar los CSV de contactos, conversaciones o mensajes, y guardar una regla que manda datos a una URL, un correo o un número nuevos, piden el código si el último tiene más de 15 minutos.
- La retención (Ajustes → Privacidad) la cambia solo el dueño, con 30 días como mínimo; si borra más, empieza 7 días después y le llega un correo («Cancelar el borrado programado» en Ajustes). Las cuentas con menos de 30 días quedaron en 30.
- Borrar un canal con conversaciones es del dueño, con el código.
- Bajar a un administrador a agente revoca sus llaves de API, pausa sus webhooks y cancela sus invitaciones (la confirmación lo dice).
- El agente ve solo los cobros de sus clientes y no pone enlaces de pago.
- Un mensaje de más de 8 000 caracteres se guarda recortado («…[mensaje recortado]»).
- Plantillas de cotización: hasta 2 000 marcas y 10 subidas por hora.
- En el Copiloto, con la ficha de un cliente abierta, los cambios de configuración y el texto que se guarda en su ficha piden confirmación.

## Etapa 3b′: lo que se corrigió de la revisión del 31 de octubre

Los medios de cobros de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md). PAY-4…PAY-16 (disputas, plan
del precio, códigos, CFDI y moneda) están en la [etapa 3b](#etapa-3b-cobros).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| PAY-17 | La prueba gratis empezaba sin huella de la tarjeta (Link u otro método en Checkout, o una lectura fallida en Mercado Pago). | Checkout pide solo tarjeta; Mercado Pago reintenta leerla; sin huella se trata como tarjeta ya usada («No pudimos leer tu tarjeta»). | `trial-start.test.ts` |
| PAY-18 | El portal de Stripe y «cambiar tarjeta» quedaban fuera de los topes y del freno de PAY-2 (prueba de tarjetas robadas). | Cada página del portal pasa por `openCardCheck` como sustitución: topes, freno y `card_checks`. | `card-check.test.ts` |
| PAY-19 | Límites del plan con carrera: 12 altas a la vez con límite 2 creaban 10. | `assertWithinLimitLocked`: cuenta dentro de la transacción del alta con la fila de la cuenta bloqueada (canales, asistentes, duplicar, aceptar invitación). | `limits.test.ts` |
| PAY-20 | No había tope de IA que el cliente no pudiera quitar, y un administrador «confirmaba» costos dudosos en 0. | Tope de IA al mes por plan y excepción por cuenta (superadmin), `TRIAL_AI_USD` en prueba; revisión de costos solo del superadmin. Migración 101. | `ai-platform-cap.test.ts` |
| PAY-21 | `runPlans` tomaba 2 000 planes de toda la plataforma: pasando eso, los nuevos no generaban cobros. | Recorre todos por lotes; hasta 500 pagos recurrentes activos por cuenta. | `receivable-origins.test.ts` |
| PAY-22 | Un pago que llegaba después de la global de su mes no se facturaba nunca. | Otra global del mismo mes (`seq`, con candado); aviso diario de pagos de más de 3 meses sin CFDI; `amount_cents` bigint. Migración 102. | `billing-cfdi.test.ts` |
| PAY-23 | Una cuenta en bucle vaciaba la cubeta de Zernio de todos. | Tope de 60 llamadas por minuto por cuenta antes de la cubeta compartida. | `zernio-budget.test.ts` |
| Bajos | `/precios` decía «sin tarjeta»; el freno se diluía con avisos repetidos; «ya pagué» pausaba los recordatorios para siempre. | Texto según `cardRequired()`; las verificaciones se completan solo al pasar a activa; 2 pausas por cobro. | `pricing.test.ts`, `card-check.test.ts`, `receivables-e2e.test.ts` |

**Cambios que nota la gente:**
- Checkout de Stripe acepta solo tarjeta; si no se puede leer, no hay prueba y se cobra al momento.
- El portal de Stripe cuenta para los topes de verificaciones de tarjeta (5 por día por cuenta).
- Cada plan tiene «Gasto de IA al mes (USD)» y cada cuenta una excepción («ia=20» en Límites); en prueba, `TRIAL_AI_USD` (5). Al llegar, la IA se detiene hasta el mes siguiente («Llegaste al tope de IA de tu plan»). Confirmar importes dudosos de IA es del superadmin.
- Hasta 500 pagos recurrentes activos por cuenta.
- Un cliente que dice «ya pagué» pausa sus recordatorios hasta 2 veces por cobro.

**Lo que había quedado para después, ya corregido:**
- La cubeta de Zernio guarda el 15 % para los mensajes directos y el 30 % para lo de segundo plano; el tope por cuenta cubre todo lo de un negocio (publicar, comentar, plantillas, conectar). `zernio-budget.test.ts`
- Las altas que dependen de terminar un OAuth (Meta, Zernio), reactivar un usuario y reanudar un pago recurrente pasan por el límite con candado. `limits.test.ts`, `receivable-origins.test.ts`
- La suscripción se vuelve a leer al proveedor ya con el candado: un aviso viejo no pisa al nuevo. `billing.test.ts`
- Una cotización se acepta una vez a la vez («Esta cotización se está aceptando en otra sesión»). `receivable-origins.test.ts`
- Planes privados: un plan no público solo lo ve y contrata la cuenta a la que el superadmin se lo asigna. Migración 104. `billing.test.ts`

**Queda para después:**
- Los montos de cada plan en «Gasto de IA al mes» los fija el dueño de la plataforma: sin ellos, solo aplica el de la prueba.

## Etapa 3b: cobros

El diseño está en [`superpowers/specs/2026-10-30-seguridad-etapa-3-registro-cobros-design.md`](superpowers/specs/2026-10-30-seguridad-etapa-3-registro-cobros-design.md).
PAY-14 ya se había cerrado en la 2b (los poderes del dueño).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| PAY-4/5 | Disputas: un aviso fuera de orden re-pausaba para siempre; una disputa abierta no detenía los cobros; una perdida dejaba la cuenta reactivarse con la misma tarjeta. | Cada aviso relee la disputa del proveedor (Stripe `/v1/disputes`; Mercado Pago el pago, también por el tema «chargebacks») y una ya resuelta no se reabre. Abierta: pausa y cobros detenidos (`pause_collection`; en Mercado Pago, suscripción en pausa, que no cuenta como pago pendiente). Ganada: se reanudan. Perdida: se cancela, la tarjeta queda marcada y la cuenta en pausa (`dispute_lost`) hasta pagar con otra; con la misma, esa suscripción se cancela y se reembolsa. Alerta temprana de fraude de Stripe: se reembolsa el cobro y se trata como perdida. Migración 106. | `billing-autopilot.test.ts` |
| PAY-7 | El plan salía de la metadata de Stripe y de la referencia de Mercado Pago, que se pueden cambiar por fuera. | Stripe: el plan sale del precio (su id configurado o el producto `riverrun_<plan>`, mismo periodo y monto no menor). Mercado Pago: la referencia vale solo si monto, moneda y periodicidad corresponden. Si no, el plan no cambia y se avisa al superadmin. | `billing.test.ts` |
| 3b.3 | Cupones de toda la cuenta de Stripe; el portal permitía cambiar de plan. | «Código de promoción» en Mi plan: solo códigos con `metadata.riverrun = '1'` (y, si los lista, del plan elegido), con tope de intentos; no aplica con Mercado Pago. El portal usa una configuración propia: tarjeta, facturas y cancelar al final del periodo, sin cambio de plan. | `billing.test.ts` |
| PAY-8 | Un pago reactivaba cuentas pausadas a mano; la conciliación pisaba el plan del superadmin. | `pause_reason = 'manual'` y `plan_source = 'manual'`: un pago, la conciliación o un aviso no los deshacen (si la suscripción dice otro plan, se avisa). Migración 105. | `billing.test.ts` |
| PAY-9 | El CFDI salía en pesos aunque el pago fuera en otra moneda. | En la moneda del pago con el tipo de cambio del movimiento de saldo de Stripe; sin uno confiable queda «pendiente: tipo de cambio» (aviso al superadmin, que lo captura en Planes y cobro). La global agrupa por moneda y tasa. Migración 107. | `billing-cfdi.test.ts` |
| PAY-10 | En Mercado Pago, «autorizada» se tomaba como pagada. | Ya lo cubría la conciliación: autorizada sin cobro aprobado pasa a pago pendiente a los 3 días. | `billing-autopilot.test.ts` |
| PAY-11 | De mensual a anual se trataba como bajar (saldo a favor) y de anual a mensual cambiaba al momento. | Mensual → anual se cobra hoy con prorrateo; anual → mensual se programa (calendario de la suscripción en Stripe) para el fin del año pagado, sin reembolso. En Mercado Pago sigue por sustitución. | `billing-plan-change.test.ts` |
| PAY-12 | El texto del proveedor llegaba al cliente. | Texto fijo por acción con referencia corta; el del proveedor, solo en la bitácora del sistema. | `billing-plan-change.test.ts` |
| PAY-13 | Un agente cambiaba monto o enlace de un cobro. | Solo un administrador; cada cambio de monto, moneda o enlace queda en la bitácora con el antes y el después. | `receivables-e2e.test.ts` |
| PAY-15 | La firma de Mercado Pago no cubría el id procesado; sin `x-request-id`; tolerancia de 1 hora. | Se procesa el id firmado (otro en el cuerpo: 400), `x-request-id` obligatorio, 5 minutos. | `billing.test.ts` |
| PAY-16 | Los planes públicos llevaban ids del proveedor y datos internos. | Solo lo que el panel usa; los ids, solo el superadmin. | `billing.test.ts` |

**Cambios que nota la gente:**
- Si un cliente desconoce un cobro, no se le cobra más mientras la disputa siga abierta; si la pierde, vuelve solo con otra tarjeta.
- En Mi plan hay un campo «Código de promoción» (solo con tarjeta). Para que un código sirva, en Stripe lleva la metadata `riverrun = 1` (y `riverrun_plans` para limitarlo a planes).
- El portal de Stripe ya no deja cambiar de plan: eso se hace en Mi plan.
- Pasar de anual a mensual empieza al terminar el año pagado; de mensual a anual se cobra al momento.
- Facturas de pagos en otra moneda: en esa moneda; las que esperan el tipo de cambio aparecen en Planes y cobro.
- En Stripe hay que agregar el evento `radar.early_fraud_warning.created` al webhook; en Mercado Pago, el tema «Contracargos».

**Queda para después:**
- En Mercado Pago no siempre se conoce la tarjeta de una contratación nueva: tras una disputa perdida, la cuenta sigue en pausa y el superadmin confirma a mano que es otra tarjeta.
- Mercado Pago no prorratea: de mensual a anual sigue por sustitución, con el primer cobro al terminar lo pagado.
- La factura global en otra moneda usa el tipo de cambio ponderado de sus pagos.

## Etapa 4′: lo que se corrigió de la revisión del 31 de octubre

Las entradas de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md) (PR 4 del
[plan](superpowers/plans/2026-10-31-seguridad-revision-correcciones.md)). El resto de la etapa 4 original (IN-2, IN-3,
IN-6/7 y PAY-6) sigue pendiente.

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| 4.1 | Los límites de las rutas vivían en la memoria de cada proceso (se reiniciaban y no se compartían) y contaban la IP tal cual (una IPv6 tiene millones). | `limited()` e `ipLimitKey()` sobre la base: reservas, invitaciones, restablecer, Google, pools, redes, API, cobros y los de IA. Una IPv6 cuenta por su /64. | `rate-limit-routes.test.ts` |
| IN-17 | El correo entrante no comprobaba al remitente: con `From: cliente@real.com` se escribía en el historial de ese cliente y se le contestaba. | Solo se contesta con DMARC o DKIM alineado (header.d o header.i del mismo dominio o subdominio) en el primer `Authentication-Results`, y solo si lo escribió el servidor del proveedor (Gmail, Microsoft, el del dominio IMAP o el configurado en «Remitentes»). Si no, se guarda con «[Remitente no verificado]», sin respuesta (`require_sender_auth` por canal). Tope de 60 respuestas por hora por canal, con aviso. | `email.test.ts` |
| IN-18 | La reserva pública no tenía captcha ni confirmación del correo, el tope por correo se saltaba con `+etiqueta` y servía de relé de correo. | Se guarda una solicitud y se manda un enlace (texto fijo, una hora, un solo uso, migración 110); la cita se agenda al abrirlo. Captcha cerrado ante fallas, el tope de 3 cuenta el correo normalizado y lo pendiente, 20 por día por enlace, el nombre va entre « » en el aviso. | `booking-page.test.ts`, `test:public:ux` |
| IN-19 | Sin cuota de almacenamiento ni ritmo en las subidas; una cuenta en pausa también subía. | `storage_mb` por plan (prueba: `TRIAL_MAX_STORAGE_MB`, 200): adjuntos, biblioteca y formatos. En pausa no se sube; 30 subidas por hora. | `attachments.test.ts`, `limits.test.ts` |
| IN-20 | La CSP estricta del panel se saltaba con `/%69ndex.html`. | La estricta es la de por omisión; solo una lista de páginas del servidor lleva `inline`, decidida sobre la ruta decodificada. `check-frontend` rechaza HTML crudo fuera de los módulos de dibujos. | `security-headers.test.ts`, `check-frontend.unit.test.ts` |
| IN-22 | El chat web se cerraba con ~10 conexiones, su GET no tenía límite y la sesión viajaba en la URL. | 20 clientes nuevos por red (/24 o /64) y hora por canal, 120 consultas por minuto por sesión, la sesión en la cabecera `x-webchat-session`. | `channels.test.ts`, `test:public:ux` |
| IN-5 | Adjuntos de Office con macros. | Un Word, Excel o PowerPoint debe ser un ZIP del formato (revisado con topes), con `[Content_Types].xml` y su carpeta, y sin `vbaProject.bin`. | `office-attachments.unit.test.ts` |
| Bajos (IN-8…IN-14) | Analizador JSON propio; `/contacto` mandaba el mensaje si Cloudflare no respondía. | `secure-json-parse` (`__proto__` → 400); el captcha de `/contacto` queda cerrado ante fallas. | `owner-self-service.test.ts` |
| Bajos | Zernio deduplicaba por una cabecera sin firma; las descargas de archivos de clientes conservaban su extensión y caracteres que invierten el texto. | Huella del cuerpo firmado; extensión del tipo detectado (o `.bin`) y nombres sin U+202A–202E ni U+2066–2069. | `zernio-events.test.ts`, `download-name.unit.test.ts` |

**Cambios que nota la gente:**
- Quien reserva en la página recibe un correo y la cita se agenda al abrir el enlace (vence en una hora; el horario no queda apartado mientras tanto). En producción la página pide captcha.
- Un correo cuyo remitente no se puede comprobar se guarda sin respuesta, marcado «[Remitente no verificado]». Se puede apagar por canal (`require_sender_auth`).
- Cada plan tiene «Archivos (MB)»; en la prueba, 200 MB. Una cuenta en pausa no sube archivos.
- No se aceptan Word, Excel ni PowerPoint con macros.

**Queda para después:**
- La conversión de plantillas DOCX aislada (IN-6/7, IN-21) y la firma del webhook de Evolution (IN-2), con la etapa 6.
- La lista de las páginas con `inline` se mantiene a mano: una página nueva del servidor sale con la CSP estricta hasta agregarla.
- Correo: se cree el `Authentication-Results` del servidor del proveedor (Gmail, Microsoft, el dominio del servidor IMAP o el que se configure en el canal). Un hosting que no agrega el suyo deja los correos sin respuesta (marcados) hasta configurarlo o apagar la comprobación en ese canal; quien adivine el nombre del servidor de un hosting sin el suyo puede escribir uno falso.
- Almacenamiento: la cuota se revisa antes de guardar, sin candado: subidas simultáneas pueden pasarla por poco (a lo más 30 por hora).
- Reservas: tres solicitudes pendientes con el correo de alguien le impiden reservar durante una hora; el tope de 20 por día por enlace cuenta cada solicitud.
- Zernio: solo se juntan los avisos con el mismo cuerpo firmado; si Zernio reintentara con un cuerpo distinto, se procesaría dos veces.

## Aislamiento entre cuentas (revisión del 4 de noviembre)

Revisión de todas las rutas (panel, API con llave, enlaces públicos, Copiloto, procesos en segundo plano y cachés): cada
ruta que recibe un id lo busca dentro de la cuenta de quien llama antes de leer o escribir, y los ids de otros objetos
que llegan en el cuerpo (asignar a una persona, mover a una etapa, usar un agente, una imagen o una secuencia) también se
comprueban. La base tiene además llaves foráneas compuestas `(id, account_id)` entre canales, agentes, contactos y
conversaciones (migración 010). Las 48 pruebas de aislamiento (559 casos) pasan.

| Qué | Arreglo | Prueba |
|---|---|---|
| Una línea de cotización guardaba el `price_item_id` tal como llegaba: se podía ligar a un concepto de la lista de precios de otra cuenta (no se leía de vuelta, pero si esa cuenta lo borraba, cambiaba la línea ajena). | Solo se liga a un concepto de la misma cuenta que la cotización; uno ajeno queda vacío. | `tenancy.test.ts` |
| `POST /api/v1/messages` con `conversation_id` aceptaba conversaciones del simulador (dentro de la propia cuenta); las demás rutas de la API las excluyen. | También las excluye. | `api-v1*.test.ts` |

## Bajos: IN-8…IN-14, AI-10…AI-13, INF-13…INF-15

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| IN-8…14 | El calendario `.ics` de la cuenta escapaba `\n` pero no `\r`: un nombre de cliente con un retorno de carro podía meter propiedades o eventos nuevos. | Todo salto (`\r\n`, `\r`, `\n`) se escribe `\n`, sin caracteres de control, y las líneas largas se doblan a 75 bytes (RFC 5545). | `lows.unit.test.ts` |
| IN-8…14 | El formulario `/contacto` ponía el nombre que escribió el visitante en el asunto del correo al soporte. | Asunto fijo (`Mensaje desde /contacto de …`); el nombre va en el cuerpo. Además, todo asunto sale como una sola línea, sin caracteres de control y con 150 caracteres como máximo. | `mailer.test.ts`, `lows.unit.test.ts` |
| IN-8…14 | Los regresos de Google Calendar, Outlook y Facebook ponían en la URL el texto del error, y el panel lo mostraba: cualquiera podía armar un enlace con el texto que quisiera dentro del panel. | La URL lleva solo un código (`error`, `cancelado`, `vencido`…). El panel muestra mensajes fijos, y el motivo queda en Registros. | `meta-connect.test.ts`, `google.test.ts` |
| IN-8…14 | Las descargas de páginas y adjuntos tenían un tiempo límite sin recibir datos, pero no un plazo total: un servidor que manda un byte cada 11 segundos las mantenía abiertas. Los adjuntos de Zernio y Telegram se leían enteros a memoria antes de medirlos. | Plazo total de 30 segundos (redirecciones incluidas) en `fetchPublic`. `readCapped` corta la lectura al pasar el tope de 16 MB, aunque no haya `Content-Length`. | `lows.unit.test.ts` |
| AI-10 | El Copiloto solo trataba como texto de clientes lo que venía en `datos_del_cliente`, pero nombres, etiquetas y textos de pendientes (que pueden escribir clientes: su nombre de WhatsApp, el de una reserva) llegaban fuera de esa clave. | El texto de los pendientes va dentro de `datos_del_cliente`, y las instrucciones del Copiloto nombran también `nombre`, `cliente`, `contacto`, etiquetas y conceptos como datos, nunca instrucciones. Los cambios de configuración ya se confirmaban tras leer a un cliente (AI-3). | `lows.unit.test.ts` |
| AI-11 | `import-reviewed` aceptaba cualquier esquema en `source_url` (`javascript:`, `data:`), y la dirección se guardaba y registraba tal cual: el agente la podía citar a un cliente con su usuario, contraseña o token. | Solo http(s), y sin usuario, contraseña, query ni fragmento, al guardar (también desde el editor de conocimiento) y al registrar. | `lows.unit.test.ts` |
| AI-12 | El tope de costo y de tiempo de un pedido del Copiloto se revisaba solo antes de cada llamada al modelo: varias herramientas con IA por dentro en una misma respuesta (p. ej. `crear_flujo`) podían pasarlo muchas veces. | También antes de cada herramienta: si lo que gastaron las anteriores de esa respuesta ya pasó el tope, o se acabó el tiempo, las siguientes devuelven `limite` y el pedido termina con un resumen. | `copilot.config.test.ts` |
| AI-13 | Correr las pruebas de un agente (hasta 40 llamadas y USD 1 cada vez) no tenía límite: solo una a la vez por agente, en paralelo entre agentes. | 6 corridas por hora por cuenta (429 después). | `agent-versions.test.ts` |
| INF-13 | Sin SMTP, la bitácora guardaba el cuerpo de cada correo (datos de clientes; los tokens ya iban ocultos desde la 2b). | Solo destinatario, asunto y largo. El buzón de pruebas en memoria sigue igual. | `mailer.test.ts` |
| INF-14 | `.gitignore` solo cubría `.env`. | También `.env.*` (salvo `.env.example`), llaves (`*.pem`, `*.key`, `id_*`), respaldos (`*.gpg.tar`, `*.tar.enc`, volcados), `uploads/` y registros, en la plataforma y en la raíz. | `git ls-files -ci` vacío |
| INF-15 | Las acciones de GitHub iban por etiqueta (`@v4`), que su dueño puede mover; nada avisaba de dependencias con fallas nuevas ni buscaba secretos. | Cada acción fijada al commit que hoy tiene su etiqueta, con la versión en un comentario. Dependabot (npm, acciones, imágenes de Docker) cada semana. Flujo «Seguridad»: gitleaks (descarga verificada por su suma) sobre lo que cambia en cada PR y cada push, y cada semana sobre todo el historial, más `npm audit`. | CI |

## Etapa 9: el servidor (`./riverrun harden` e INF-12)

Riverrun se instalaba sobre el servidor tal como venía: SSH con contraseña, sin firewall, sin parches automáticos. Y
Docker publica sus puertos por encima de ufw, así que un firewall puesto a mano no frenaba lo que publicaran los
contenedores.

| Qué | Cómo | Prueba |
|---|---|---|
| `sudo ./riverrun harden` | En Debian y Ubuntu (y en la familia Red Hat: abajo), como root, con confirmación (o `--yes`). Se puede repetir: solo reescribe sus archivos. **Actualizaciones de seguridad** automáticas (`unattended-upgrades`; Docker no se actualiza solo, para no reiniciar los servicios). **Puertos de SSH**: los que dice `sshd -T`, los que están abiertos (`ss`; con `ssh.socket`, Ubuntu 24.04 no usa el `Port` de `sshd_config`) y el de la sesión actual; si no se sabe ninguno, no toca nada. **fail2ban** en esos puertos (5 intentos en 10 minutos, una hora fuera), sin bloquear nunca la IP de quien corre `harden`. **SSH solo con llave** (`01-riverrun.conf`, que va antes que `50-cloud-init.conf`: sin contraseñas, root solo con llave; `ChallengeResponseAuthentication` en OpenSSH anterior a 8.7): solo si la cuenta de quien corre `harden` (`SUDO_USER`, o root) tiene una llave válida (`ssh-keygen -l`); la de otra persona no cuenta. Se valida con `sshd -t` antes de recargar (si no es válida, se quita) y después con `sshd -T -C`, que también evalúa los bloques `Match`. **Firewall** (ufw): entra SSH con límite de intentos y, con dominio, 80 y 443 (TCP y UDP para HTTP/3), más `HARDEN_ALLOW_PORTS`. SSH se permite antes de encender el firewall. | `scripts/test-cli.sh` |
| Fedora, AlmaLinux, Rocky y RHEL | Lo mismo con sus herramientas: `dnf-automatic` solo con las de seguridad y aplicándolas (`upgrade_type = security`, `apply_updates = yes`, copia del archivo antes), fail2ban desde EPEL (Fedora ya lo trae), SSH igual, y `firewalld` en lugar de ufw: SSH y los puertos públicos en la zona por omisión, y las mismas reglas de `DOCKER-USER` como reglas directas (se quitan las de antes y se ponen otra vez). | `scripts/test-cli.sh` |
| Lo que publica Docker | Reglas en la cadena `DOCKER-USER` (que ufw no ve), en `after.rules` y `after6.rules` entre marcas propias: de afuera solo entra a los contenedores lo de la lista; lo que sale de los contenedores (por su puente, `docker0` o `br-…`: no por rango de IP, así otra máquina de la red privada del proveedor tampoco pasa), entre ellos y las respuestas sigue igual. Con `PANEL_BIND=0.0.0.0` por error, el puerto 3000 queda cerrado hacia afuera (y se avisa). Se guarda copia de cada archivo, un bloque a medias no se toca, y antes de encender el firewall `iptables-restore --test` revisa los archivos (si no pasan, se restauran y no se enciende). | `scripts/test-cli.sh` |
| `preflight` | Avisa si el servidor no se ha endurecido (la marca `/etc/riverrun-harden`). | `scripts/test-cli.sh` |
| INF-12 | El instalador imprimía `BACKUP_PASSPHRASE`, `SESSION_SECRET` y la contraseña del administrador: quedaban en el historial de la terminal y en los registros de quien lo automatiza (cloud-init, CI). Ahora no imprime ninguna llave: `./riverrun keys` las muestra a propósito (también `DATA_KEY` y `DATA_KEYS_OLD`, que antes ni se mencionaban) y solo a una terminal (`--stdout` para quien de verdad lo quiera en un archivo). La contraseña inicial solo se muestra a una terminal; si no, se dice cómo crear una. | `scripts/test-cli.sh` |

**Cambios que nota la gente:**
- Al terminar, `install` dice que las llaves se guardan con `./riverrun keys` y que se corra `sudo ./riverrun harden`.
- Después de `harden`, hay que entrar por SSH con llave. Antes de cerrar la sesión, conviene probar entrar desde otra terminal.

**Queda para después:**
- `./riverrun admin-password` sigue mostrando la contraseña nueva: es lo que se pidió, en la consola del servidor.

## Etapa 7: detección

Hasta aquí nadie se enteraba si alguien probaba contraseñas, entraba como superadmin desde otro lado o se llevaba los
datos: lo poco que quedaba estaba revuelto en la bitácora general, que se depura y se borra con la cuenta.

| Qué | Cómo | Prueba |
|---|---|---|
| Bitácora de seguridad | `security_events` (migración 112), aparte de la bitácora general y sin llaves foráneas: se conserva `SECURITY_LOG_DAYS` (365) aunque la cuenta o la persona ya no existan. Anota: entradas al panel (con cómo y si pidió el código), contraseñas fallidas (con la cuenta de la persona, si es una) y accesos frenados por el límite (una fila por IP o cuenta cada 15 minutos, no una por intento), códigos de 2FA equivocados, cada aviso de seguridad que recibe una persona (contraseña, 2FA, dispositivo nuevo, rol, dueño, correo, retención), llaves de la API creadas o revocadas, cambio del secreto de los webhooks, descargas de datos (la cuenta en ZIP, los CSV, los datos de un contacto), contactos borrados y cuentas borradas. Lo que se escribe en el campo del correo y no es una cuenta no se guarda (puede ser una contraseña): solo una huella con llave para contar cuántos se probaron. Las descargas se anotan ya validadas. Nunca rompe lo que se estaba haciendo. | `security-log.test.ts` |
| Detección | Al anotar, unas reglas buscan lo que no es normal y avisan al superadmin por el canal de las alertas del sistema (correo y `ALERT_WEBHOOK_URL`), una vez por hora por regla y objetivo (aunque haya varios procesos): 8 intentos fallidos en 15 minutos desde una IP contra 5 o más correos (listas de contraseñas); 10 contra una persona (fuerza bruta); 100 en toda la plataforma (una lista probada desde muchas IP); un superadmin que entra desde un dispositivo nuevo o cuyo 2FA se bloquea; 5 descargas de datos de una persona en una hora; 25 contactos borrados por una persona en una hora. Cada aviso también queda en la bitácora. Tope de 10 avisos enviados por hora en total: pasado eso se manda uno solo de «demasiados avisos» y el resto solo se anota (quien elige la IP o el correo no puede inundar al superadmin). El envío no detiene la petición que cruzó el umbral, y si falla se reintenta en el siguiente evento. | `security-log.test.ts` |
| Umbrales y lo normal de cada persona | Los umbrales se ajustan en `.env` (`SECURITY_STUFFING_FAILURES`, `SECURITY_BRUTEFORCE_FAILURES`, `SECURITY_EXPORTS_PER_HOUR`…; ver `.env.example`). Las descargas y los borrados se comparan además con lo normal de cada persona: avisa al doble de su hora más alta de los 30 días anteriores, nunca por debajo del umbral (quien descarga mucho todos los días no dispara el aviso por hacer lo de siempre). | `security-log.test.ts` |
| Bloqueo automático de IP | Una IP que prueba listas de contraseñas no puede entrar `SECURITY_AUTOBLOCK_MINUTES` (60; 0 = solo avisar), aunque traiga una contraseña buena: usa el mismo contador del límite por IP, se anota (`ip.blocked`) una vez por ventana y el aviso lo dice. El superadmin la desbloquea en Sistema → Seguridad (botón «Desbloquear», `POST /api/system/security/unblock`, anotado como `ip.unblocked`). | `security-log.test.ts` |
| Lo que se agregó después | Accesos con Google rechazados, con el motivo (los que no tienen cuenta detrás, una fila por IP cada 15 minutos); cerrar una sesión o las de otros dispositivos; invitaciones creadas, reenviadas, canceladas y aceptadas; dar de baja, volver a dar de alta, pasar a otra cuenta o eliminar a una persona; pedir restablecer la contraseña (solo si es una cuenta, en segundo plano: la respuesta no cambia) y enlaces para restablecer inválidos o vencidos. En el panel, con filtros para Sesiones, Restablecer contraseña, Altas y bajas del equipo e Invitaciones. | `security-log.test.ts`, `google-login.test.ts` |
| Quién la ve | El superadmin, toda (Sistema → Seguridad, con filtros y los avisos). Cada administrador, la de su cuenta (Ajustes → Actividad de seguridad), incluidos los intentos fallidos contra su gente: sin los avisos de la plataforma y sin la IP completa ni el navegador de otras personas. Los agentes, no. | `security-log.test.ts` |

**Cambios que nota la gente:**
- Sistema muestra la tarjeta «Seguridad» y Ajustes, «Actividad de seguridad».
- Con `ALERT_WEBHOOK_URL` o `SUPERADMIN_EMAIL`, los avisos de seguridad llegan al momento (empiezan con 🔐).

**Queda para después:**
- Cuando un superadmin actúa dentro de una cuenta, esa cuenta ve su correo y su IP recortada en la bitácora (a propósito).

## Etapa 6″: los medios de secretos, datos, contenedores, respaldos y despliegue

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| INF-6 | `rotate-secret` rompía más de lo que avisaba: los tokens de Google y Outlook, las llaves de la plataforma y el 2FA dependían de SESSION_SECRET; no había versiones de llave. | Llave de datos aparte (`DATA_KEY`): lo cifrado lleva el id de su llave (`v2.<kid>`) y `DATA_KEYS_OLD` sigue descifrando durante una rotación; lo de antes (`v1`, con SESSION_SECRET) se sigue leyendo. `./riverrun` la genera en `install` y `update`. `rekey-secrets` pasa todo a la llave actual (2FA todo o nada; lo ilegible se cuenta). `rotate-secret` re-cifra antes con `DATA_KEY` y ya no obliga a reconectar; nuevo `rotate-data-key` (arranca con la nueva y la anterior, y luego re-cifra). `config-check` avisa si falta, es débil o es igual a SESSION_SECRET. | `rekey-secrets.test.ts`, `config-check.test.ts`, `scripts/test-cli.sh` |
| INF-7 | Credenciales de canales (llave de Evolution, Telegram, Meta, IMAP/SMTP, secreto del webhook) en claro en la base. | Se cifran al guardar y se descifran al leer, en el almacén (`src/channel-secrets.ts`): el resto del código no cambia. Las de antes se cifran al arrancar. | `rekey-secrets.test.ts` y las de canales |
| INF-8 | Evolution guardaba todos los mensajes sin retención y el borrado de un contacto no llegaba a su base. | El backend (que ya no entra a esa base) deja la solicitud en `evolution_erasures`; el contenedor de respaldos, cada hora, borra en Evolution los mensajes de ese chat (por `remoteJid` y `remoteJidAlt`, solo en su instancia), marca la solicitud y le quita los identificadores, y borra los mensajes de más de `EVOLUTION_MESSAGE_DAYS` (7). | `compliance.test.ts`, `scripts/test-evolution-cleanup.sh` (PostgreSQL real, en CI) |
| INF-9 | Contenedores sin topes de memoria ni rotación de registros. | Cada servicio con `mem_limit` (ajustable en `.env`) y `pids_limit`; registros `json-file` de 3 × 10 MB. | `docker compose config`, `scripts/test-staging-overlay.sh` |
| INF-10 | `PANEL_BIND=0.0.0.0` publicaba el panel por encima de ufw sin aviso. | `install`, `update` y `preflight` lo avisan (Docker abre el puerto por su cuenta). | `scripts/test-cli.sh` |
| INF-11 | Respaldo: directorio de trabajo en claro, credencial de S3 que puede borrar, cifrado sin autenticación. | Cada parte se cifra con gpg (AES-256 con verificación de integridad) mientras se escribe: nada queda en claro. La verificación descifra en memoria; restaurar descifra y comprueba todo antes de borrar nada. Los `.tar.enc` de antes se siguen abriendo. La copia en la nube ya no borra: basta una llave que solo suba (la limpieza la hace el ciclo de vida del bucket; `BACKUP_REMOTE_PRUNE=true` para lo de antes). | `scripts/test-backup.sh` (parte alterada con sus sumas rehechas, respaldo de antes) |
| IN-6/7 | Las plantillas DOCX las procesaba LibreOffice dentro del backend, con todos los secretos en su entorno; una sola cola de PDF para todas las cuentas. | Contenedor `pdf` (Gotenberg con LibreOffice, fijado por digest) sin secretos y en una red interna sin internet; es lo de por omisión. Con `soffice`, LibreOffice ya no hereda las variables del backend y `config-check` lo avisa en producción. Una cola por cuenta, por turnos, con 5 conversiones sin terminar como máximo (429). | `pdf-queue.unit.test.ts`, `quotes-template.unit.test.ts` (LibreOffice real) |
| INF-4 | `update` desplegaba lo que hubiera en `main` sin verificar CI ni firma. | Antes de tocar nada consulta en GitHub el flujo `ci.yml` del último commit del rango que cambió la plataforma: debe haber terminado en verde (en rojo, corriendo, sin corrida o sin respuesta, no se aplica). Se despliega exactamente ese commit. Opcional: `UPDATE_ALLOWED_SIGNERS` (fuera del repositorio) exige la firma. `--skip-ci-check` para emergencias, a la vista. | `scripts/test-cli.sh` |

**Cambios que nota la gente:**
- La primera actualización genera `DATA_KEY` (no se muestra): guárdala fuera del servidor junto con SESSION_SECRET y BACKUP_PASSPHRASE.
- Aparece el contenedor `pdf`. Los respaldos nuevos terminan en `.gpg.tar`.
- `./riverrun update` necesita salir a `api.github.com` y espera a que el CI del commit termine en verde.
- Si la copia en la nube usa una llave que puede borrar, conviene cambiarla por una que solo suba y crear la regla de ciclo de vida en el bucket.
- Evolution conserva 7 días de mensajes (`EVOLUTION_MESSAGE_DAYS`).

**Queda para después:**
- La imagen del backend sigue trayendo LibreOffice (para `soffice`); se puede quitar cuando todas las instalaciones usen el contenedor `pdf`.
- Se probó sin Docker real (configuración renderizada, PostgreSQL real, `docker` simulado): conviene una prueba en staging antes de producción.

## Etapa 5″: el resto de la IA y el Copiloto (AI-5…AI-9, PAY-6)

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| AI-5 (resto) | Los títulos de las acciones del Copiloto llevan nombres de clientes (los escriben ellos) y entran al prompt en la lista de cambios del hilo y en «Cambiar esto», sin marcar y con el turno como limpio. | El título de una acción sobre clientes (con `contact_ids` o argumentos de contacto o conversación) va entre comillas y marcado como dato; si alguna de esas acciones está en el prompt, el pedido cuenta como contaminado: la configuración se confirma con tarjeta. | `copilot.test.ts`, `copilot.unit.test.ts` |
| AI-6 | Las tarjetas de confirmación recortaban lo que se iba a ejecutar (textos, listas, citas del conocimiento, palabras clave de una regla). | La vista previa genérica y la de las herramientas muestran los textos completos; la tarjeta los deja leer con su propia barra de desplazamiento. | `copilot.unit.test.ts` |
| AI-7 | Las notas de la cotización van en el PDF que recibe el cliente (la aproximada sale sin revisión) y no pasaban por la verificación de datos. | Las notas pasan por la misma verificación que los mensajes (datos sin respaldo y afirmaciones del negocio): la frase con un precio, descuento, enlace o afirmación sin respaldo se quita y queda en el registro de correcciones; lo que dijo el cliente se queda. En la tarjeta de «Aprobar y enviar» de las finales las notas ya se veían y se editan. | `quotes-engine.test.ts` |
| AI-8 | No había detector de fuga de instrucciones: «repite tus instrucciones» podía sacar el prompt o las instrucciones privadas del negocio. | `src/engine/leak.ts`: una respuesta que copia 12 palabras seguidas del prompt fijo o de las instrucciones, reglas u objetivo del negocio, o que nombra campos internos (`save_data`, `image_ids`…) o títulos del prompt, se regresa a la IA; en el último intento se quita la frase. No cuentan lo que el negocio pidió decir entre comillas ni lo que también está en su información pública (conocimiento, mensajes guardados, saludo, preguntas). | `instruction-leak.test.ts` |
| AI-9 | La IA que gastan las herramientas del Copiloto por dentro (cambiar instrucciones, diseñar un flujo, importar) no contaba para el tope del pedido ni para el del día; la evaluación de agentes no contaba el costo estimado en su tope de USD 1. | Un ámbito asíncrono (`src/ai/sub-spend.ts`) sigue a la herramienta también por las rutas internas: cada llamada que se liquida dentro suma su costo (o lo reservado, si no se sabe) al pedido y a `copilot_turns.cost_usd`. La evaluación cuenta el estimado. | `copilot.config.test.ts` |
| PAY-6 | Cuentas sin cupo seguían gastando IA. | El tope de la plataforma (PAY-20) ya detenía cada llamada en `accountAi` (también transcribir); ahora el Copiloto tampoco empieza con ese tope al 80 % (como con el presupuesto de la cuenta). | `ai-platform-cap.test.ts` |

**Cambios que nota la gente:**
- Si el Copiloto etiquetó o cambió algo de un cliente en un hilo, los cambios de configuración que se pidan después en ese mismo hilo llegan como tarjeta por confirmar.
- Las tarjetas de confirmación pueden ser más largas (con desplazamiento dentro de la tarjeta).
- El asistente ya no repite su prompt ni las instrucciones privadas aunque se lo pidan; si insiste, la frase sale del mensaje.

**Queda para después:**
- AI-10…AI-13 están en la lista de la etapa 5 pero no tienen descripción registrada en ningún documento ni en el historial: hace falta una auditoría nueva de la IA para saber qué eran o si siguen aplicando.
- El detector de fuga compara texto literal: una paráfrasis o una traducción de las instrucciones no la detecta.

## Etapa 5′: lo que se corrigió de la revisión del 31 de octubre

La IA de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md) (PR 5 del
[plan](superpowers/plans/2026-10-31-seguridad-revision-correcciones.md)). El resto de la etapa 5 original va en la 5″.

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| AI-14 | `crear_regla` y `cambiar_regla` del Copiloto no seguían la cadena de etiquetas: «a quien escriba, etiquétalo promo» se creaba sin tarjeta y disparaba una regla existente de envío masivo. | Las dos herramientas declaran lo que la regla, activa, dispara (`actionEvents`: etiqueta, dato guardado, pasar a una persona, pausar al asistente); `assessRisk` busca las reglas activas que mandan algo afuera y sigue la cadena por esos mismos eventos (hasta tres saltos), como ya hacía `etiquetar`. Una regla en pausa, o solo renombrarla o pausarla, sigue sin tarjeta. | `copilot.config.test.ts` |
| Bajo | Con un proveedor que no reporta `cost_usd` (distinto de OpenRouter), el Copiloto sumaba 0 y su tope por pedido nunca cortaba. | Al liquidar la llamada, quien llama recibe una copia con el costo estimado con `ai_prices` y los tokens (`cost_estimated`); la respuesta del proveedor no se toca. | `copilot.test.ts` |
| Bajo | Importar una página guardaba el texto que la página esconde (`display:none`) y se podía guardar sin revisar (`save`). | `htmlToText` salta lo oculto (`hidden`; en el estilo en línea `display:none`, `visibility:hidden|collapse`, `opacity:0`, `font-size:0`, con entidades, comentarios y escapes de CSS resueltos) con su contenido, en tiempo lineal; solo cuentan los atributos reales y el `>` dentro de comillas no corta la etiqueta. Un oculto sin cierre descarta lo que sigue. `aria-hidden` no cuenta (no oculta a la vista). La importación ya no guarda con `save`: devuelve la propuesta y se guarda desde la revisión («Volver a sincronizar» también abre la revisión). | `html-to-text.unit.test.ts`, `import.test.ts` |
| Bajo | Las respuestas automáticas en redes podían publicar lo que el comentario indujera. | Además de los datos sin respaldo, va a revisión una respuesta con `@`, `#` (también de ancho completo) o un enlace (cualquier dominio, IP o `bit[.]ly`), con más de la mitad de sus palabras largas fuera de la información del negocio y del comentario (con al menos 4), o que repite tres o más palabras del comentario que no están en la información del negocio. La bandeja dice el motivo. | `social-comments.test.ts` |

Revisión independiente: encontró la cadena de reglas por «pasar a una persona» y datos guardados, una pasada no lineal con nombres de etiqueta distintos, formas de esconder texto que no se detectaban (`>` en comillas, entidades, comentarios de CSS) y menciones o enlaces que se colaban; todo quedó corregido y probado.

**Cambios que nota la gente:**
- «Volver a sincronizar» ya no guarda directo: muestra lo leído para revisarlo y guardarlo.
- Algunas respuestas automáticas en redes que antes salían solas ahora esperan a una persona (menciones, etiquetas, enlaces o contenido que no está en la información del negocio).

**Queda para después:**
- Lo que una página oculta con una hoja de estilos (una clase) no se detecta; tampoco el texto del mismo color que el fondo.
- La revisión del vocabulario de las respuestas en redes es por palabras (umbral fijo), no por significado; una frase corta (menos de 4 palabras largas) no la activa.
- AI-14: la cadena de reglas no sigue los cambios de columna del embudo que hace una etiqueta, y se corta a los tres saltos.
- Con un modelo sin precio en `ai_prices`, el tope por pedido del Copiloto sigue sin poder contar el costo.
- `npm run eval:copilot` (simulado): 20 de 22. «dato» y «oportunidad» ya fallaban igual en `main` antes de esta etapa (el Copiloto propone en lugar de aplicar); se revisan aparte.

## Etapa 6′: lo que se corrigió de la revisión del 31 de octubre

Secretos y datos de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md) (PR 6 del
[plan](superpowers/plans/2026-10-31-seguridad-revision-correcciones.md)). El resto de la etapa 6 original (INF-6…INF-8,
INF-13) y la conversión aislada de plantillas (IN-6/7) siguen pendientes.

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| Bajo | «Descargar mis datos» incluía en `cuenta.json` el `calendar_token` (agenda pública en .ics) y el `webhook_secret` (firma de los avisos a otras apps); un ZIP se reenvía. | `cuenta.json` sin esos dos ajustes ni `deletion_nonce`; `cotizaciones.json` sin las rutas de archivos del servidor. Los canales ya solo exportaban id, tipo y nombre. | `owner-self-service.test.ts` |
| Bajo | `HTTP_LOG=true` registraba las URLs con tokens (webhook de WhatsApp, calendario, reservas, cotizaciones, chat web, borrar la cuenta, OAuth). | Serializadores propios en el logger de Fastify: la ruta sin query, sin los segmentos de los enlaces públicos (también con mayúsculas o `//`) ni los que tienen forma de token, sin cabeceras; los mensajes (el «Route … not found» de Fastify) y los errores también se limpian. Los errores 500 que van a la bitácora de la base usan la misma ruta limpia. | `http-log.unit.test.ts` |
| IN-21 | La revisión del DOCX solo miraba `TargetMode="External"`: pasaban `INCLUDEPICTURE`, `INCLUDETEXT`, `LINK` y DDE en códigos de campo, que LibreOffice (dentro del backend) puede seguir a la red interna o a archivos locales. | Se rechazan los campos `INCLUDEPICTURE`, `INCLUDETEXT`, `INCLUDE`, `IMPORT`, `LINK`, `DDE`, `DDEAUTO`, `RD` y `DATABASE` (cada campo armado con sus trozos entre su inicio y su fin, por su primera palabra) y los `src`/`href` que no son un ancla interna ni `data:`, con cualquier prefijo, sin comentarios ni CDATA y respetando `>` dentro de los valores, en todas las partes de texto del archivo. Se rechaza un documento principal distinto de `word/document.xml` y las partes en UTF-16. | `quotes-template.unit.test.ts` |

Revisión independiente: encontró campos señuelo que escondían el peligroso al juntarlos, CDATA, comentarios, otro prefijo de espacio de nombres, otra parte principal, UTF-16, rutas locales en VML, falsos positivos (`HYPERLINK …/link`, `MERGEFIELD import_date`), errores y rutas con mayúsculas en la bitácora; todo quedó corregido y probado.

**Cambios que nota la gente:**
- Un formato de Word con campos que cargan contenido de afuera (imágenes o texto vinculados, DDE) se rechaza con «El archivo tiene campos que cargan contenido de afuera: quítalos».

**Queda para después:**
- La conversión de plantillas sigue dentro del backend (IN-6/7): esta revisión es la primera barrera, no el aislamiento.
- La bitácora HTTP oculta los tokens de las rutas conocidas y los que parecen token; un token corto y sin dígitos en una ruta nueva no se reconocería.

## Etapas 9′ y 10′: lo que se corrigió de la revisión del 31 de octubre

Servidor y cadena de suministro de [la revisión del 31 de octubre](revision-seguridad-2026-10-31.md) (PR 7 del
[plan](superpowers/plans/2026-10-31-seguridad-revision-correcciones.md)). Con esto, cada hallazgo de esa revisión tiene su
PR (tabla «Estado» al inicio de la revisión).

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| Bajo | Las claves de ejemplo de `.env.example` (`cambia-esta-clave`, públicas) solo daban aviso en producción. | Con `NODE_ENV=production`, la contraseña de la base (`POSTGRES_PASSWORD` o la de `DATABASE_URL`), `EVOLUTION_API_KEY` y `SESSION_SECRET` con el valor de ejemplo (también con espacios o comillas alrededor) son críticas: el servidor no arranca (`CONFIG_VALIDATION=warn` deja salir de un apuro). Una clave débil que no es la de ejemplo sigue siendo aviso, para no tumbar instalaciones existentes. `ADMIN_PASSWORD` de ejemplo sigue como aviso: el servidor ya se niega a usarla con HTTPS y el instalador la vacía. | `config-check.test.ts` |
| Bajo | El instalador ofrecía `curl https://get.docker.com \| sh` (un script de internet ejecutado como root). | `./riverrun install-docker` (y la pregunta de `install`): repositorio apt oficial de Docker; la llave se baja, se revisa su huella (`9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`) antes de guardarla en `/etc/apt/keyrings/docker.asc`, y el repositorio queda firmado con ella. Con otra huella, o con más de una llave en el archivo, no instala nada. Los derivados de Ubuntu (Mint, Pop!_OS) usan el repositorio de Ubuntu con su `UBUNTU_CODENAME`; la versión se valida antes de escribirla; fuera de eso manda a la guía oficial. | `scripts/test-cli.sh` |

Revisión independiente: encontró que espacios o comillas saltaban la regla, que `POSTGRES_PASSWORD` no se revisaba sin `DATABASE_URL`, que solo se revisaba la primera llave del archivo de Docker, los derivados de Ubuntu, la versión sin validar y el gancho de pruebas `RIVERRUN_ETC` (ahora solo con `RIVERRUN_TEST=1`); todo quedó corregido y probado.

**Cambios que nota la gente:**
- Un servidor de producción con la contraseña de la base, la clave de Evolution o `SESSION_SECRET` de ejemplo ya no arranca: el mensaje dice qué cambiar. `./riverrun install` siempre generó claves propias, así que solo afecta a un `.env` copiado a mano sin cambiarlas. Si `install` reemplaza la contraseña de ejemplo de una base que ya existía, avisa y da el `ALTER USER` para cambiarla también dentro de PostgreSQL.

**Queda para después:** `./riverrun harden` (INF-11, INF-12) y la cadena de suministro de fondo (INF-4, INF-15), en las etapas 9 y 10 originales.

## Etapa 8: contenedores (los altos INF-2 e INF-3)

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| INF-2 | El backend, Evolution y el respaldo entraban a PostgreSQL con el mismo superusuario: un fallo en Evolution leía las conversaciones del backend, y uno en el backend podía ejecutar programas en el servidor de la base (`COPY … PROGRAM`). Redis, que guarda las claves de las sesiones de WhatsApp, no tenía contraseña, y todo estaba en una sola red. | `docker/db-roles.sql`: `riverrun_app` (dueño de la base `chatbot`) y `riverrun_evolution` (dueño de `evolution`), sin superusuario, sin crear bases ni roles, y cada uno solo puede conectarse a su base; todo lo de `public` pasa a su dueño y el superusuario deja creadas `pgcrypto` y `vector`. `./riverrun` lo aplica en `install` (antes de arrancar), en `update` (después del respaldo; si falla, la versión nueva no se aplica) y en `restore`, y a mano con `./riverrun db-roles`. Redis con contraseña (`REDIS_PASSWORD`, generada). PostgreSQL y Redis en una red interna sin salida a internet que Caddy no alcanza. La vuelta atrás de `update` regresa primero la base y Redis a la configuración anterior. Aviso en la revisión de configuración si producción sigue con el superusuario. | `scripts/test-db-roles.sh` (PostgreSQL real: base migrada por el superusuario y base nueva migrada por la app), `scripts/test-cli.sh`, `config-check.test.ts` |
| INF-3 | `./riverrun update` nunca actualizaba Caddy, Node, Redis ni PostgreSQL. | `update` construye con `--pull` (la base de Node del backend y del respaldo con sus parches) y descarga Redis y Caddy de su misma etiqueta. PostgreSQL no se cambia solo: cambiar su imagen sobre un volumen existente sigue con su procedimiento (`docs/semantic-activation.md`). | `scripts/test-cli.sh` |

Revisión independiente: encontró que la vuelta atrás dejaba al backend anterior sin alcanzar la base (seguía en la red interna) y a Evolution sin poder entrar a Redis (seguía con contraseña), y que en una instalación nueva los usuarios podían crearse mientras PostgreSQL aún corría sus scripts de inicio (solo escucha en el socket); ambos quedaron corregidos (la base y Redis vuelven primero; la espera es por TCP, también en su revisión de salud).

**Cambios que nota la gente:**
- La primera actualización con esta versión reinicia PostgreSQL y Redis (cambian de red, y Redis toma su contraseña) además del backend y Evolution: unos segundos sin servicio, como en cualquier actualización. Las sesiones de WhatsApp se conservan (Redis guarda sus datos en su volumen).
- `.env` gana `DB_APP_USER`, `DB_APP_PASSWORD`, `DB_EVOLUTION_USER`, `DB_EVOLUTION_PASSWORD` y `REDIS_PASSWORD` (los genera `./riverrun`; no se muestran).
- Quien levante los contenedores con `docker compose` sin `./riverrun` sigue funcionando con el superusuario hasta correr `./riverrun db-roles`.

**Queda para después:**
- El respaldo sigue con el superusuario: comprueba cada copia restaurándola (crea una base y la extensión `vector`). No tiene puertos ni recibe tráfico de afuera.
- Si cambia la versión de pgvector en la imagen, la extensión instalada no se actualiza sola (el backend ya no puede): se hace con el superusuario (`ALTER EXTENSION vector UPDATE`).
- Límites de memoria y rotación de registros (INF-9) y el aviso de `PANEL_BIND=0.0.0.0` (INF-10).
- Se probó con PostgreSQL real y con un Docker simulado; en esta revisión no hubo Docker real: conviene una prueba en un servidor de staging antes de producción.

## IN-2 e IN-3: webhooks entrantes

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| IN-2 | El webhook de Evolution no tenía firma (solo el token en la URL) y su ruta era pública en Caddy: con el token se podían inventar mensajes de cualquier cliente de WhatsApp. | Con `WEBHOOK_BASE_URL` interna (en Docker, `http://backend:3000`), Evolution le habla al backend por la red interna, sin Caddy. Un aviso de WhatsApp que llega por el proxy (trae `X-Forwarded-For`) o desde una IP pública se responde como un token que no existe (404) y no se procesa. | `webhook-hardening.test.ts` |
| IN-3 | Los webhooks aceptaban cuerpos de hasta 10 MB antes de verificar la firma; cada rechazo escribía en la bitácora; las peticiones no tenían tiempo máximo. | Tope de 1 MB en los webhooks (`/webhook/…`, Zernio, Stripe y Mercado Pago; los avisos reales son de unos KB) y de 3 MB en el de Meta (lo que documenta para un lote). A lo más 10 rechazos por minuto y conexión llegan a la bitácora (si la base no responde, no se registra y la respuesta no cambia). Una petición tiene 5 minutos para llegar completa (`requestTimeout`; solo cuenta la llegada, no la respuesta). | `webhook-hardening.test.ts` |

**Queda para después:**
- Un Evolution externo (fuera de Docker) con `WEBHOOK_BASE_URL` pública sigue dependiendo del token de la URL: Evolution no firma sus avisos.
- La revisión de IN-2 confía en que el proxy agregue `X-Forwarded-For` (Caddy lo hace siempre). Una instalación fuera de Docker con otro proxy delante (nginx, etc.) debe configurarlo para que lo agregue; si no, sus peticiones parecerían internas.
- La firma de cada proveedor se sigue revisando con el cuerpo ya leído (hasta 1 MB): no se puede firmar lo que aún no llega.

## Hallazgos pendientes por etapa

Abreviaturas: ID identidad, PAY cobros, IN entradas, AI IA y Copiloto, INF servidor.

**Revisión independiente del 4 de noviembre:** encontró hallazgos nuevos (ningún crítico; 7 medios o medio-bajos,
PAY-24…PAY-29, AI-15…AI-20, ID-18…ID-21, IN-23…IN-27 e INF-16…INF-21; PAY-26 se descartó después) y ninguna regresión
de lo de abajo. Están en [`revision-seguridad-2026-11-04.md`](revision-seguridad-2026-11-04.md), y su corrección en
[el plan](superpowers/plans/2026-11-04-seguridad-revision-correcciones.md). Lo que sigue es el estado de los hallazgos de
las auditorías anteriores.

### Altos
Ninguno: INF-2 e INF-3 se corrigieron en la etapa 8.

### Medios
Ninguno: los medios se corrigieron en las etapas 4′, 5″ y 6″.

### Bajos
Ninguno: IN-8…IN-14, AI-10…AI-13 e INF-12…INF-15 se corrigieron en la 9 y en la sección «Bajos». `privacy.md` y
`terms.md` (de otro proyecto, «Viralize») se quitaron del sitio. Lo que queda es del dueño: `privacy.html` y `terms.html`
describen una plataforma de contenido musical; si deben cubrir el chatbot, las revisa el dueño o su abogado (y conviene
mencionar que la bitácora de seguridad guarda un año correos e IP, también de cuentas borradas).
