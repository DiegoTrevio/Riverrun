# Seguridad, etapa 2a (Acceso) — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que nadie entre al panel solo con la contraseña: 2FA obligatorio con códigos de recuperación, dispositivo
recordado, verificación reciente para lo delicado, contraseñas fuertes, límites en la base y sesiones que caducan.

**Architecture:** Un módulo nuevo `src/identity/` concentra lo de identidad (TOTP, códigos, reto, dispositivos, límites,
contraseñas, avisos, verificación reciente). Las cinco puertas que hoy abren sesión llaman a `beginLogin`, que abre la
sesión solo con un dispositivo recordado o deja una cookie de reto; las rutas del reto (`src/routes/mfa.ts`) terminan
el inicio. El panel agrega `public/js/mfa.js` con las pantallas de código, configuración, verificación reciente y la
sección de seguridad de Mi perfil.

**Tech Stack:** Node 22, TypeScript, Fastify 5, PostgreSQL 16, zod 4, `node:test`, Playwright (Chromium preinstalado),
`qrcode-generator` (nueva, versión exacta).

**Spec:** `docs/superpowers/specs/2026-10-30-seguridad-etapa-2-identidad-design.md` (sección «PR 2a · Acceso»).

## Global Constraints

- TOTP: SHA-1, 6 dígitos, pasos de 30 s, se acepta el paso anterior y el siguiente; un paso ya usado nunca vuelve a servir.
- Secreto TOTP: 20 bytes aleatorios, cifrado con `encryptSecret` (AES-256-GCM, llave derivada de `SESSION_SECRET`); nunca se devuelve después de configurarlo.
- Códigos de recuperación: 10, de 12 caracteres en base32 de Crockford, mostrados `xxxx-xxxx-xxxx`, guardados como SHA-256; cada uno sirve una vez.
- Cookie de reto: firmada, HttpOnly, 15 minutos; 5 códigos fallidos por reto.
- Dispositivo recordado: 30 días; nunca para el superadministrador; solo salta el código, nunca la contraseña; no da verificación reciente.
- Verificación reciente: 15 minutos.
- Contraseñas: entre 12 y 128 caracteres; HIBP solo con los primeros 5 caracteres del SHA-1, `Add-Padding: true`, 1,5 s como máximo; lista local de 100 000.
- scrypt: N=2^15, r=8, p=3; formato `scrypt$ln=15,r=8,p=3$sal$hash`; a lo más 4 cálculos a la vez y 64 en espera, después `503`.
- Límites: contraseña por conexión (IPv6 por /64) 8 en 15 min; por cuenta 10 en 1 h; código por persona 10 en 1 h → 2FA bloqueado 1 h.
- Sesiones: equipo 12 h sin uso y 7 días máximo; superadministrador 30 min y 12 h; `last_seen_at` se escribe como mucho una vez por minuto.
- Con `SECURE_COOKIES=true` las cookies llevan el prefijo `__Host-`.
- Textos del panel y de los correos en español de México, de tú; los mensajes que fija este plan se copian tal cual.
- Pruebas con `node --test`, una a la vez contra la base (`--test-concurrency=1`); nunca dos corridas con base al mismo tiempo.
- Única dependencia nueva: `qrcode-generator` con versión exacta en `package.json`.
- Antes de cada commit: `npx tsc -p tsconfig.json --noEmit`, `npm run -s check:frontend` y las pruebas de lo tocado.

Comandos (desde `chatbot-platform/`, con `pg_ctlcluster 16 main start` antes):
- Una prueba: `REQUIRE_PGVECTOR=true TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test node --import tsx --test --test-concurrency=1 test/<archivo>.test.ts`
- Suite: `REQUIRE_PGVECTOR=true TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test npm test` (unos 20 min; en segundo plano)
- Navegador: `TEST_DATABASE_URL=… node --import <scratchpad>/pw/use-preinstalled-chromium.mjs --import tsx scripts/<script>.mts`

## Review Focus

1. **Reloj del teléfono adelantado o atrasado unos segundos:** el código del paso anterior y del siguiente entra; el de dos pasos atrás no (prueba en la tarea 2).
2. **Código escrito con espacios o guiones, o el de recuperación en mayúsculas o con `O` en vez de `0`:** se normaliza y entra (pruebas en las tareas 2 y 8).
3. **Dos pestañas o recargar durante la configuración:** las dos muestran el mismo QR (el secreto pendiente se reutiliza) y el código sirve en cualquiera (prueba en la tarea 8).
4. **El reto vence a media configuración (más de 15 min instalando la app):** responde `challenge_expired`, el panel lleva a escribir la contraseña con «Vuelve a escribir tu contraseña para continuar» y el QR que ya escaneó sigue sirviendo (pruebas en las tareas 8 y 9).
5. **Entre la contraseña y el código desactivan a la persona o cambia su contraseña:** el reto ya no abre sesión (prueba en la tarea 8).

---

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/095_identity_access.sql` (nuevo) | Columnas y tablas de la etapa |
| `src/identity/totp.ts` (nuevo) | Base32, códigos TOTP, URI `otpauth://` |
| `src/identity/qr.ts` (nuevo) | QR como `data:image/svg+xml` |
| `src/identity/rate-limit.ts` (nuevo) | Contadores atómicos en `rate_limits` |
| `src/identity/notices.ts` (nuevo) | Avisos de seguridad por correo |
| `src/identity/passwords.ts` (nuevo) | Política, lista local, HIBP |
| `assets/common-passwords.txt.gz` (nuevo) | Las 100 000 más comunes (SecLists, MIT) |
| `src/identity/recovery-codes.ts` (nuevo) | Generar, guardar y usar códigos de recuperación |
| `src/identity/mfa.ts` (nuevo) | Reto, `beginLogin`, abrir sesión, verificar códigos, configurar |
| `src/identity/devices.ts` (nuevo) | Dispositivo conocido y recordado |
| `src/identity/step-up.ts` (nuevo) | Gancho de verificación reciente |
| `src/identity/origin-guard.ts` (nuevo) | Rechazo de peticiones de otros sitios |
| `src/routes/mfa.ts` (nuevo) | Rutas del reto, verificación reciente, seguridad de Mi perfil, restablecer 2FA ajeno |
| `src/cli/rekey-mfa.ts` (nuevo) | Re-cifrar secretos TOTP con el `SESSION_SECRET` nuevo |
| `src/auth.ts` | Hash, sesiones por rol, cookies, superadmin |
| `src/secret.ts` | `encryptSecret`/`decryptSecret` con llave opcional |
| `src/store/index.ts` | `touchUserSession` con inactividad y `mfa_at` |
| `src/routes/{admin,signup,invitations,google-login,automation,integrations,billing,self-service}.ts` | Puertas, contraseñas, rutas marcadas |
| `src/app.ts` | Registrar rutas y ganchos |
| `public/js/mfa.js` (nuevo), `public/js/{auth,core,main,admin,integrations,automation,billing}.js` | Panel |
| `test/harness.ts` | El arnés hace el 2FA solo |
| `riverrun`, `scripts/test-cli.sh` | `admin-password` y `rotate-secret` |
| `scripts/test-identity-ux.mts` (nuevo), `scripts/buttons/**`, `scripts/ux-fixture.mts`, `scripts/test-buttons.mts` | Navegador y auditoría de botones |
| `Dockerfile`, `.env.example`, `src/config.ts`, `src/config-check.ts`, `docs/**` | Configuración y documentación |

---

### Task 1: Migración 095

**Files:**
- Create: `migrations/095_identity_access.sql`
- Modify: `test/migration.test.ts` (lista de migraciones y conteo)

