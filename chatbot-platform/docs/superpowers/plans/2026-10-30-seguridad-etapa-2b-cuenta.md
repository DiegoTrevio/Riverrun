# Seguridad, etapa 2b (Cuenta) — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la cuenta tenga un dueño que es el único que maneja el dinero y a los administradores, que nadie escriba la
contraseña de otro ni use un correo que no controla, y que al irse alguien no queden sus llaves, webhooks ni invitaciones.

**Architecture:** Un módulo `src/identity/ownership.ts` es la única fuente del dueño (las cinco copias de la consulta se
reemplazan) y da el gancho `ownerHook` que corre entre `requireAuth` y `stepUpHook`. Los usuarios nuevos solo entran por
invitación (la prueba de que el correo es suyo); el arnés de pruebas crea usuarios por ese camino. El cambio de correo,
Google por `sub`, las bajas y los límites de invitaciones y de recuperación se agregan sobre lo que dejó la 2a
(`stepUp`, `notifyUser`, `rate_limits`).

**Tech Stack:** Node 22, TypeScript, Fastify 5, PostgreSQL 16, zod 4, `node:test`, Playwright (Chromium preinstalado). Sin
dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-30-seguridad-etapa-2-identidad-design.md` (sección «PR 2b · Cuenta»).

## Global Constraints

- El dueño es `accounts.owner_user_id`, siempre un administrador activo de esa cuenta; sin uno válido, el administrador activo más antiguo (y queda guardado).
- Solo el dueño (o el superadministrador): plan, tarjeta, facturación y CFDI, exportar y borrar la cuenta (pedir y cancelar), transferir, invitar o cambiar a administrador, y editar, desactivar, borrar o restablecer el 2FA de un administrador.
- Al dueño no se le desactiva, degrada, mueve de cuenta ni borra: «Primero transfiere la cuenta a otro administrador».
- Mensaje del servidor y del panel donde no se puede actuar: `Solo el dueño de la cuenta (Nombre) puede hacer esto` (con `code: 'owner_only'` en la API).
- Transferir: destino administrador activo de la misma cuenta, con 2FA configurado y correo verificado; inmediato; el anterior queda como administrador; correo a los dos.
- Nadie escribe la contraseña ni el correo de otra persona: se invita, y cada quien cambia lo suyo en Mi perfil.
- `email_verified_at` solo lo marcan: el enlace de verificación del registro, aceptar una invitación, confirmar un cambio de correo, Google con `email_verified` (y, por decisión de este plan, restablecer la contraseña por correo: también prueba control del buzón).
- Invitaciones: 20 por día por cuenta, 50 pendientes por cuenta, el mismo correo 3 veces por día; nombre limpio (sin enlaces ni saltos de línea, 60 caracteres).
- Recuperar contraseña: respuesta inmediata e idéntica exista o no el correo; hasta 3 enlaces vivos; 3 por hora por correo, aparte de las 5 por hora por conexión.
- Enlaces con token (verificar, restablecer, invitación, cambio de correo, confirmar el borrado) siempre a `config.publicBaseUrl`.
- Sin SMTP, la bitácora guarda el correo con los enlaces de token tachados (`[oculto]`); el buzón de pruebas (`outbox`) lo guarda completo.
- Textos del panel y de los correos en español de México, de tú; los mensajes que fija este plan se copian tal cual.
- Pruebas con `node --test`, una a la vez contra la base (`--test-concurrency=1`); nunca dos corridas con la misma base al mismo tiempo. `tsc` no revisa `test/`: antes de cada suite, revisión de sintaxis con esbuild.
- Antes de cada commit: `npx tsc -p tsconfig.json --noEmit`, `npm run -s check:frontend` y las pruebas de lo tocado.

Comandos (desde `chatbot-platform/`):
- Una prueba: `REQUIRE_PGVECTOR=true TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test3 node --import tsx --test --test-concurrency=1 test/<archivo>.test.ts`
- Suite (en segundo plano, desde una copia `git worktree` y otra base): `REQUIRE_PGVECTOR=true TEST_DATABASE_URL=…/chatbot_test npm test`
- Sintaxis de pruebas y scripts: `npx esbuild test/*.ts scripts/*.mts scripts/buttons/*.mts scripts/buttons/areas/*.mts --log-level=error --outdir=<scratchpad>/esb --format=esm --platform=node`
- Navegador: `TEST_DATABASE_URL=… node --import <scratchpad>/pw/use-preinstalled-chromium.mjs --import tsx scripts/<script>.mts`

## Review Focus

1. **El dueño se va (lo borra el superadministrador o su fila desaparece):** la cuenta toma al administrador activo más antiguo como dueño, sin quedar nunca sin dueño mientras tenga un administrador (prueba en la tarea 2).
2. **El dueño anterior sigue con su sesión abierta después de transferir:** en su siguiente petición ya no puede cambiar el plan (el dueño se lee en cada petición; prueba en la tarea 4).
3. **El correo nuevo lo toma otra persona entre pedir el cambio y abrir el enlace:** al confirmar responde 409 y nada cambia (prueba en la tarea 7).
4. **Una cuenta sin dueño (la creó el superadministrador) recibe a su primer administrador por invitación:** al aceptar, ese administrador queda como dueño (prueba en la tarea 6).
5. **El superadministrador trabaja dentro de una cuenta ajena:** ve y puede usar los controles del dueño (con verificación reciente), y el panel no le muestra «Solo el dueño…» (prueba en la tarea 14).

---

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/096_identity_account.sql` (nuevo) | `google_sub`, `webhook_endpoints.created_by`, dueño relleno, `auth_tokens` con `change_email` y `email` |
| `src/identity/ownership.ts` (nuevo) | Dueño de la cuenta, gancho `ownerHook`, marcas de ruta, `assertOwner`, `ensureOwner` |
| `src/identity/offboarding.ts` (nuevo) | Lo que se revoca y pausa al dar de baja a alguien |
| `src/identity/invite-text.ts` (nuevo) | Limpieza del nombre y texto fijo del correo de invitación |
| `src/routes/account.ts` (nuevo) | Transferir la cuenta y cambiar el correo |
| `src/accounts/self-service.ts`, `src/lifecycle.ts`, `src/billing/cfdi.ts`, `src/accounts/retention.ts`, `src/onboarding-checklist.ts`, `src/routes/onboarding.ts` | Usan `accountOwner` en lugar de su propia consulta |
| `src/routes/admin.ts`, `src/routes/billing.ts`, `src/routes/self-service.ts`, `src/routes/invitations.ts`, `src/routes/signup.ts`, `src/routes/google-login.ts`, `src/routes/integrations.ts` | Poderes del dueño, invitación en vez de contraseña, Google por `sub`, bajas, límites |
| `src/store/index.ts`, `src/mailer.ts`, `src/brands.ts`, `src/signup-guard.ts`, `src/identity/notices.ts`, `src/identity/devices.ts`, `src/identity/mfa.ts`, `src/identity/recovery-codes.ts`, `src/app.ts` | Tokens, enlaces, bitácora, avisos nuevos, pendientes de la 2a |
| `public/js/session.js`, `admin.js`, `billing.js`, `auth.js`, `main.js`, `integrations.js`, `mfa.js` | Dueño en el panel, invitar en vez de crear, cambio de correo, tokens fuera de la URL |
| `test/harness.ts` | `h.addUser` y `h.addAccount` por invitación |
| `scripts/test-account-ux.mts` (nuevo) + `package.json` + CI | Recorrido en navegador de la 2b |

---

### Task 1: Migración 096

**Files:**
- Create: `migrations/096_identity_account.sql`
- Modify: `test/migration.test.ts` (lista ordenada termina en `096_identity_account.sql`, cuenta 96, prueba nueva)

**Interfaces:**
- Produces: `users.google_sub text` con índice único parcial `users_google_sub_idx ON users(google_sub) WHERE google_sub IS NOT NULL`; `webhook_endpoints.created_by uuid REFERENCES users(id) ON DELETE SET NULL` con índice `webhook_endpoints_created_by_idx`; `auth_tokens.email text`; `auth_tokens_kind_check` admite `'verify_email','reset_password','change_email'`; `accounts.owner_user_id` relleno con el administrador activo más antiguo donde esté vacío o no apunte a un administrador activo de esa cuenta.

- [ ] **Step 1: Prueba que falla** en `test/migration.test.ts`: `t('096: dueño, google_sub, created_by y change_email', …)` — las columnas existen; insertar dos `google_sub` iguales falla con `23505`; un `auth_tokens` con `kind = 'change_email'` entra; una cuenta con dos administradores y `owner_user_id` nulo antes de migrar queda con el más antiguo (crear las filas con SQL, borrar la fila de `schema_migrations` de 096 y correr `migrate()` de nuevo, como hace la prueba de la migración fallida).
- [ ] **Step 2:** Correr; FALLA (no existe 096).
- [ ] **Step 3:** Escribir la migración (idempotente: `IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` y volver a crear el `CHECK`).
- [ ] **Step 4:** PASA (también «llaves foráneas sin índice»).
- [ ] **Step 5:** Commit `Etapa 2b: migración 096 (dueño, google_sub, created_by, cambio de correo)`.

---

### Task 2: Un solo dueño

**Files:**
- Create: `src/identity/ownership.ts`, `test/account-owner.test.ts`
- Modify: `src/accounts/self-service.ts` (quita `ownerOf`/`isOwner`, usa los nuevos), `src/lifecycle.ts:28-33`, `src/billing/cfdi.ts:68-71`, `src/accounts/retention.ts:56-59`, `src/onboarding-checklist.ts:131-133`, `src/routes/onboarding.ts:200`, `src/routes/admin.ts` (`GET /api/me` agrega `owner`; `GET /api/accounts` usa `accountOwner`), `src/app.ts` (gancho)

**Interfaces:**
- Produces (en `src/identity/ownership.ts`):
  - `type AccountOwner = { id: string; name: string; email: string; email_verified_at: Date | null; totp_enabled_at: Date | null }`
  - `accountOwner(accountId: string): Promise<AccountOwner | null>` — el de `owner_user_id` si es administrador activo de la cuenta; si no, el administrador activo más antiguo, y lo guarda en `owner_user_id`; `null` sin administradores.
  - `isAccountOwner(user: Pick<User, 'id' | 'role' | 'account_id'>, accountId: string): Promise<boolean>` — `true` para el superadministrador.
  - `assertOwner(req: FastifyRequest, accountId: string): Promise<void>` — lanza `HttpError(403, 'Solo el dueño de la cuenta (Nombre) puede hacer esto', undefined, { code: 'owner_only' })`.
  - `ensureOwner(accountId: string, userId: string): Promise<void>` — pone a `userId` como dueño solo si la cuenta no tiene uno válido.
  - `ownerOnly = { config: { owner: true } }` y `ownerStepUp = { config: { owner: true, stepUp: true } }` (amplía `FastifyContextConfig` con `owner?: boolean`).
  - `ownerHook(req, reply)`: con `config.owner`, la cuenta es `targetAccount(req.user, req.query.account_id ?? req.body?.account_id)`; si no es dueño, 403 como `assertOwner`. En `app.ts`: `requireAuth` → `ownerHook` → `stepUpHook` (así quien no es dueño recibe el 403 y no la ventana del código).
  - `GET /api/me` agrega `owner: { id, name } | null`.

- [ ] **Step 1: Pruebas que fallan** (`test/account-owner.test.ts`, primera parte): `accountOwner` devuelve al de `owner_user_id`; si ese usuario es agente, está inactivo o es de otra cuenta, devuelve al administrador activo más antiguo y lo guarda; si el superadministrador borra al dueño, el siguiente administrador queda como dueño (Review Focus 1); `/api/me` trae `owner.name`; las cinco copias desaparecen (`grep` en la prueba: ninguna consulta con `role = 'admin' AND active … ORDER BY` fuera de `ownership.ts`).
- [ ] **Step 2:** FALLA. **Step 3:** Implementar y reemplazar las copias (los avisos de pago, CFDI, retención y onboarding van al mismo dueño). **Step 4:** PASA, más `test/owner-self-service.test.ts`, `test/account-retention.test.ts`, `test/billing-cfdi.test.ts`, `test/onboarding-checklist.test.ts`, `test/reliability-messages.test.ts` (su `owner_user_id` al superadmin ahora se corrige solo).
- [ ] **Step 5:** Commit `Etapa 2b: un solo dueño de la cuenta`.

---

### Task 3: Poderes del dueño

**Files:**
- Modify: `src/routes/billing.ts` (todas menos `GET /api/billing`), `src/routes/self-service.ts` (`export.zip`, `POST` y `DELETE /api/account/deletion`), `src/routes/admin.ts` (`manageable()`, `POST`/`PUT`/`DELETE /api/users`, `POST /api/users/:id/2fa/reset`), `src/routes/invitations.ts` (invitar a un administrador), `test/account-owner.test.ts` (segunda parte), `test/identity-step-up.test.ts`
- Panel: `public/js/session.js` (`isOwner()`), `public/js/billing.js` (Mi plan en solo lectura para el administrador), `public/js/admin.js` (Equipo)

**Interfaces:**
- Consumes: `ownerStepUp`, `ownerOnly`, `assertOwner`, `accountOwner` (tarea 2).
- Produces:
  - `ownerStepUp` en `PUT /api/billing/fiscal`, `POST /api/billing/checkout|portal|change|payment-method|cancel`, `GET /api/account/export.zip`, `POST /api/account/deletion`; `ownerOnly` en `GET /api/billing/fiscal`, `GET /api/billing/invoices/:id/:format`, `POST /api/billing/confirm`, `DELETE /api/account/deletion` (cancelar el borrado también es del dueño, con `stepUp`). `GET /api/billing` sigue para administradores.
  - `manageable()` además: un administrador que no es dueño recibe el 403 de `assertOwner` si el destino es administrador; nadie desactiva, degrada (`role` distinto de `admin`), mueve de cuenta ni borra al dueño: `400 { error: 'Primero transfiere la cuenta a otro administrador' }`.
  - `PUT /api/users/:id { role: 'admin' }` y `POST /api/invitations { role: 'admin' }` exigen dueño.
  - `POST /api/account/deletion` acepta al superadministrador con `?account_id` (hoy da 403).
  - Panel: `isOwner = () => isSuper() || state.me?.owner?.id === state.me?.user?.id`; en Mi plan, el administrador ve el plan sin botones y el texto `Solo el dueño de la cuenta (Nombre) puede hacer esto`; en Equipo, la fila del dueño lleva la etiqueta `Dueño` y, para un administrador que no es dueño, las filas de administradores no tienen acciones (mismo texto).

- [ ] **Step 1: Pruebas que fallan:** un administrador que no es dueño recibe `403 { code: 'owner_only' }` en cada ruta de la lista (recorrer un arreglo `OWNER_ROUTES` exportado), también con la verificación vieja (403 de dueño, no `step_up`); el dueño pasa; el superadministrador pasa con `?account_id`; un administrador no desactiva, degrada, borra ni restablece el 2FA de otro administrador ni del dueño; nadie degrada ni borra al dueño (`Primero transfiere…`), tampoco el superadministrador; el administrador sí maneja agentes; invitar a un administrador es del dueño. En `identity-step-up.test.ts`, la sesión vieja del superadministrador sigue recibiendo `step_up` en las rutas del dueño.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar servidor y panel. **Step 4:** PASA, más `test/billing*.test.ts`, `test/owner-self-service.test.ts`, `test/invitations.test.ts`, `test/profile-permissions.test.ts`, `test/identity-profile.test.ts`, `test/identity-step-up.test.ts`, `test/isolation.test.ts`, `test:billing:ux`, y la suite completa en segundo plano (muchas pruebas usan a un administrador que puede no ser el dueño: cada una se corrige para que actúe el dueño o para que espere `owner_only`, según lo que prueba).
- [ ] **Step 5:** Commit `Etapa 2b: solo el dueño maneja el dinero, la cuenta y a los administradores`.

---

### Task 4: Transferir la cuenta

**Files:**
- Create: `src/routes/account.ts`, `test/account-transfer.test.ts`
- Modify: `src/app.ts` (registrar `accountRoutes(api)` en el ámbito con sesión), `src/identity/notices.ts` (avisos nuevos), `public/js/admin.js` (Equipo: `Hacer dueño`)

**Interfaces:**
- Produces:
  - `POST /api/account/transfer { user_id }` con `ownerStepUp` (el superadministrador con `?account_id` reasigna): el destino es administrador activo de la misma cuenta con `totp_enabled_at` y `email_verified_at`; si no, `400 { error: 'Solo puedes transferirla a un administrador con su correo verificado y su verificación en dos pasos activa' }`; a sí mismo, `400 { error: 'Ya eres el dueño' }`. Actualiza `owner_user_id`, registra en la bitácora y avisa a los dos.
  - `NoticeKind` agrega `'ownership_transferred'` (al anterior: asunto `Transferiste tu cuenta`, cuerpo `Transferiste la cuenta «${account}» a ${to} el ${when}. Sigues como administrador.`) y `'ownership_received'` (al nuevo: asunto `Ahora eres dueño de la cuenta`, cuerpo `${from} te transfirió la cuenta «${account}» el ${when}. Revisa los datos de facturación en Mi plan.`). `NoticeDetails` agrega `account?`, `to?`, `from?`.
  - Panel, Equipo: en las filas de administradores elegibles, el dueño ve `Hacer dueño`; confirmación `Transferir la cuenta a Nombre` con el texto `Será el único que maneja el plan, los pagos y a los administradores. Tú quedas como administrador.` y botón `Transferir`.

- [ ] **Step 1: Pruebas que fallan:** destino válido → 200, `owner_user_id` cambia, dos correos con sus asuntos; destino agente, inactivo, sin 2FA, sin correo verificado o de otra cuenta → 400 o 404; un administrador que no es dueño → 403 `owner_only`; sin verificación reciente → `step_up`; el dueño anterior, con la misma sesión, recibe `owner_only` en `POST /api/billing/change` (Review Focus 2); el superadministrador reasigna con `?account_id`.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/security-notices.test.ts` con los dos avisos nuevos).
- [ ] **Step 5:** Commit `Etapa 2b: transferir la cuenta`.

---

### Task 5: El arnés crea usuarios por invitación

**Files:**
- Modify: `test/harness.ts`, y todas las pruebas y scripts que crean usuarios con contraseña: las 99 líneas de `'POST', '/api/users'` en 71 archivos de `test/`, las 18 de `POST /api/accounts { admin: { password } }` en 16 archivos, `scripts/ux-fixture.mts:85-93`, `scripts/test-identity-ux.mts:52-53`, `scripts/test-public-ux.mts:24`, `scripts/eval-copilot.mts:389`, `scripts/buttons/areas/publicas.mts:31`, `global.mts:7`, `equipo.mts:36`

**Interfaces:**
- Produces (en el objeto del arnés):
  - `h.addUser(o: { account_id?: string; name?: string; email: string; password: string; role: 'admin' | 'agent' }): Promise<User>` — inserta la invitación con SQL (token conocido, `invited_by` nulo) y la acepta con `POST /api/invitation/accept` (con un `remoteAddress` distinto en cada llamada, para no tocar los límites por conexión); devuelve el usuario de la respuesta. `account_id` por omisión `h.accountId`.
  - `h.addAccount(o: { name: string; admin?: { name?: string; email: string; password: string } }): Promise<{ id: string; admin?: User }>` — `POST /api/accounts { name }` como superadministrador y, con `admin`, `h.addUser({ role: 'admin', … })`.
  - `h.addSuperadmin(email: string, password: string): Promise<User>` — `addUser` en una cuenta de paso y `UPDATE users SET role = 'superadmin', account_id = NULL` (solo para pruebas que necesitan otro superadministrador).
- Las llamadas se reescriben a los ayudantes conservando lo que afirma cada prueba (el `statusCode` 200 de crear pasa a ser que el ayudante no lance; donde una prueba revisa una respuesta de error de `POST /api/users`, se queda la llamada directa y la tarea 6 cambia lo que espera).

- [ ] **Step 1:** Escribir los ayudantes y una prueba corta en `test/harness-helpers.test.ts`: `addUser` deja al usuario con `email_verified_at` y puede entrar con `h.loginAs`; `addAccount` con `admin` lo deja como dueño (con la tarea 2, por `ensureOwner` al aceptar — en esta tarea basta con que sea el único administrador).
- [ ] **Step 2:** Migrar archivo por archivo con un guion de reemplazo para las formas repetidas y a mano el resto; revisión de sintaxis con esbuild.
- [ ] **Step 3:** Suite completa en segundo plano y los scripts de navegador tocados (`test:identity:ux`, `test:public:ux`, `test:buttons`): todo PASA todavía con las rutas viejas.
- [ ] **Step 4:** Commit `Etapa 2b: el arnés crea usuarios por invitación`.

---

### Task 6: Nadie escribe la contraseña de otro

**Files:**
- Modify: `src/routes/admin.ts` (`POST /api/users` sale; `PUT /api/users/:id` sin `password` ni `email`; `POST /api/accounts { owner: { name, email } }`), `src/routes/invitations.ts` (aceptar como administrador en una cuenta sin dueño llama a `ensureOwner`; la invitación del superadministrador al dueño), `src/store/index.ts:216-217` (`createUser` sin `verified` explícito → no verificado), `src/auth.ts` (`bootstrapSuperadmin` y `resetSuperadminPassword` pasan `verified: true`), `public/js/admin.js` (sin «Crear usuario con contraseña inicial», sin «Restablecer contraseña»; en Cuentas, `Invitar a su dueño` con nombre y correo), `test/tenancy.test.ts`, `test/identity-login.test.ts:177`, `test/password-hash.test.ts:64`, `test/passwords.test.ts:78`, `test/profile-permissions.test.ts`, `scripts/buttons/areas/equipo.mts:6-21`, `scripts/buttons/sin-presionar.json`

**Interfaces:**
- Produces:
  - `POST /api/users` → `410 { error: 'Invita a la persona: ella elige su contraseña al aceptar' }`.
  - `PUT /api/users/:id` con `password` o `email` → `400 { error: 'Cada persona cambia su contraseña y su correo en Mi perfil' }`.
  - `POST /api/accounts { name, owner?: { name?: string, email: string } }` crea la cuenta y una invitación de administrador; al aceptarla, esa persona queda como dueño (Review Focus 4). Ya no acepta `admin.password` (`400` con el mismo texto de `/api/users`).
  - Crear otro superadministrador: solo «Dar acceso maestro» a alguien con correo verificado (ya existe) o `./riverrun grant-master`.
  - Con `SIGNUP_REQUIRE_EMAIL=false` el registro sigue creando al usuario verificado: quien instala apagó la verificación a propósito (lo dice `docs/produccion.md`).

- [ ] **Step 1: Pruebas que fallan:** `POST /api/users` → 410; `PUT` con `password` o `email` → 400; `POST /api/accounts` con `owner` manda la invitación y al aceptarla queda como dueño; con `admin.password` → 400; un usuario creado sin `verified` queda sin verificar; el superadministrador del arranque queda verificado.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar servidor y panel; el área `equipo` de la auditoría invita en vez de crear. **Step 4:** PASA, más las pruebas listadas, `test:buttons` (área `equipo`) y `test:billing:ux`.
- [ ] **Step 5:** Commit `Etapa 2b: nadie escribe la contraseña de otro; se invita`.

---

### Task 7: Cambiar el correo

**Files:**
- Modify: `src/routes/account.ts`, `src/store/index.ts` (`createAuthToken` acepta `'change_email'` y `email`), `src/identity/notices.ts` (`'email_changed'`), `public/js/admin.js` (Mi perfil → sección `Correo`), `public/js/main.js` y `public/js/auth.js` (pantalla pública `#/cambiar-correo/<token>`)
- Create: `test/email-change.test.ts`

**Interfaces:**
- Produces:
  - `PUT /api/me/email { email }` con `stepUp`: correo válido y distinto; si ya lo usa otra cuenta, `409 { error: 'Ese correo ya tiene una cuenta' }`; manda a la dirección nueva el enlace `${publicBaseUrl}/#/cambiar-correo/<token>` (24 h); responde `{ ok: true, pending: email }`.
  - `POST /api/email-change/confirm { token }` (pública): en una transacción vuelve a revisar que el correo esté libre (`409` si no, Review Focus 3), cambia `email`, pone `email_verified_at = now()`, invalida todos los `auth_tokens` abiertos de la persona y avisa a la dirección anterior (`'email_changed'`: asunto `Cambiaste tu correo`, cuerpo `El correo de tu cuenta cambió a ${email} el ${when}.`). `google_sub` no cambia.
  - Panel: Mi perfil → `Correo` muestra el actual y `Cambiar correo` (pide el nuevo; luego `Te mandamos un enlace a ${email}. El cambio se aplica al abrirlo.`); la pantalla `#/cambiar-correo/<token>` confirma con `Tu correo cambió. Entra con tu correo nuevo.`

- [ ] **Step 1: Pruebas que fallan:** pedir el cambio sin verificación reciente → `step_up`; con ella → correo a la nueva con el enlace al dominio principal; confirmar → el correo cambia, queda verificado, los enlaces de restablecer previos ya no sirven y llega el aviso a la anterior; un token usado o vencido → 400; otra persona toma el correo antes de confirmar → 409 y nada cambia; un correo ocupado al pedir → 409.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `identity-step-up` con `PUT /api/me/email` en `STEP_UP`).
- [ ] **Step 5:** Commit `Etapa 2b: cambiar el correo con un enlace al correo nuevo`.

---

### Task 8: Google por `sub` y el pase del registro ligado al navegador

**Files:**
- Modify: `src/routes/google-login.ts`, `src/signup-guard.ts:90-109` (`googleSignupPass` con un número de un solo navegador), `src/routes/invitations.ts` (aceptar con Google guarda `google_sub`), `public/js/auth.js` (registro con Google sin token en la URL de la API), `public/js/main.js`, `test/google-login.test.ts` (sus casos de cuenta sin verificar cambian), `test/invitations.test.ts`

**Interfaces:**
- Produces:
  - Callback: primero `SELECT … WHERE google_sub = $sub`; si no hay, por correo solo si nuestro `email_verified_at` no es nulo y Google trae `email_verified === true`, y entonces guarda `google_sub`; con correo sin verificar redirige a `/#/login?google=sin-verificar` y el panel dice `Ese correo no está verificado en tu cuenta: entra con tu contraseña y verifícalo para usar Google.` Ya no cambia la contraseña ni marca verificado.
  - Registro e invitación con Google guardan `google_sub`.
  - `googleSignupPass(email, name, nonce)` firma también un número; el callback pone la cookie `cp_gpass` (HttpOnly, `SameSite=Strict`, 15 min) con ese número; `readGoogleSignupPass(pass, req)` exige que coincida. El panel abre `#/registro-google/<pase>` e `#/invitacion/google/<pase>`; `GET /api/signup/google` sale y entra `POST /api/signup/google/peek { token }`.

- [ ] **Step 1: Pruebas que fallan:** entra por `sub` aunque cambie el correo aquí; liga por correo verificado y guarda `sub`; con correo sin verificar no entra, no cambia la contraseña y no marca verificado; el pase sin su cookie (otro navegador) → 401; `GET /api/signup/google` ya no existe.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test:billing:ux`, que entra con Google).
- [ ] **Step 5:** Commit `Etapa 2b: Google por sub y el pase del registro ligado al navegador`.

---

### Task 9: Bajas

**Files:**
- Create: `src/identity/offboarding.ts`, `test/offboarding.test.ts`
- Modify: `src/routes/admin.ts` (desactivar y borrar llaman a `offboardUser`; `GET /api/users/:id/offboarding`), `src/routes/integrations.ts:60` (guarda `created_by` al crear un webhook), `public/js/admin.js` (la confirmación dice qué se va), `public/js/integrations.js:161` (la etiqueta muestra `Pausado` y el motivo, no siempre «Pausado por fallos»)

**Interfaces:**
- Produces:
  - `offboardingSummary(userId: string): Promise<{ api_keys: number; webhooks: number; invitations: number }>` (activos que creó).
  - `offboardUser(userId: string, name: string): Promise<{ api_keys: number; webhooks: number; invitations: number }>` — revoca sus invitaciones pendientes (`invited_by`), revoca sus llaves activas (`created_by`) y pausa sus webhooks activos con `disabled_reason = 'Lo creó ${name}, que ya no está en el equipo'`; se llama antes de borrar (las llaves foráneas pasan a nulo).
  - `GET /api/users/:id/offboarding` (administradores, `manageable`) → el resumen. Panel: `Desactivar` y `Eliminar` confirman con `Se revocan ${n} llaves de API y ${m} invitaciones, y se pausan ${k} webhooks que creó.` cuando hay algo.

- [ ] **Step 1: Pruebas que fallan:** una persona con una llave, un webhook y una invitación pendiente; desactivarla → la llave ya no autentica `/api/v1`, el webhook queda pausado con el motivo, la invitación ya no se acepta; lo mismo al borrarla; lo de otras personas no cambia; el resumen cuenta bien; reactivar a la persona no revive nada.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/integrations.test.ts`, `test/webhook-events.test.ts`).
- [ ] **Step 5:** Commit `Etapa 2b: al dar de baja se van sus llaves, webhooks e invitaciones`.

---

### Task 10: Invitaciones con límites y tokens fuera de la URL

**Files:**
- Create: `src/identity/invite-text.ts`, `test/invitation-limits.test.ts`
- Modify: `src/routes/invitations.ts`, `public/js/auth.js` (`renderInvite` lee `#/invitacion/<token>`), `public/js/main.js`, `test/invitations.test.ts`, `scripts/test-billing-ux.mts`, `scripts/test-buttons.mts:98`

**Interfaces:**
- Produces:
  - `cleanInviteName(raw: string): string` — quita caracteres de control y saltos de línea (por espacio), enlaces (`https?://\S+`, `www\.\S+`) y dominios (`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b`, sin distinguir mayúsculas), junta espacios y corta a 60.
  - `inviteMail(o: { inviter: string; invitee: string; account: string; role: string; link: string; google: boolean }): { subject: string; text: string }` — texto fijo; los tres nombres pasan por `cleanInviteName` y van entre comillas «».
  - Crear o reenviar: quien invita debe tener el correo verificado (`403 { error: 'Verifica tu correo antes de invitar a alguien' }`) y el dueño también (`403 { error: 'El dueño de la cuenta tiene que verificar su correo antes de invitar a alguien' }`); el superadministrador queda exento. Topes con `countHit` en `rate_limits`: `invite-acct:<cuenta>` 20 por día (`429 { error: 'Llegaste al límite de 20 invitaciones por día' }`), `invite-email:<correo>` 3 por día (`429 { error: 'Ya invitaste a ese correo 3 veces hoy' }`); 50 pendientes por cuenta (`409 { error: 'Hay 50 invitaciones pendientes: cancela alguna antes de invitar a más' }`). Sale el `rateLimited('invite:'…)` en memoria.
  - `POST /api/invitation/peek { token } | { google }` reemplaza a `GET /api/invitation`; el enlace del correo es `${publicBaseUrl}/#/invitacion/<token>`.
  - Crear y reenviar responden también `mail_sent: boolean` (de `deliverMail`); con `false`, el panel dice `La invitación quedó guardada, pero no se pudo mandar el correo: revisa la configuración de correo (SMTP).` (riesgo «Sin SMTP» de la spec).

- [ ] **Step 1: Pruebas que fallan:** sin SMTP, crear responde `mail_sent: false`; `cleanInviteName` con `'Ana\nVisita https://malo.mx'`, `'www.malo.mx Pedro'`, `'Paga en banco-falso.com'` y 200 caracteres; el correo trae el texto fijo con el nombre entre «»; invitar sin correo verificado (quien invita o el dueño) → 403; el tope 21 → 429; el mismo correo 4 veces → 429; 51 pendientes → 409; `GET /api/invitation` ya no existe y `peek` responde lo mismo que antes.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test:billing:ux`, que acepta invitaciones en el navegador).
- [ ] **Step 5:** Commit `Etapa 2b: invitaciones con límites, texto fijo y tokens fuera de la URL`.

---

### Task 11: Recuperar contraseña (ID-7, ID-8)

**Files:**
- Modify: `src/routes/signup.ts:147-184`, `src/store/index.ts:272-300` (`createAuthToken` deja hasta 3 vivos; `invalidateAuthTokens(userId)`), `src/routes/admin.ts` (`PUT /api/me/password` invalida), `test/password-recovery.test.ts` (nuevo)

**Interfaces:**
- Produces:
  - `POST /api/forgot-password`: cuenta `forgot-ip:<ipKey>` (5 por hora) y `forgot-email:<correo>` (3 por hora, exista o no) en `rate_limits`; responde `{ ok: true }` al momento y hace el resto (buscar, crear el enlace, mandar) en segundo plano, con un error que solo queda en la bitácora.
  - `createAuthToken` invalida solo los de ese tipo más allá de los 3 más nuevos (`kind = 'reset_password'`; `verify_email` y `change_email` siguen con uno vivo).
  - `invalidateAuthTokens(userId: string): Promise<void>` — `used_at = now()` en todos los abiertos; lo llaman restablecer, cambiar la contraseña y confirmar un cambio de correo.
  - Restablecer por correo además quita el bloqueo del 2FA (`mfa_locked_until = NULL`, `clearHits('mfa-user:<id>')`).

- [ ] **Step 1: Pruebas que fallan:** las dos respuestas (correo que existe y que no) son idénticas y llegan antes de que el correo esté en el buzón (`outbox` vacío al responder, `waitFor` después); el cuarto pedido del mismo correo en una hora no manda nada; tres enlaces pedidos seguidos sirven los tres (cualquiera); después de usar uno, los otros dos ya no; cambiar la contraseña en Mi perfil invalida los enlaces vivos; restablecer quita el bloqueo del 2FA.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/billing-signup.test.ts` y `test/identity-limits.test.ts`).
- [ ] **Step 5:** Commit `Etapa 2b: recuperar la contraseña sin delatar correos ni bloquear a la persona`.

---

### Task 12: Enlaces al dominio principal y bitácora sin tokens (ID-9, ID-10)

**Files:**
- Modify: `src/mailer.ts:56-61`, `src/brands.ts` (`linkBase()`), `src/routes/signup.ts` (verificar y restablecer), `src/routes/invitations.ts`, `src/accounts/self-service.ts:62` (confirmar el borrado), `src/routes/account.ts` (cambio de correo), `test/brand.test.ts:70`, `test/mailer.test.ts` (o el archivo de pruebas del correo que ya exista)

**Interfaces:**
- Produces:
  - `linkBase(): string` = `config.publicBaseUrl`, para todo enlace con token; los demás enlaces de marca siguen con `mailBrand(accountId).base`.
  - `redactTokens(text: string): string` (en `src/mailer.ts`) — reemplaza el valor de `token=`, `t=` y lo que sigue a `/#/invitacion/`, `/#/cambiar-correo/`, `/#/registro-google/` por `[oculto]`; la bitácora sin SMTP guarda `details.text = redactTokens(text)`; `outbox` guarda el texto completo.

- [ ] **Step 1: Pruebas que fallan:** con una marca con dominio propio, los enlaces de verificar, restablecer, invitación, cambio de correo y borrado usan `publicBaseUrl` (`brand.test.ts` cambia lo que afirma); sin SMTP, `event_logs.details.text` trae `[oculto]` y no el token, y `outbox` sí lo trae.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA.
- [ ] **Step 5:** Commit `Etapa 2b: enlaces con token al dominio principal y sin tokens en la bitácora`.

---

### Task 13: Pendientes de la 2a

**Files:**
- Modify: `src/identity/devices.ts` (`trustedDeviceFor` exige también la cookie `cp_device` de ese dispositivo), `src/identity/mfa.ts` (el bloqueo y su correo solo con `hits === max`), `src/identity/recovery-codes.ts` (`replaceRecoveryCodes` en una transacción), `src/routes/admin.ts` (`POST /api/me/sessions/revoke-others` con `stepUp`), `src/routes/mfa.ts` (`DELETE /api/me/devices/:id` con `stepUp`), `test/identity-devices.test.ts`, `test/identity-limits.test.ts`, `test/identity-profile.test.ts`, `test/identity-step-up.test.ts`

**Interfaces:**
- Produces: un `cp_trust` copiado a un navegador sin su `cp_device` pide el código; con 12 códigos malos a la vez llega un solo correo de bloqueo; dos «Generar códigos nuevos» simultáneos dejan 10 códigos; `revoke-others` y olvidar un dispositivo entran a `STEP_UP`.

- [ ] **Step 1: Pruebas que fallan** (una por punto). **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test:identity:ux`, que olvida un dispositivo con verificación reciente).
- [ ] **Step 5:** Commit `Etapa 2b: pendientes de la revisión de la 2a`.

---

### Task 14: Recorrido en navegador de la cuenta

**Files:**
- Create: `scripts/test-account-ux.mts`
- Modify: `package.json` (`test:account:ux`), `.github/workflows/*.yml` (el paso junto a `test:identity:ux`)

- [ ] **Step 1:** El script (base propia como `test-identity-ux.mts`, axe en computadora y teléfono): un administrador que no es dueño abre Mi plan y ve el plan sin botones y `Solo el dueño de la cuenta (Nombre) puede hacer esto`; en Equipo no tiene acciones sobre el dueño; el dueño invita a un administrador (correo del `outbox`), la persona acepta en `#/invitacion/<token>`, configura su 2FA y el dueño le transfiere la cuenta con `Hacer dueño`; el nuevo dueño ve los botones de Mi plan; cambio de correo en Mi perfil y confirmación en `#/cambiar-correo/<token>`; la confirmación de `Desactivar` dice cuántas llaves y webhooks se van; el superadministrador, dentro de la cuenta, ve los controles del dueño (Review Focus 5).
- [ ] **Step 2:** Correrlo: PASA. **Step 3:** Commit `Etapa 2b: recorrido en navegador de la cuenta`.

---

### Task 15: Auditoría de botones y documentación

**Files:**
- Modify: `scripts/buttons/sin-presionar.json`, `scripts/buttons/areas/equipo.mts` (desactivar con resumen; transferir solo lo presiona `test:account:ux`), `docs/seguridad.md` (fila de la etapa 2: «2a ✅, 2b ✅»; sección «Etapa 2b: lo que se corrigió» con hallazgo / arreglo / prueba y «Cambios que nota la gente»; quitar ID-2, ID-4…ID-10 de pendientes y los menores de la 2a que se hicieron), `docs/produccion.md` (Recuperar el acceso: el dueño, transferir; cambio de correo), `README.md` (roles: dueño y administrador; invitar en vez de crear), la spec (lo que cambió al implementar)

- [ ] **Step 1:** `npm run test:buttons`; cada control nuevo, presionado en un área o anotado con su motivo (`Otra prueba: test:account:ux lo presiona`). **Step 2:** PASA. **Step 3:** Documentación. **Step 4:** Commit `Etapa 2b: auditoría de botones y documentación`.

---

### Task 16: Verificación final y PR

- [ ] **Step 1:** Suite completa (copia `git worktree`, en segundo plano): 0 fallas. Navegador: `test:ux`, `test:semantic:ux`, `test:agent:ux`, `test:contact:ux`, `test:quotes:ux`, `test:billing:ux`, `test:public:ux`, `test:identity:ux`, `test:account:ux`, `test:buttons`: PASAN. `bash scripts/test-cli.sh`, shellcheck, `npx tsc --noEmit` y `npm run -s check:frontend`: limpios.
- [ ] **Step 2:** Revisión independiente de toda la rama (un revisor nuevo, del modelo más capaz, con la spec y este plan); corregir lo importante, cada cosa con su prueba.
- [ ] **Step 3:** Mezclar `claude/seguridad-etapa-2` si cambió; push; PR «Seguridad, etapa 2b: cuenta» contra `claude/seguridad-etapa-2` mientras #91 siga abierto.