**Interfaces:**
- Produces (columnas que usan las tareas siguientes):
  - `users`: `totp_secret text`, `totp_pending text`, `totp_enabled_at timestamptz`, `totp_last_step bigint NOT NULL DEFAULT 0`, `mfa_locked_until timestamptz`.
  - `user_recovery_codes (id bigserial PK, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, code_hash text NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`, único `(user_id, code_hash)`.
  - `user_devices (id uuid PK DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, device_hash text NOT NULL, trust_hash text UNIQUE, trusted_until timestamptz, user_agent text NOT NULL DEFAULT '' CHECK (length(user_agent) <= 300), ip text NOT NULL DEFAULT '' CHECK (length(ip) <= 64), first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now())`, único `(user_id, device_hash)`.
  - `user_sessions.mfa_at timestamptz`.
  - `rate_limits (key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL)`, índice `(expires_at)`.
  - Al final: `UPDATE user_sessions SET revoked_at = now() WHERE revoked_at IS NULL;`

- [ ] **Step 1:** En `test/migration.test.ts` agregar `095_identity_access.sql` a la lista, subir el conteo a 95 y agregar:

```ts
t('095: columnas y tablas de identidad', async () => {
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE ANY (ARRAY['totp%', 'mfa%'])`)).rows.map((r) => r.column_name).sort();
  assert.deepEqual(cols, ['mfa_locked_until', 'totp_enabled_at', 'totp_last_step', 'totp_pending', 'totp_secret']);
  for (const table of ['user_recovery_codes', 'user_devices', 'rate_limits']) assert.ok((await pool.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t, table);
  assert.ok((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'user_sessions' AND column_name = 'mfa_at'`)).rows.length);
});
```

- [ ] **Step 2:** Correr `test/migration.test.ts`: FALLA (no existe la 095).
- [ ] **Step 3:** Escribir `migrations/095_identity_access.sql` con lo de Interfaces y un comentario de cabecera en español como las demás.
- [ ] **Step 4:** Correr `test/migration.test.ts`: PASA.
- [ ] **Step 5:** Commit `Etapa 2a: migración 095 (2FA, dispositivos, límites en la base)`.

---

### Task 2: Cifrado con llave dada, TOTP y QR

**Files:**
- Modify: `src/secret.ts`, `package.json`, `package-lock.json`
- Create: `src/identity/totp.ts`, `src/identity/qr.ts`, `test/totp.unit.test.ts`

**Interfaces:**
- Produces:
  - `encryptSecret(plain: string, secret = appSecret()): string`, `decryptSecret(packed: string, secret = appSecret()): string | null` (mismo formato `v1.`; el parámetro solo lo usa `rekey-mfa`).
  - `base32Encode(buf: Buffer): string` (RFC 4648, mayúsculas, sin `=`), `base32Decode(s: string): Buffer` (ignora espacios y mayúsculas/minúsculas).
  - `newTotpSecret(): string` — 20 bytes aleatorios en base32.
  - `TOTP_PERIOD = 30`, `currentStep(now = Date.now()): number`, `totpAt(secret: string, step: number): string`.
  - `matchTotp(secret: string, code: string, now = Date.now()): number | null` — quita lo que no es dígito, exige 6 dígitos, prueba `[s, s-1, s+1]` con comparación de tiempo constante y devuelve el paso que coincidió.
  - `otpauthUri(o: { issuer: string; account: string; secret: string }): string` → `otpauth://totp/<issuer>:<account>?secret=<secret>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30` (issuer y account con `encodeURIComponent`).
  - `qrDataUri(text: string): string` — `qrcode-generator` (tipo automático, corrección `M`), `createSvgTag`, como `data:image/svg+xml;base64,…`.

- [ ] **Step 1: Pruebas que fallan** (`test/totp.unit.test.ts`):

```ts
const rfc = base32Encode(Buffer.from('12345678901234567890'));
test('vectores del RFC 6238 (SHA-1, últimos 6 dígitos)', () => {
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']] as const)
    assert.equal(totpAt(rfc, Math.floor(t / 30)), code);
});
test('reloj desfasado: un paso antes o después entra; dos pasos no', () => {
  const now = 1234567890_000, s = currentStep(now);
  assert.equal(matchTotp(rfc, totpAt(rfc, s - 1), now), s - 1);
  assert.equal(matchTotp(rfc, totpAt(rfc, s + 1), now), s + 1);
  assert.equal(matchTotp(rfc, totpAt(rfc, s - 2), now), null);
});
test('el código se acepta con espacios o guiones', () => {
  const now = 1234567890_000, c = totpAt(rfc, currentStep(now));
  assert.notEqual(matchTotp(rfc, `${c.slice(0, 3)} ${c.slice(3)}`, now), null);
  assert.notEqual(matchTotp(rfc, `${c.slice(0, 3)}-${c.slice(3)}`, now), null);
  assert.equal(matchTotp(rfc, '12345', now), null);
});
test('base32 ida y vuelta; secreto de 20 bytes', () => {
  const s = newTotpSecret();
  assert.equal(base32Decode(s).length, 20);
  assert.equal(base32Encode(base32Decode(s.toLowerCase())), s);
});
test('otpauth y QR', () => {
  const uri = otpauthUri({ issuer: 'Mi Agencia', account: 'ana@negocio.mx', secret: 'ABC' });
  assert.equal(uri, 'otpauth://totp/Mi%20Agencia:ana%40negocio.mx?secret=ABC&issuer=Mi%20Agencia&algorithm=SHA1&digits=6&period=30');
  const qr = qrDataUri(uri);
  assert.match(qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(qr.split(',')[1], 'base64').toString(), /^<svg/);
});
test('cifrar con una llave dada', () => {
  const packed = encryptSecret('hola', 'llave-a');
  assert.equal(decryptSecret(packed, 'llave-a'), 'hola');
  assert.equal(decryptSecret(packed, 'llave-b'), null);
});
```

- [ ] **Step 2:** Correr `node --import tsx --test test/totp.unit.test.ts`: FALLA (no existen los módulos).
- [ ] **Step 3:** `npm install --save-exact qrcode-generator@1.4.4`; implementar `src/identity/totp.ts`, `src/identity/qr.ts` y el parámetro de `src/secret.ts`.
- [ ] **Step 4:** Correr la prueba: PASA. `npx tsc --noEmit`: limpio.
- [ ] **Step 5:** Commit `Etapa 2a: TOTP (RFC 6238), QR y cifrado con llave dada`.

---

### Task 3: Límites en la base

**Files:**
- Create: `src/identity/rate-limit.ts`, `test/rate-limit.test.ts`
- Modify: `src/lifecycle.ts` (limpieza en la tarea periódica, junto a `pruneUserSessions`)

**Interfaces:**
- Produces:
  - `countHit(key: string, windowMs: number): Promise<number>` — un solo `INSERT … ON CONFLICT (key) DO UPDATE` que vuelve a 1 si `expires_at <= now()` (con `expires_at = now() + window`) o suma 1; devuelve `hits`.
  - `hitsFor(key: string): Promise<number>` — `hits` si no venció; si no, 0.
  - `clearHits(...keys: string[]): Promise<void>`; `pruneHits(): Promise<void>` (borra los vencidos).
  - `export const LIMITS = { loginIp: { max: 8, windowMs: 15 * 60_000 }, loginAccount: { max: 10, windowMs: 3_600_000 }, codePerChallenge: 5, codePerUser: { max: 10, windowMs: 3_600_000 }, mfaLockMs: 3_600_000 } as const;`
  - Claves: `login-ip:${ipKey(ip)}`, `login-acct:${email.toLowerCase()}`, `mfa-challenge:${cid}`, `mfa-user:${userId}`.

- [ ] **Step 1: Pruebas que fallan** (`test/rate-limit.test.ts`, con base):

```ts
t('40 golpes simultáneos cuentan 40 (sin carrera)', async () => {
  await Promise.all(Array.from({ length: 40 }, () => countHit('k:carrera', 60_000)));
  assert.equal(await hitsFor('k:carrera'), 40);
});
t('la ventana vence y vuelve a empezar en 1', async () => {
  await countHit('k:vence', 60_000);
  await pool.query(`UPDATE rate_limits SET expires_at = now() - interval '1 second' WHERE key = 'k:vence'`);
  assert.equal(await hitsFor('k:vence'), 0);
  assert.equal(await countHit('k:vence', 60_000), 1);
});
t('limpiar y podar', async () => {
  await countHit('k:a', 60_000); await clearHits('k:a');
  assert.equal(await hitsFor('k:a'), 0);
  await pool.query(`INSERT INTO rate_limits VALUES ('k:viejo', 3, now() - interval '1 hour')`);
  await pruneHits();
  assert.equal((await pool.query(`SELECT 1 FROM rate_limits WHERE key = 'k:viejo'`)).rows.length, 0);
});
```

- [ ] **Step 2:** FALLA. **Step 3:** Implementar y agregar `pruneHits()` a la tarea periódica de `lifecycle.ts` con su `.catch` y el mensaje `Limpieza de límites: …`. **Step 4:** PASA.
- [ ] **Step 5:** Commit `Etapa 2a: límites de intentos atómicos en la base`.

---

### Task 4: Avisos de seguridad por correo

**Files:**
- Create: `src/identity/notices.ts`, `test/security-notices.test.ts`

**Interfaces:**
- Produces: `type NoticeKind = 'password_changed' | 'password_reset' | 'mfa_enabled' | 'mfa_changed' | 'mfa_reset' | 'recovery_used' | 'recovery_regenerated' | 'mfa_locked' | 'new_device'` y
  `notifyUser(user: { id: string; email: string; name: string; account_id: string | null }, kind: NoticeKind, details?: { device?: string; ip?: string; remaining?: number; by?: string }): Promise<void>` — no lanza; usa `deliverMail` con `fromName` de `mailBrand(user.account_id)`; un fallo queda en `logEvent` nivel `warn`. Quien la llama no la espera (`void notifyUser(…)`).
- Asuntos exactos: `Tu contraseña cambió`, `Restableciste tu contraseña`, `Activaste la verificación en dos pasos`, `Cambiaste tu app de verificación`, `Se restableció tu verificación en dos pasos`, `Usaste un código de recuperación`, `Generaste códigos de recuperación nuevos`, `Bloqueamos tu verificación por intentos fallidos`, `Nuevo inicio de sesión en tu cuenta`.
- Cada texto: saludo con el nombre, qué pasó con fecha y hora de México (`America/Mexico_City`), los `details` que apliquen (dispositivo, IP parcial, códigos que quedan, quién lo hizo) y siempre al final `Si no fuiste tú: cambia tu contraseña y cierra todas las sesiones desde Mi perfil.` Ningún enlace con token.

- [ ] **Step 1:** Prueba que falla: para cada `kind`, `notifyUser` deja en `outbox` un correo a ese usuario con el asunto exacto y la línea final, sin `token` ni `#/restablecer`; con `remaining: 3`, el de `recovery_used` dice `Te quedan 3 códigos`.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA.
- [ ] **Step 5:** Commit `Etapa 2a: avisos de seguridad por correo`.

---

### Task 5: Contraseñas: política, lista local y HIBP

**Files:**
- Create: `src/identity/passwords.ts`, `assets/common-passwords.txt.gz`, `assets/README.md`, `test/passwords.test.ts`
- Modify: `Dockerfile` (`COPY assets ./assets` en la imagen final), `src/config.ts` (`pwnedPasswordsUrl: env('PWNED_PASSWORDS_URL', 'https://api.pwnedpasswords.com/range/')`; el valor `off` lo apaga), `.env.example`, `src/auth.ts` (se va `passwordProblem`), `src/routes/admin.ts`, `src/routes/signup.ts`, `src/routes/invitations.ts`, `src/cli/admin-password.ts`, `src/config-check.ts`, `test/harness.ts` (`process.env.PWNED_PASSWORDS_URL = 'off'`)

**Interfaces:**
- Produces:
  - `PASSWORD_MIN = 12`, `PASSWORD_MAX = 128`; `NewPassword = z.string().min(12, 'mínimo 12 caracteres').max(128, 'máximo 128 caracteres')`.
  - `isCommonPassword(pw: string): boolean` — carga perezosa del `.gz` (`path.resolve(import.meta.dirname, '../../assets/common-passwords.txt.gz')`, sirve en `src/` y en `dist/`) a un `Set`, comparando en minúsculas.
  - `pwnedCount(pw: string, url = config.pwnedPasswordsUrl): Promise<number | null>` — `null` si está en `off`, si no responde en 1,5 s o si falla (y entonces `logEvent` `warn` `HIBP no respondió: decide la lista local`).
  - `passwordIssue(pw: string, ctx: { email?: string; businessName?: string }): Promise<string | null>` con estos mensajes, en este orden:
    1. menos de 12: `La contraseña debe tener al menos 12 caracteres`; más de 128: `La contraseña puede tener hasta 128 caracteres`
    2. contiene (sin distinguir mayúsculas) la parte local del correo o el nombre del negocio, si tienen 4 caracteres o más: `La contraseña no puede incluir tu correo ni el nombre de tu negocio`
    3. está en la lista local: `Esta contraseña es de las más usadas: elige otra (una frase de 3 o 4 palabras funciona bien)`
    4. HIBP > 0: `Esta contraseña apareció en filtraciones de datos: elige otra`
  - `assertPasswordAllowed(pw, ctx): Promise<void>` — lanza `HttpError(400, mensaje)`.
- Dónde se aplica: `POST /api/signup` (correo y empresa), `POST /api/reset-password` y `PUT /api/me/password` (correo y nombre de la cuenta), `POST /api/invitation/accept` (correo de la invitación), `POST /api/users` y `PUT /api/users/:id` con contraseña, `resetSuperadminPassword` con contraseña dada. Un `ADMIN_PASSWORD` de menos de 12 caracteres da el aviso `admin_password.short` en config-check (no bloquea).
- La lista: `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` de SecLists (MIT), en minúsculas, sin repetidos, `gzip -9`. `assets/README.md` anota fuente, licencia y comando.

- [ ] **Step 1: Pruebas que fallan** (`test/passwords.test.ts`; HIBP con un servidor `http` local en el puerto 0):

```ts
test('largo, correo y negocio', async () => {
  assert.equal(await passwordIssue('corta-11ch', {}), 'La contraseña debe tener al menos 12 caracteres');
  assert.equal(await passwordIssue('x'.repeat(129), {}), 'La contraseña puede tener hasta 128 caracteres');
  assert.equal(await passwordIssue('MarianaRuiz-2026!', { email: 'mariana@negocio.mx' }), 'La contraseña no puede incluir tu correo ni el nombre de tu negocio');
  assert.equal(await passwordIssue('estudio-ana-de-cerca', { email: 'ana@x.mx' }), null); // parte local de 3: no cuenta
});
test('lista local sin distinguir mayúsculas', async () => {
  assert.equal(isCommonPassword('password1234'), true);
  assert.match((await passwordIssue('PASSWORD1234', {}))!, /de las más usadas/);
});
test('HIBP: solo salen 5 caracteres, con relleno; filtrada, limpia, lenta y apagada', async () => {
  // servidor falso: guarda ruta y cabecera Add-Padding; para el prefijo de «caballo-bateria-grapa» responde su sufijo con :7
  assert.equal(seen.path, `/range/${sha1('caballo-bateria-grapa').slice(0, 5)}`); assert.equal(seen.padding, 'true');
  assert.equal(await pwnedCount('caballo-bateria-grapa', url), 7);
  assert.equal(await pwnedCount('otra-frase-muy-rara-77', url), 0);
  assert.equal(await pwnedCount('lo-que-sea-largo-1', slowUrl), null); // el servidor tarda 3 s
  assert.equal(await pwnedCount('lo-que-sea-largo-1', 'off'), null);
});
t('las rutas rechazan una contraseña común', async () => {
  const r = await h.app.inject({ method: 'POST', url: '/api/signup', remoteAddress: '10.70.0.1', payload: { name: 'Eva', company: 'Negocio Eva', business_type: 'belleza', email: 'eva@n.mx', password: 'password1234', accept_terms: true } });
  assert.equal(r.statusCode, 400); assert.match(r.json().error, /de las más usadas/);
  assert.equal((await h.authed('PUT', '/api/me/password', { current: 'secreto123', password: 'corta' })).statusCode, 400);
});
```

- [ ] **Step 2:** FALLA.
- [ ] **Step 3:** Bajar la lista con curl de `raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (si el proxy no deja, detenerse y avisar; no inventar otra lista) y comprobar con `zcat assets/common-passwords.txt.gz | grep -cx password1234` que da 1 (si no, cambiar en la prueba por otra de 12+ que sí esté). Implementar el módulo; en las rutas listadas, `NewPassword` + `assertPasswordAllowed`; `Dockerfile`, config, config-check y `.env.example` (`PWNED_PASSWORDS_URL`, con `off` para servidores sin salida a internet).
- [ ] **Step 4:** PASA. Correr `test/signup.test.ts`, `test/superadmin-access.test.ts` y las de invitaciones; subir a 12+ caracteres las contraseñas de prueba que ahora se rechazan (no las de los casos que prueban el rechazo).
- [ ] **Step 5:** Commit `Etapa 2a: contraseñas de 12+, lista local y Have I Been Pwned por rango`.

---

### Task 6: scrypt más fuerte, recálculo al entrar y tope de cálculos

**Files:**
- Modify: `src/auth.ts`, `src/config.ts` (`passwordHashCost: env('PASSWORD_HASH_COST', 'standard')`, solo `standard` o `test`), `src/config-check.ts` (`password_hash_cost.test` es error si `PUBLIC_BASE_URL` empieza con `https://`), `test/harness.ts` (`process.env.PASSWORD_HASH_COST = 'test'`)
- Create: `test/password-hash.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): Promise<string>` → `scrypt$ln=15,r=8,p=3$<sal base64>$<hash base64>` (`ln=10,r=8,p=1` con `PASSWORD_HASH_COST=test`), con `maxmem: 64 * 1024 * 1024`.
  - `verifyPassword(pw: string, stored: string): Promise<boolean>` — acepta también el formato de antes `scrypt$<sal>$<hash>` (parámetros por omisión de Node).
  - `needsRehash(stored: string): boolean` — verdadero si sus parámetros no son los vigentes.
  - Tope: a lo más 4 cálculos a la vez y 64 esperando; el siguiente lanza `HttpError(503, 'Hay muchos intentos, prueba en unos segundos')`.
  - `login()`: si la contraseña es buena y `needsRehash`, guarda el hash nuevo y devuelve el usuario con él.

- [ ] **Step 1: Pruebas que fallan:** el formato nuevo con `ln=10,r=8,p=1` en pruebas; `verifyPassword` acepta un hash viejo hecho con `crypto.scrypt(pw, sal, 64)`; un usuario con hash viejo entra y queda con `scrypt$ln=`; con 4 cálculos detenidos (sustituir por un rato el cálculo por una promesa que no termina) y 64 en cola, el siguiente `hashPassword` rechaza con 503; config-check marca `password_hash_cost.test` con un `PUBLIC_BASE_URL` `https://`.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/signup.test.ts`).
- [ ] **Step 5:** Commit `Etapa 2a: scrypt con parámetros de OWASP, recálculo al entrar y tope de cálculos`.

---

### Task 7: Sesiones con caducidad por rol, `sid` obligatorio y cookies `__Host-`

**Files:**
- Modify: `src/auth.ts`, `src/store/index.ts`, `public/js/core.js`, `public/js/auth.js`
- Create: `test/identity-sessions.test.ts`

**Interfaces:**
- Produces:
  - `cookieName(base: 'cp_session' | 'cp_mfa' | 'cp_trust' | 'cp_device', secure = config.secureCookies): string` → `__Host-${base}` o `base`.
  - `sessionLimits(role: Role): { idleMs: number; maxMs: number }` — superadmin `{ idleMs: 30 * 60_000, maxMs: 12 * 3_600_000 }`; los demás `{ idleMs: 12 * 3_600_000, maxMs: 7 * 86_400_000 }`.
  - `createSession(userId, passwordHash, sid: string, exp: number)` firma con `hmac('session:' + payload)`; `readSession` devuelve `null` sin `sid`.
  - `store.touchUserSession(id: string, userId: string, idleMs: number): Promise<{ state: 'ok'; mfaAt: Date | null } | { state: 'idle' | 'gone' }>` — escribe `last_seen_at` solo si tiene más de 1 minuto.
  - `requireAuth` pone `req.mfaAt: Date | null`; con `idle` responde `401 { error: 'Tu sesión se cerró por inactividad', code: 'session_idle' }`.
  - `setSessionCookie` usa `sessionLimits(role).maxMs` para `expires_at` y `maxAge`, y `cookieName('cp_session')` (deja de exportarse en la tarea 8).
  - Panel: `requestApi` (`core.js`) con 401 y `code === 'session_idle'` guarda el aviso en `sessionStorage['login-notice']`, y `renderLogin` lo muestra con `toast` y lo borra.

- [ ] **Step 1: Pruebas que fallan** (crear `agente@s.mx` con `h.authed('POST', '/api/users', …)` en `before`; los casos que dejan inactiva la sesión del superadmin van al final o vuelven a entrar con `h.loginAs`):

```ts
t('máximo: 7 días o 12 h según el rol', async () => {
  // expires_at - created_at de la sesión más nueva de cada uno: 7 días para el agente, 12 h para el superadmin
});
t('una cookie sin sid o firmada sin el prefijo no entra', async () => {
  // payload { uid, pv, exp } firmado con hmac('session:' + payload) → 401; payload con sid firmado con hmac(payload) → 401
});
test('cookieName con y sin HTTPS', () => {
  assert.equal(cookieName('cp_session', true), '__Host-cp_session');
  assert.equal(cookieName('cp_session', false), 'cp_session');
});
t('12 h sin uso cierran la sesión del equipo; 30 min la del superadmin', async () => {
  const a = await h.loginAs('agente@s.mx', 'clave-agente-larga');
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '12 hours 1 minute' WHERE user_id = (SELECT id FROM users WHERE email = 'agente@s.mx')`);
  const r = await a('GET', '/api/me');
  assert.equal(r.statusCode, 401); assert.equal(r.json().code, 'session_idle');
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'admin@test.mx')`);
  assert.equal((await h.authed('GET', '/api/me')).json().code, 'session_idle');
});
```

- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA, más `test/audit-high-fixes.test.ts` y `test/superadmin-access.test.ts`.
- [ ] **Step 5:** Commit `Etapa 2a: sesiones que caducan por inactividad según el rol; sin cookies heredadas`.

---

### Task 8: El reto y las cinco puertas (2FA obligatorio), códigos de recuperación y el arnés

**Files:**
- Create: `src/identity/recovery-codes.ts`, `src/identity/mfa.ts`, `src/routes/mfa.ts`, `test/identity-login.test.ts`
- Modify: `src/auth.ts` (sin exportar `setSessionCookie`), `src/routes/admin.ts`, `src/routes/signup.ts`, `src/routes/invitations.ts`, `src/routes/google-login.ts`, `src/app.ts`, `test/harness.ts`, los 22 archivos de prueba que se registran por `/api/signup`, los 7 que llaman `/api/login` directo, `scripts/ux-fixture.mts`

**Interfaces:**
- Consumes: `matchTotp`, `newTotpSecret`, `otpauthUri`, `qrDataUri`, `encryptSecret`/`decryptSecret` (tarea 2); `countHit`, `LIMITS` (tarea 3); `notifyUser` (tarea 4); `cookieName`, `sessionLimits`, `createSession` (tarea 7).
- Produces (`src/identity/recovery-codes.ts`):
  - `newRecoveryCodes(n = 10): string[]` — alfabeto `0123456789abcdefghjkmnpqrstvwxyz`, formato `xxxx-xxxx-xxxx`.
  - `normalizeRecoveryCode(input: string): string` — minúsculas, sin espacios ni guiones, `o→0`, `i` y `l→1`.
  - `replaceRecoveryCodes(userId: string, client?: Queryable): Promise<string[]>`; `useRecoveryCode(userId: string, input: string): Promise<number | null>` (atómico; devuelve cuántos quedan, o `null` si no sirvió); `remainingRecoveryCodes(userId: string): Promise<number>`.
- Produces (`src/identity/mfa.ts`):
  - `type ChallengePurpose = 'verify' | 'enroll'`; `interface Challenge { uid: string; pv: string; via: SessionVia; purpose: ChallengePurpose; cid: string; exp: number }`.
  - `readChallenge(req): Challenge | null` (firma `hmac('mfa-challenge:' + payload)`, vence a los 15 min); `clearChallenge(reply): void`.
  - `beginLogin(reply: FastifyReply, user: { id: string; role: Role; password_hash: string; totp_enabled_at: Date | null }, via: SessionVia): Promise<{ mfa: ChallengePurpose } | { ok: true }>` — en esta tarea siempre deja el reto (el dispositivo recordado entra en la tarea 10).
  - `challengeUser(req): Promise<ChallengeUser | null>` — reto válido, usuario activo con cuenta activa y `pv` igual al de su contraseña actual. `ChallengeUser = User & { password_hash: string; totp_secret: string | null; totp_pending: string | null; totp_enabled_at: Date | null; totp_last_step: number; mfa_locked_until: Date | null }`.
  - `verifyUserCode(user: ChallengeUser, code: string): Promise<{ result: 'ok' | 'bad' | 'locked'; recoveryRemaining?: number }>` — TOTP con `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2` (si no actualiza, `bad`); si no es TOTP y normalizado mide 12, código de recuperación (aviso `recovery_used`).
  - `startEnrollment(user): Promise<{ secret: string; otpauth: string; qr: string }>` — reutiliza `totp_pending` si ya hay uno; issuer = `(await mailBrand(user.account_id)).fromName ?? 'Panel de Chatbots'`.
  - `confirmEnrollment(userId: string, code: string): Promise<boolean>` — pasa el pendiente a `totp_secret`, `totp_enabled_at = now()`, `totp_last_step` = paso usado.
  - `finishChallenge(reply, user, via): Promise<string>` — abre la sesión con `mfaAt: new Date()` y borra el reto.
  - `renewSessionAfterPasswordChange(reply, user, mfaAt: Date | null): Promise<string>` — solo para `PUT /api/me/password`.
  - `openSession` es privada del módulo (la usan las tres anteriores).
- Produces (`src/routes/mfa.ts`, `mfaPublicRoutes(app)`, registrada en `app.ts` después de `sessionRoutes`):
  - `POST /api/login/2fa { code: string (máx. 40), remember?: boolean }` → `{ ok: true, user, recovery_remaining? }`; sin reto válido `401 { error: 'Vuelve a escribir tu contraseña para continuar', code: 'challenge_expired' }`; código malo `400 { error: 'El código no es correcto' }`; agotados los 5 del reto, `challenge_expired` aunque el código sea bueno.
  - `GET /api/2fa/enroll` → `{ secret, otpauth, qr, account }` (solo reto `enroll`).
  - `POST /api/2fa/enroll { code }` → `{ ok: true, user, recovery_codes }` y aviso `mfa_enabled`; código malo `400 { error: 'El código no es correcto' }`.
- Las puertas: `/api/login` responde `{ mfa }` (sin `user`); `/api/signup` y `/api/signup/google` devuelven lo de antes más `mfa: 'enroll'` y ninguna cookie de sesión; `/api/invitation/accept` igual; Google con cuenta pone el reto y redirige a `/#/login/codigo` o `/#/login/configurar`; `PUT /api/me/password` usa `renewSessionAfterPasswordChange` con el `mfaAt` de la sesión actual y avisa `password_changed`; `/api/reset-password` no abre sesión y avisa `password_reset`. `/api/login` y `/api/me` nunca incluyen `totp_*` ni `password_hash`.
- Arnés (`test/harness.ts`): `totpSecrets: Map<string, string>`; `sessionFrom(res, email): Promise<string>` (con `mfa === 'enroll'`: `GET /api/2fa/enroll` con la cookie de reto, guarda el secreto y manda el código; con `verify`: `POST /api/login/2fa`; devuelve `nombre=valor` de la cookie de sesión); `codeFor(email): Promise<string>` (pone `totp_last_step = 0` en la base de pruebas y calcula el código actual); `loginAs` usa `sessionFrom`. `scripts/ux-fixture.mts` guarda también `{ email, password }` por rol para que la auditoría abra sesiones nuevas.

- [ ] **Step 1: Pruebas que fallan** (`test/identity-login.test.ts`; `login(email, pw)`, `get(url, cookie)` y `post(url, cookie, body)` son atajos de `h.app.inject`):

```ts
const cookieOf = (r: any, name: string) => [r.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith(name + '='))?.split(';')[0];
t('contraseña: sin código no hay sesión; la primera vez pide configurar', async () => {
  const r = await login('nuevo@login.mx', 'clave-larga-de-nuevo');
  assert.deepEqual(r.json(), { mfa: 'enroll' });
  assert.equal(cookieOf(r, 'cp_session'), undefined);
  assert.equal((await get('/api/me', cookieOf(r, 'cp_mfa')!)).statusCode, 401);
});
t('configurar: QR, mismo secreto al recargar, 10 códigos y sesión', async () => {
  const c = cookieOf(await login('nuevo@login.mx', 'clave-larga-de-nuevo'), 'cp_mfa')!;
  const a = (await get('/api/2fa/enroll', c)).json(), b = (await get('/api/2fa/enroll', c)).json();
  assert.equal(a.secret, b.secret); assert.match(a.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((await post('/api/2fa/enroll', c, { code: '000000' })).statusCode, 400);
  const ok = await post('/api/2fa/enroll', c, { code: totpAt(a.secret, currentStep()) });
  assert.equal(ok.json().recovery_codes.length, 10);
  assert.match(ok.json().recovery_codes[0], /^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
  assert.ok(cookieOf(ok, 'cp_session'));
  assert.ok(!JSON.stringify(ok.json().user).includes('totp'));
});
t('verificar: el mismo código no sirve dos veces; dos peticiones a la vez, solo una entra', async () => {});
t('cinco códigos malos agotan el reto', async () => {}); // 5 × 400; el 6.º, aun bueno, 401 challenge_expired
t('código de recuperación en mayúsculas y con O por 0; aviso por correo', async () => {}); // recovery_remaining === 9; correo «Usaste un código de recuperación»
t('reto vencido: challenge_expired; el secreto pendiente sigue sirviendo al volver a entrar', async () => {}); // reto firmado con exp pasado; nuevo login → mismo secret
t('si la desactivan o cambia su contraseña entre la contraseña y el código, el reto ya no abre sesión', async () => {});
t('registro, invitación y Google piden configurar antes de la sesión', async () => {}); // mfa: 'enroll', sin cp_session; Google: redirect a /#/login/configurar con cp_mfa
t('restablecer por correo no abre sesión y avisa', async () => {});
t('ninguna ruta abre sesión por su cuenta', async () => {
  for (const f of fs.readdirSync('src/routes')) assert.doesNotMatch(fs.readFileSync(`src/routes/${f}`, 'utf8'), /setSessionCookie|openSession/, f);
});
```

- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3:** Implementar `recovery-codes.ts`, `mfa.ts`, `routes/mfa.ts` y las puertas.
- [ ] **Step 4:** Correr `test/identity-login.test.ts`: PASA.
- [ ] **Step 5:** Arnés: `sessionFrom`, `codeFor`, `loginAs`. Migrar los archivos que toman la cookie de `/api/signup` (`String(r.headers['set-cookie']).split(';')[0]` → `await h.sessionFrom(r, email)`) y los que llaman `/api/login` directo; `ux-fixture.mts`.
- [ ] **Step 6:** Suite completa en segundo plano: 0 fallas (las omitidas, las mismas de antes).
- [ ] **Step 7:** Commit `Etapa 2a: 2FA obligatorio en las cinco puertas, códigos de recuperación y arnés`.

---

### Task 9: Panel: código, configuración y regreso de Google

**Files:**
- Create: `public/js/mfa.js`, `scripts/test-identity-ux.mts`
- Modify: `public/js/auth.js`, `public/js/main.js`, `public/js/core.js`, `src/routes/mfa.ts` (`GET /api/2fa/challenge`), `package.json` (`"test:identity:ux": "node --import tsx scripts/test-identity-ux.mts"`), `.github/workflows/ci.yml` (paso nuevo tras `test:public:ux`), `scripts/buttons/areas/publicas.mts`

**Interfaces:**
- Consumes: rutas de la tarea 8.
- Produces:
  - `GET /api/2fa/challenge` → `{ purpose, superadmin }` con reto válido; si no, `401 challenge_expired`.
  - Rutas del panel: `#/login/codigo` → `renderMfaVerify()`, `#/login/configurar` → `renderMfaEnroll()` (ambas en `mfa.js`, cargadas como las de `auth.js`).
  - `afterLogin(r)` en `auth.js`: `r.mfa === 'verify'` → `#/login/codigo`; `enroll` → `#/login/configurar`; si no, al panel. La usan entrar, registro, registro con Google e invitación. El `checkout_url` del registro se guarda en `sessionStorage['after-mfa']` y se abre al terminar la configuración.
  - `renderMfaVerify`: título `Verificación en dos pasos`; campo `Código de 6 dígitos` (`inputmode="numeric"`, `autocomplete="one-time-code"`); casilla `Recordar este dispositivo 30 días` (oculta si `superadmin`); enlace `Usar un código de recuperación` (cambia el campo a `Código de recuperación`); botón `Entrar`.
  - `renderMfaEnroll`: paso 1 `Escanea este código con tu app de autenticación` (el QR y `¿No puedes escanearlo? Escribe esta clave` con el secreto en grupos de 4); paso 2 `Código de 6 dígitos` y `Activar`; paso 3 `Guarda tus códigos de recuperación` con la lista, `Copiar`, `Descargar .txt` (`codigos-de-recuperacion.txt`) y la casilla `Ya los guardé en un lugar seguro`, que habilita `Continuar`.
  - `core.js`: un 401 con `code: 'challenge_expired'` lleva a `#/login` con el aviso `Vuelve a escribir tu contraseña para continuar` (mismo mecanismo de `login-notice` de la tarea 7).

- [ ] **Step 1: Prueba en navegador que falla** (`scripts/test-identity-ux.mts`, mismo esquema que `test-billing-ux.mts`; a 1366 y 390 px, axe sin `serious`/`critical`, sin desbordamiento): alguien nuevo entra con contraseña, ve el QR, escribe el código (con `totpAt` sobre el secreto que muestra la página), ve los 10 códigos, no puede continuar sin la casilla, continúa y llega al panel; sale, vuelve a entrar y escribe el código; entra con un código de recuperación; un reto vencido muestra el aviso en `#/login`; el registro con plan abre el pago después de configurar.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. En `scripts/buttons/areas/publicas.mts`, el caso `Entrar` escribe el código (`h.codeFor('admin@auditoria.test')`) antes de esperar el panel.
- [ ] **Step 4:** `test:identity:ux`, `test:billing:ux` y `test:public:ux`: PASAN. `npm run -s check:frontend`: limpio.
- [ ] **Step 5:** Commit `Etapa 2a: pantallas de código y configuración en el panel`.

---

### Task 10: Dispositivo conocido y recordado

**Files:**
- Create: `src/identity/devices.ts`, `test/identity-devices.test.ts`
- Modify: `src/identity/mfa.ts`, `src/routes/mfa.ts`, `src/routes/admin.ts` (cerrar las otras sesiones también olvida los recordados; desactivar o borrar a alguien), `src/routes/signup.ts` (restablecer), `src/auth.ts` (`resetSuperadminPassword`), `public/js/admin.js` (texto de «Cerrar sesión en todos los demás dispositivos»)

**Interfaces:**
- Produces:
  - `noteDevice(req, reply, user): Promise<{ isNew: boolean }>` — cookie `cp_device` (1 año, 32 bytes aleatorios; se guarda su SHA-256); `isNew` si esa persona no tenía ese dispositivo.
  - `trustDevice(req, reply, userId: string): Promise<void>` — cookie `cp_trust` (30 días), `trust_hash`, `trusted_until`.
  - `trustedDeviceFor(req, user: { id: string; role: Role }): Promise<boolean>` — siempre falso para superadmin.
  - `forgetTrustedDevices(userId: string, o: { only?: string } = {}): Promise<number>`.
  - `listTrustedDevices(userId: string): Promise<{ id: string; device: string; last_seen_at: Date; trusted_until: Date }[]>`.
  - `beginLogin` abre la sesión (con `mfaAt: null`) si la persona tiene `totp_enabled_at` y `trustedDeviceFor`; `finishChallenge` llama `noteDevice` y, si `isNew`, `notifyUser(…, 'new_device', { device, ip })`; `POST /api/login/2fa` con `remember: true` llama `trustDevice` salvo superadmin.
  - Olvidan los recordados: `PUT /api/me/password`, `/api/reset-password`, `POST /api/me/sessions/revoke-others`, desactivar o borrar a alguien, `resetSuperadminPassword`. El texto del panel para cerrar las demás sesiones agrega `También se olvidan los dispositivos recordados.`

- [ ] **Step 1: Pruebas que fallan:** con `remember`, el siguiente login responde `ok: true` (con `user`) y abre una sesión con `mfa_at` nulo; el superadmin con `remember: true` no recibe `cp_trust` y vuelve a pedir código; el `cp_trust` de otra persona no salta nada; cada evento de la lista olvida (el siguiente login pide código otra vez); un dispositivo nuevo manda `Nuevo inicio de sesión en tu cuenta` y el mismo dispositivo, no.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/identity-login.test.ts`).
- [ ] **Step 5:** Commit `Etapa 2a: dispositivo recordado 30 días (nunca superadmin) y aviso de dispositivo nuevo`.

---

### Task 11: Límites de intentos en la contraseña y el código

**Files:**
- Modify: `src/routes/admin.ts` (`/api/login`, `PUT /api/me/password`), `src/routes/signup.ts` (restablecer limpia el contador de la cuenta), `src/identity/mfa.ts`, `src/routes/mfa.ts`, `src/auth.ts` (se van `loginAllowed`, `registerLoginFailure` y su `Map`)
- Create: `test/identity-limits.test.ts`

**Interfaces:**
- Consumes: `countHit`, `hitsFor`, `clearHits`, `LIMITS` (tarea 3); `trustedDeviceFor` (tarea 10).
- Comportamiento:
  - `/api/login`: con `hitsFor(login-ip) >= 8` → `429 { error: 'Demasiados intentos, espera 15 minutos' }`; con `hitsFor(login-acct) >= 10` y sin dispositivo recordado de esa persona → `429 { error: 'Demasiados intentos con esta cuenta. Entra desde un dispositivo recordado o recupera tu contraseña por correo.' }`; cada contraseña mala suma a las dos claves (exista o no el correo); `/api/reset-password` hace `clearHits(login-acct:<correo>)`.
  - `PUT /api/me/password` con la actual equivocada suma a `login-acct` y respeta el mismo tope.
  - `verifyUserCode`: cada código malo suma a `mfa-user:<id>` (y la ruta del reto a `mfa-challenge:<cid>`); al llegar a 10 pone `mfa_locked_until = now() + 1 h`, avisa `mfa_locked` y responde `429 { error: 'Bloqueamos la verificación por una hora por demasiados intentos. Si no fuiste tú, cambia tu contraseña.' }`; con `mfa_locked_until` vigente, `locked` sin revisar el código.

- [ ] **Step 1: Pruebas que fallan:** 8 contraseñas malas desde `2001:db8:1:2::1` y `2001:db8:1:2::ffff` bloquean esa /64 pero no `10.9.9.9`; 10 malas a una cuenta desde 10 IP distintas bloquean la contraseña buena desde una IP nueva, pero no desde su dispositivo recordado; 12 intentos simultáneos no pasan del tope (`hitsFor('login-ip:…')` igual a los intentos); 10 códigos malos repartidos en dos retos bloquean una hora y mandan el correo.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/identity-login.test.ts` y `test/identity-devices.test.ts`).
- [ ] **Step 5:** Commit `Etapa 2a: límites de contraseña y código en la base (conexión, cuenta, persona)`.

---

### Task 12: Verificación reciente

**Files:**
- Create: `src/identity/step-up.ts`, `test/identity-step-up.test.ts`
- Modify: `src/app.ts`, `src/routes/{admin,integrations,automation,billing,self-service,invitations}.ts`, `src/routes/mfa.ts`, `public/js/core.js`, `public/js/mfa.js`, `public/js/integrations.js`, `public/js/automation.js`, `public/js/billing.js` (descarga de datos), `scripts/test-identity-ux.mts`

**Interfaces:**
- Produces:
  - `STEP_UP_MS = 15 * 60_000`; `stepUpHook(req, reply)` con `api.addHook('preHandler', …)` justo después de `requireAuth`: si `req.routeOptions.config.stepUp` y no `req.mfaAt && Date.now() - req.mfaAt.getTime() < STEP_UP_MS` → `403 { error: 'Escribe tu código de verificación para continuar', code: 'step_up' }`.
  - `assertRecentMfa(req): void` — lo mismo dentro de un handler (lanza un `HttpError` 403 con ese `code`).
  - Con sesión: `POST /api/2fa/step-up { code }` → `{ ok: true }` y `UPDATE user_sessions SET mfa_at = now() WHERE id = $sid` (usa `verifyUserCode` y sus límites); `GET /api/2fa/recent` → `{ recent: boolean }`.
  - Rutas con `config: { stepUp: true }`: `PUT /api/me/password`, `POST /api/me/2fa/recovery-codes`, `POST /api/me/2fa/authenticator`, `POST /api/me/2fa/authenticator/confirm`, `POST /api/users`, `DELETE /api/users/:id`, `POST /api/users/:id/2fa/reset`, `POST /api/api-keys`, `DELETE /api/api-keys/:id`, `POST /api/webhook-endpoints`, `PUT /api/webhook-endpoints/:id`, `POST /api/settings/rotate-webhook-secret`, `POST /api/settings/rotate-secrets`, `GET /api/settings/secrets` (nueva), `POST /api/billing/checkout`, `POST /api/billing/change`, `POST /api/billing/payment-method`, `POST /api/billing/portal`, `POST /api/billing/cancel`, `PUT /api/billing/fiscal`, `GET /api/account/export.zip`, `POST /api/account/deletion`, `POST /api/accounts`, `DELETE /api/accounts/:id`, `PUT /api/system/zernio`, `DELETE /api/system/zernio`. (Las de `/api/me/2fa/*` y `/api/users/:id/2fa/reset` las crea la tarea 13; esta tarea las agrega a la lista de la prueba cuando existan.)
  - Con `assertRecentMfa` según el cuerpo: `POST /api/invitations` con `role: 'admin'`; `PUT /api/users/:id` cuando cambia `role`, `active`, `password` o `email`.
  - Secretos de Ajustes: `GET /api/settings` y `PUT /api/settings` devuelven `webhook_secret: ''`, `calendar_token: ''`, `ics_url: ''` y `secrets_hidden: true`; `GET /api/settings/secrets` → `{ webhook_secret, calendar_token, ics_url }`. En `integrations.js` y `automation.js`, un botón `Mostrar` los pide.
  - Panel: `requestApi` con `403` y `code === 'step_up'` abre `stepUpDialog()` (`mfa.js`: título `Confirma que eres tú`, campo `Código de 6 dígitos` o de recuperación, botón `Confirmar`) y, si se confirma, repite la petición una vez; si se cancela, el error dice `Necesitas confirmar con tu código para hacer esto`. `ensureRecentMfa(): Promise<boolean>` (`GET /api/2fa/recent` y, si hace falta, el diálogo) va antes de abrir la descarga de `export.zip`, que es un enlace y no una petición `api()`.

- [ ] **Step 1: Pruebas que fallan** (`test/identity-step-up.test.ts`):

```ts
const STEP_UP: [string, string][] = [['PUT', '/api/me/password'], ['POST', '/api/api-keys'] /* … toda la lista de arriba, con :id cambiado por un uuid */];
t('cada ruta delicada pide el código si pasaron más de 15 minutos', async () => {
  await pool.query(`UPDATE user_sessions SET mfa_at = now() - interval '16 minutes'`);
  for (const [m, url] of STEP_UP) { const r = await h.authed(m, url, {}); assert.equal(r.statusCode, 403, `${m} ${url}`); assert.equal(r.json().code, 'step_up', `${m} ${url}`); }
});
t('con el código, la misma ruta pasa', async () => {}); // POST /api/2fa/step-up con h.codeFor; luego POST /api/api-keys → 200
t('entrar con dispositivo recordado no da verificación reciente', async () => {});
t('Ajustes ya no muestra los secretos; «Mostrar» los pide con verificación reciente', async () => {});
t('el Copiloto no llega a ninguna ruta delicada', async () => {
  const src = (fs.readdirSync('src/copilot', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(`src/copilot/${f}`, 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/['`](\/api\/[\w/-]+)/g)].map((m) => m[1]));
  const sensitive = new Set(STEP_UP.map(([, u]) => u.replace(/\/[0-9a-f-]{36}.*/, '')));
  assert.deepEqual([...used].filter((u) => sensitive.has(u)), ['/api/users']);
  assert.doesNotMatch(src, /send<[^>]*>\(\s*'(POST|PUT|DELETE)',\s*'\/api\/users/); // al equipo solo lo lee
});
```

- [ ] **Step 2:** FALLA. **Step 3:** Implementar servidor y panel; en `test-identity-ux.mts`, con `mfa_at` viejo, crear una llave de API abre `Confirma que eres tú` y con el código se crea.
- [ ] **Step 4:** PASA; correr `test/integrations.test.ts`, `test/billing*.test.ts`, `test/export.test.ts`, `test/compliance.test.ts`, `test/automation*.test.ts` y `test:identity:ux`.
- [ ] **Step 5:** Commit `Etapa 2a: verificación reciente (15 min) para acciones delicadas; secretos de Ajustes ocultos`.

---

### Task 13: Mi perfil → seguridad, y restablecer el 2FA de otra persona

**Files:**
- Modify: `src/routes/mfa.ts`, `src/routes/admin.ts` (`PUT /api/users/:id`: cambiar `role` cierra sus sesiones; `GET /api/users` agrega `mfa_enabled`), `public/js/admin.js` (Mi perfil y Equipo), `public/js/mfa.js`, `test/identity-step-up.test.ts` (las rutas nuevas a la lista), `scripts/test-identity-ux.mts`
- Create: `test/identity-profile.test.ts`

**Interfaces:**
- Produces (con sesión):
  - `GET /api/me/security` → `{ totp_enabled_at, recovery_remaining, devices }` (`devices` = `listTrustedDevices`).
  - `POST /api/me/2fa/recovery-codes` → `{ recovery_codes }` (aviso `recovery_regenerated`).
  - `POST /api/me/2fa/authenticator` → `{ secret, otpauth, qr }` (pendiente); `POST /api/me/2fa/authenticator/confirm { code }` → `{ ok: true }` (aviso `mfa_changed`).
  - `DELETE /api/me/devices/:id` → `{ ok: true }`.
  - `POST /api/users/:id/2fa/reset` → `{ ok: true }`: un administrador de la misma cuenta o el superadmin; nadie a sí mismo (`400 { error: 'Para cambiar tu propia app usa Mi perfil' }`); un administrador nunca al superadmin ni a alguien de otra cuenta (`404`). Borra `totp_*`, códigos y dispositivos recordados, pone `mfa_locked_until = NULL`, cierra sus sesiones y avisa `mfa_reset` con `by`.
  - `GET /api/users`: `mfa_enabled: boolean` por persona (nunca el secreto).
  - Panel, Mi perfil: sección `Verificación en dos pasos` (estado, `Cambiar de app`, `Te quedan N códigos de recuperación` con `Generar códigos nuevos`, aviso fijo con 2 o menos, `Dispositivos recordados` con `Olvidar`). Equipo: etiqueta `2FA activo` o `2FA pendiente` y botón `Restablecer 2FA`, con la confirmación `Su verificación en dos pasos se borra, se cierran sus sesiones y la configura otra vez al entrar.`

- [ ] **Step 1: Pruebas que fallan:** permisos de cada ruta (administrador de otra cuenta → 404; agente → 403; uno mismo → 400); después de restablecer, su siguiente login pide `enroll`, llega el correo y sus cookies dejan de valer; al cambiar de app, el código de la vieja ya no sirve; los códigos nuevos invalidan los viejos; cambiar el rol de alguien cierra sus sesiones; `GET /api/users` sin nada de `totp`.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar; en `test-identity-ux.mts`: Mi perfil muestra la sección, `Generar códigos nuevos` (con verificación reciente) y `Olvidar` un dispositivo; en Equipo se restablece el 2FA de un agente.
- [ ] **Step 4:** PASA (más `test/identity-step-up.test.ts` y `test:identity:ux`).
- [ ] **Step 5:** Commit `Etapa 2a: seguridad en Mi perfil y restablecer el 2FA del equipo`.

---

### Task 14: Peticiones de otros sitios

**Files:**
- Create: `src/identity/origin-guard.ts`, `test/origin-guard.test.ts`
- Modify: `src/app.ts` (gancho `onRequest` global)

**Interfaces:**
- Produces: `crossSiteRejected(req: FastifyRequest): boolean` — solo para métodos que no son `GET`/`HEAD`/`OPTIONS` y traen la cookie `cookieName('cp_session')` o `cookieName('cp_mfa')`: verdadero si `sec-fetch-site` existe y no es `same-origin` ni `none`, o si no existe, hay `origin` y su host no es el `host` de la petición; sin ninguna de las dos cabeceras, falso. Respuesta: `403 { error: 'Petición rechazada: viene de otro sitio' }`.

- [ ] **Step 1: Pruebas que fallan:** con cookie de sesión, `POST /api/me/sessions/revoke-others` con `sec-fetch-site: cross-site` → 403; `same-site` → 403; `same-origin` → 200; sin `sec-fetch-site` y con `origin: https://malo.example` → 403; `origin` igual al `host` → 200; sin cabeceras → 200; `POST /api/login/2fa` con `cross-site` y cookie de reto → 403; un `POST /webhook/…` sin cookie y con `cross-site` sigue igual.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA (más `test/channels.test.ts` por los webhooks).
- [ ] **Step 5:** Commit `Etapa 2a: rechazar peticiones de otros sitios que traen la cookie del panel`.

---

### Task 15: `./riverrun admin-password` y `rotate-secret`

**Files:**
- Create: `src/cli/rekey-mfa.ts`, `test/rekey-mfa.test.ts`
- Modify: `src/auth.ts` (`resetSuperadminPassword`), `src/cli/admin-password.ts`, `riverrun`, `scripts/test-cli.sh`, `test/superadmin-access.test.ts`

**Interfaces:**
- Produces:
  - `resetSuperadminPassword` además borra `totp_*`, sus códigos y dispositivos, `mfa_locked_until`, y hace `clearHits(login-acct:<correo>, mfa-user:<id>)`. El CLI imprime `Su verificación en dos pasos se restableció: la configura al entrar.` y la línea del límite pasa a `Si tu conexión quedó bloqueada por intentos fallidos, espera 15 minutos.`
  - `rekeyMfaSecrets(newSecret: string): Promise<number>` (exportada desde `src/cli/rekey-mfa.ts`; el archivo, al correr como comando, lee el secreto de la entrada): en una transacción, `SELECT … FOR UPDATE` de los usuarios con `totp_secret` o `totp_pending`, descifra con el actual y cifra con el nuevo; si alguno no se descifra, no cambia nada y lanza `No se pudo re-cifrar el 2FA de N personas: no se cambió nada`. El comando imprime `Secretos de verificación re-cifrados: N` o el error con `exit 1`.
  - `riverrun cmd_rotate_secret`: tras el respaldo y antes de `env_set`, `printf '%s\n' "$new" | dc exec -T backend node dist/cli/rekey-mfa.js || die "No se pudieron re-cifrar los secretos de verificación en dos pasos: no se cambió nada."`; el aviso de consecuencias agrega `Los secretos de la verificación en dos pasos se vuelven a cifrar con el nuevo.`

- [ ] **Step 1: Pruebas que fallan:** en `superadmin-access.test.ts`, tras `resetSuperadminPassword` el siguiente login responde `{ mfa: 'enroll' }` y sus contadores quedan en 0; `test/rekey-mfa.test.ts`: con dos personas con 2FA, `rekeyMfaSecrets('nuevo')` deja `decryptSecret(totp_secret, 'nuevo')` igual al secreto de antes; con uno dañado lanza y ninguno cambia. En `scripts/test-cli.sh` (el `docker` simulado anota `exec -T backend node dist/cli/rekey-mfa.js` y falla si existe `FALLA_REKEY`): el orden es respaldo → re-cifrado → `up -d backend`; con `FALLA_REKEY` el `.env` conserva el secreto viejo; el secreto nuevo no aparece ni en el registro ni en la salida.
- [ ] **Step 2:** FALLA. **Step 3:** Implementar. **Step 4:** PASA; `bash scripts/test-cli.sh` y `shellcheck -S warning riverrun docker/backup/backup.sh docker/backup/redis-load.sh scripts/*.sh ops/*.sh` limpios.
- [ ] **Step 5:** Commit `Etapa 2a: admin-password restablece el 2FA; rotate-secret re-cifra los secretos de verificación`.

---

### Task 16: Auditoría de botones y documentación

**Files:**
- Modify: `scripts/test-buttons.mts` (`contextFor` abre una sesión nueva con `h.loginAs` por contexto, con las credenciales de `ux-fixture.mts`), `scripts/buttons/sin-presionar.json`, `scripts/buttons/areas/equipo.mts` (restablecer 2FA), `docs/seguridad.md`, `docs/produccion.md`, `README.md`, `docs/superpowers/specs/2026-10-30-seguridad-etapa-2-identidad-design.md` (lo que cambió al planear: `rate_limits` con `expires_at`; `PWNED_PASSWORDS_URL=off` en vez de vacía; avisos en `src/identity/notices.ts` con la marca de la cuenta; el secreto pendiente se reutiliza; los secretos de Ajustes se muestran con `Mostrar`)

- [ ] **Step 1:** Correr `npm run test:buttons` y anotar los controles nuevos que fallan por no presionarse.
- [ ] **Step 2:** Cada control nuevo: presionarlo en un área (lo preferido) o, si solo lo cubre `test:identity:ux`, anotar su motivo `Otra prueba: test:identity:ux lo presiona` en `sin-presionar.json`.
- [ ] **Step 3:** `npm run test:buttons`: PASA.
- [ ] **Step 4:** Documentación: en `docs/seguridad.md`, la fila de la etapa 2 queda «2a ✅, 2b pendiente», una sección «Etapa 2a: lo que se corrigió» (tabla hallazgo / arreglo / prueba) y «Cambios que nota la gente»; en `docs/produccion.md`, cómo recuperar el acceso (la tabla 2a.10 de la spec) y `PWNED_PASSWORDS_URL`; el README enlaza la sección.
- [ ] **Step 5:** Commit `Etapa 2a: auditoría de botones y documentación`.

---

### Task 17: Verificación final y PR

- [ ] **Step 1:** Suite completa (en segundo plano): 0 fallas. Navegador: `test:ux`, `test:semantic:ux`, `test:agent:ux`, `test:contact:ux`, `test:quotes:ux`, `test:billing:ux`, `test:public:ux`, `test:identity:ux`, `test:buttons`: PASAN. `bash scripts/test-cli.sh`, shellcheck, `npx tsc --noEmit` y `npm run -s check:frontend`: limpios.
- [ ] **Step 2:** Revisión independiente de toda la rama (un revisor nuevo, del modelo más capaz, con la spec y este plan); corregir lo que encuentre, cada cosa con su prueba.
- [ ] **Step 3:** Mezclar `claude/seguridad-etapa-1` si cambió; push; PR «Seguridad, etapa 2a: acceso» contra `claude/seguridad-etapa-1` mientras #90 siga abierto (después, contra `main`).
