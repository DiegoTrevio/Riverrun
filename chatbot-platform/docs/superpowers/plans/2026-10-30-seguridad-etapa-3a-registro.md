# Seguridad, etapa 3a (Registro) — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que nadie pruebe tarjetas robadas con el registro ni encadene pruebas gratis: captcha obligatorio, correo
verificado y 2FA antes de ver una página de pago, la prueba empieza al confirmar una tarjeta, una prueba por persona, y
ninguna cuenta en pausa gasta IA.

**Architecture:** Tres módulos nuevos con una tarea cada uno: `src/billing/trial-claims.ts` (marcas HMAC de correo, Google
y tarjeta), `src/billing/card-check.ts` (las puertas, los topes y el freno de la verificación de tarjeta, y el inicio de la
prueba) y `src/ai/gate.ts` (la puerta de IA, llamada dentro de `accountAi`, por donde pasan todas las llamadas de IA). La
verificación de tarjeta **es** el pago que ya existe (`POST /api/billing/checkout`) con prueba de `TRIAL_DAYS` días cuando
la persona tiene prueba disponible; el estado del proveedor lleva el fin de prueba y la huella de la tarjeta.

**Tech Stack:** Node 22, TypeScript, Fastify 5, PostgreSQL 16, zod 4, `node:test`, Playwright (Chromium preinstalado). Sin
dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-30-seguridad-etapa-3-registro-cobros-design.md` (sección «PR 3a · Registro»).

## Decisiones de este plan (ajustan la spec; la spec se corrige en la tarea 12)

1. **No hay ruta `/api/billing/card-check`:** la verificación de tarjeta es `POST /api/billing/checkout` (ya es solo del
   dueño con verificación reciente) con las puertas de la tarea 6. Una ruta menos, y los topes protegen todo pago.
2. **Captcha de Google en «Registro con Google»** (`POST /api/signup/google` con `turnstile_token`), no antes de ir a
   Google: la cuenta solo se crea en ese paso, y entrar con Google a una cuenta existente sigue sin captcha.
3. **Sin ningún proveedor de cobro configurado**, el registro sigue como hoy (prueba sin tarjeta); en producción
   `config:check` lo marca como advertencia «Registro sin cobro: las pruebas no piden tarjeta».
4. **La cuenta esperando tarjeta nace con `paused_at`:** la retención ya borra sola las cuentas del registro en pausa
   (con su correo de aviso), así que los registros abandonados no se acumulan.
5. **La puerta de IA es `AiBudgetBlocked` con el código `ai_paused` (402):** el motor, la entrada de mensajes y el
   Copiloto ya atrapan esa clase y no fallan; un embedding al guardar conocimiento queda pendiente.
6. **`expires_at` de Stripe:** el mínimo que acepta Stripe es 30 minutos; se manda ahora + 31 minutos.

## Global Constraints

- Prueba: `TRIAL_DAYS` (14). Empieza al confirmar la tarjeta; el fin de prueba es el que dice el proveedor.
- Topes (con `countHit` y la IP por `ipKey`): registros 3 por hora y 10 por día por conexión; `SIGNUP_DAILY_MAX` (200) por día en toda la plataforma, aviso al superadministrador al 80 %; verificaciones de tarjeta 5 por día por cuenta, 10 por día por conexión, 300 por día en toda la plataforma; una sesión vigente por cuenta (30 minutos).
- Freno: 20 o más verificaciones abiertas en la última hora con menos del 20 % completadas → aviso urgente y verificaciones cerradas 1 hora.
- Marcas: HMAC-SHA256 con una llave de 32 bytes guardada en `system_keys`; vencen a los 2 años; nunca el correo ni la tarjeta en claro.
- Correo normalizado: minúsculas; la parte local pierde todo desde el primer `+`; en `gmail.com` y `googlemail.com` pierde los puntos y el dominio queda `gmail.com`.
- Captcha: obligatorio en producción; fuera de producción solo con las dos claves (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`).
- Textos fijos (se copian tal cual): «El registro no está disponible por ahora» (503) · «No pudimos comprobar el captcha: intenta en un momento» (503) · «Intenta más tarde» (429, topes y freno) · «Activa tu prueba para usar la IA» · «Tu cuenta está en pausa» · «Activa tu prueba gratis de 14 días: agrega tu tarjeta. No se cobra nada hasta el …» con «Agregar tarjeta» · «Falta verificar tu correo» con «Reenviar» · «Ya usaste tu prueba gratis» con «Contratar» · «Ya usaste tu prueba gratis con este correo» · «Esta tarjeta ya tuvo una prueba gratis» con «Usar otra tarjeta» · «Activar sin tarjeta» · «Quitar freno» · «Esperando tarjeta».
- Textos del panel y correos en español de México, de tú.
- Pruebas con `node --test`, una a la vez contra la base (`--test-concurrency=1`); nunca dos corridas con la misma base a la vez. `tsc` no revisa `test/`: revisión de sintaxis con esbuild antes de cada suite.
- Antes de cada commit: `npx tsc -p tsconfig.json --noEmit`, `npm run -s check:frontend` y las pruebas de lo tocado.

Comandos (desde `chatbot-platform/`):
- Una prueba: `REQUIRE_PGVECTOR=true TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test3 node --import tsx --test --test-concurrency=1 test/<archivo>.test.ts`
- Suite (en segundo plano, desde una copia `git worktree` y otra base): `REQUIRE_PGVECTOR=true TEST_DATABASE_URL=…/chatbot_test npm test`
- Sintaxis: `npx esbuild test/*.ts scripts/*.mts scripts/buttons/*.mts scripts/buttons/areas/*.mts --log-level=error --outdir=<scratchpad>/esb --format=esm --platform=node`
- Navegador: `TEST_DATABASE_URL=… node --import <scratchpad>/pw/use-preinstalled-chromium.mjs --import tsx scripts/<script>.mts`

## Review Focus

1. **El webhook de la tarjeta llega dos veces, o antes de que la persona vuelva del pago:** la prueba empieza una sola vez, las marcas se guardan una vez y el aviso «Tu prueba empezó» sale una vez (prueba en la tarea 7).
2. **La persona abandona el pago y vuelve:** dentro de 30 minutos recibe la misma página sin contar para el tope; después se abre otra y sí cuenta (prueba en la tarea 6).
3. **Termina la prueba y el ciclo de vida corre antes que el webhook del primer cobro:** la cuenta no se pausa por «prueba vencida» si su suscripción sigue viva (prueba en la tarea 7).
4. **Cuentas que ya existían antes de la migración:** no cambian de estado, y el correo de su dueño ya no da otra prueba en una cuenta nueva (prueba en la tarea 1).
5. **Una cuenta en pausa recibe un audio por WhatsApp:** el mensaje se guarda, no se transcribe, no hay error ni costo de IA (prueba en la tarea 2).

---

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/097_signup_card.sql` (nuevo) | `pause_reason` con `card`, `accounts.signup_plan`, `system_keys`, `trial_claims`, `card_checks`, marcas de los dueños actuales |
| `src/billing/trial-claims.ts` (nuevo) | Correo normalizado, huella de tarjeta de Mercado Pago, HMAC, buscar y guardar marcas |
| `src/ai/gate.ts` (nuevo) | Puerta de IA para cuentas en pausa e inactivas |
| `src/billing/card-check.ts` (nuevo) | Puertas, topes, sesión vigente y freno de la verificación de tarjeta; inicio de la prueba |
| `src/ai/budget.ts` | `accountAi` llama a la puerta; `AiBudgetBlocked` con `ai_paused` |
| `src/signup-guard.ts`, `src/routes/signup.ts`, `src/routes/google-login.ts`, `src/config-check.ts`, `src/config.ts` | Captcha obligatorio, topes de registro, cuenta esperando tarjeta |
| `src/billing/types.ts`, `src/billing/stripe.ts`, `src/billing/mercadopago.ts`, `src/billing/service.ts`, `src/routes/billing.ts`, `src/lifecycle.ts` | Pago con prueba, fin de prueba y huella en el estado, inicio de la prueba |
| `src/routes/admin.ts` | «Activar sin tarjeta» y «Quitar freno» (superadministrador) |
| `public/js/auth.js`, `shell.js`, `billing.js`, `admin.js`, `session.js`, más los botones de IA | Captcha con Google, avisos, Mi plan, IA deshabilitada con motivo, Cuentas |
| `test/billing-fakes.ts` | Stripe con `default_payment_method` y `trial_end`; Mercado Pago con tarjetas del cliente y cancelar |
| `scripts/test-signup-ux.mts` (nuevo) + `package.json` + CI | Recorrido en navegador del registro |

---

### Task 1: Migración 097 y marcas de prueba

**Files:**
- Create: `migrations/097_signup_card.sql`, `src/billing/trial-claims.ts`, `test/trial-claims.test.ts`
- Modify: `src/types.ts:450` (`pause_reason` con `'card'`), `test/migration.test.ts`

**Interfaces:**
- Produces:
  - `type ClaimKind = 'email' | 'google' | 'card'`
  - `canonicalEmail(email: string): string`
  - `mpCardKey(card: { first_six_digits?: string; last_four_digits?: string; expiration_month?: number; expiration_year?: number; cardholder?: { identification?: { number?: string } } }): string | null` (null si faltan los 6 o los 4 dígitos)
  - `trialAvailable(o: { email: string; googleSub?: string | null }): Promise<boolean>`
  - `cardClaim(cardKey: string): Promise<{ claimed: boolean; disputed: boolean }>`
  - `recordTrialClaims(o: { accountId: string; email: string; googleSub?: string | null; cardKey?: string | null; provider: 'stripe' | 'mercadopago' }, client?: PoolClient): Promise<void>` (`ON CONFLICT DO NOTHING`)

- [ ] **Step 1: Pruebas que fallan** en `test/trial-claims.test.ts`:
  - `canonicalEmail`: `'Ana.Ruiz+prueba@GMail.com'` → `'anaruiz@gmail.com'`; `'a.b+x@googlemail.com'` → `'ab@gmail.com'`; `'Luis+1@empresa.mx'` → `'luis@empresa.mx'`; `'luis.p@empresa.mx'` → `'luis.p@empresa.mx'` (los puntos solo se quitan en Gmail).
  - `mpCardKey` con y sin identificación; sin `last_four_digits` → `null`.
  - Guardar una marca de correo y otra de tarjeta: `trialAvailable` con el mismo correo escrito distinto → `false`; con otro correo → `true`; `cardClaim` → `{ claimed: true, disputed: false }`; guardar dos veces no falla.
  - En la base no aparece el correo ni la huella en claro (`SELECT encode(digest,'hex')` no contiene el texto); la llave existe en `system_keys` con 32 bytes.
  - Una marca con `expires_at` en el pasado no cuenta.
  - Review Focus 4: tras la migración, el correo del dueño de una cuenta existente (insertada antes de migrar en la prueba de migración) ya no tiene prueba disponible, y la cuenta conserva su `status`.
- [ ] **Step 2:** Correr: FALLA (no existe el módulo ni las tablas).
- [ ] **Step 3: Migración** `097_signup_card.sql`: el CHECK `accounts_pause_reason_check` admite `card`; `accounts.signup_plan text NOT NULL DEFAULT ''`; `system_keys (name text PRIMARY KEY, value bytea NOT NULL, created_at timestamptz DEFAULT now())` con `('trial_claims', gen_random_bytes(32))`; `trial_claims (kind text CHECK (kind IN ('email','google','card')), digest bytea, account_id uuid REFERENCES accounts(id) ON DELETE SET NULL, provider text NOT NULL DEFAULT '', disputed boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '2 years', PRIMARY KEY (kind, digest))`; `card_checks (id bigserial, account_id uuid, provider text, ref text, url text, ip_key text, opened_at timestamptz DEFAULT now(), completed_at timestamptz)` con índice por `opened_at`; marcas de correo de los dueños actuales calculadas en SQL con `hmac(canonical, llave, 'sha256')` (pgcrypto), con la misma normalización que `canonicalEmail` (una prueba compara las dos).
- [ ] **Step 4: Implementar** `trial-claims.ts` (la llave se lee una vez de `system_keys` y se guarda en memoria; el valor que se firma es `${kind}:${valor}`).
- [ ] **Step 5:** Correr `test/trial-claims.test.ts` y `test/migration.test.ts`: PASA.
- [ ] **Step 6: Commit** `Etapa 3a: marcas de prueba por correo, Google y tarjeta (migración 097)`.

### Task 2: Ninguna cuenta en pausa usa IA

**Files:**
- Create: `src/ai/gate.ts`, `test/ai-gate.test.ts`
- Modify: `src/ai/budget.ts:21-23,121` (`AiBudgetBlocked` acepta `'ai_paused'` con estado 402 y texto propio; `accountAi` llama a `assertAiAllowed` antes de reservar), `src/agent-quality.ts:147`, `src/service.ts:819` (playground) y `src/routes/chatbots.ts:596` («Probar mensaje»): llaman a `assertAiAllowed` al empezar, porque el motor atrapa `AiBudgetBlocked` y sin esa llamada no habría 402. `ignoreInactive` no cambia (sirve para probar un agente apagado).

**Interfaces:**
- Produces: `assertAiAllowed(accountId: string): Promise<void>` (lanza `new AiBudgetBlocked('ai_paused', texto)`); `aiPausedText(reason: string): string` → `'card'` da «Activa tu prueba para usar la IA», cualquier otro motivo «Tu cuenta está en pausa».

- [ ] **Step 1: Pruebas que fallan** en `test/ai-gate.test.ts`, con una cuenta en pausa por `card` y otra por `payment`:
  - `accountAi(...).complete`, `.transcribe` y `.embed` lanzan `AiBudgetBlocked` con `code === 'ai_paused'` y no llaman al proveedor falso (`h.aiCalls` sin cambio).
  - Rutas: Copiloto, asistente de instrucciones (`prompt-edit`), diseñar flujo con IA, importar conocimiento, prueba del agente, playground y «Probar mensaje» responden 402 con `{ code: 'ai_paused' }` y el texto según el motivo.
  - Review Focus 5: un audio entrante por WhatsApp a la cuenta en pausa se guarda, sin transcripción, sin error en la bitácora y sin llamada a la IA.
  - Guardar conocimiento con la cuenta en pausa guarda el artículo (su embedding queda pendiente).
  - Con la cuenta activa, todo lo anterior sigue funcionando.
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar** la puerta (lee `status`, `pause_reason` y `active` de `accounts`), su llamada en `accountAi` y al empezar en las tres rutas del motor.
- [ ] **Step 4:** Correr `test/ai-gate.test.ts` y las de motor, Copiloto, playground, prompt-edit e importación: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: ninguna cuenta en pausa usa IA`.

### Task 3: Captcha obligatorio y cerrado ante fallas

**Files:**
- Modify: `src/signup-guard.ts:47-74`, `src/routes/signup.ts:106-108`, `src/routes/google-login.ts:128-140`, `src/config-check.ts:595-600,840-850`, `test/signup.test.ts:110-125`, `test/google-login.test.ts`, `test/config-check.test.ts`

**Interfaces:**
- Produces: `captchaRequired(): boolean` (producción siempre; si no, solo con las dos claves); `verifyCaptcha(token: string | undefined, ip: string): Promise<'ok' | 'invalid' | 'unavailable'>`; `assertCaptcha(token: string | undefined, ip: string): Promise<void>` (400 `CAPTCHA_MESSAGE`, 503 con los textos fijos).

- [ ] **Step 1: Pruebas que fallan:**
  - Con `NODE_ENV=production` simulado (`config.env`) y sin claves: `POST /api/signup` y `POST /api/signup/google` → 503 «El registro no está disponible por ahora»; `GET /api/signup/info` dice `signup_available: false`.
  - Con claves y el Turnstile falso caído (500 o sin respuesta): 503 «No pudimos comprobar el captcha: intenta en un momento», una línea en la bitácora, y un solo aviso al superadministrador aunque fallen tres registros en la misma hora.
  - `POST /api/signup/google` sin `turnstile_token` (con captcha activo) → 400 `CAPTCHA_MESSAGE`; con token bueno → 200.
  - Entrar con Google a una cuenta existente no pide captcha.
  - `validateConfig` en producción con `SIGNUP_ENABLED` y sin las claves: un problema `critical` `turnstile.required`; sin ningún proveedor de cobro: advertencia `signup.no_billing` «Registro sin cobro: las pruebas no piden tarjeta».
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar**: el aviso al superadministrador va con `countHit('captcha-down-alert', HOUR) === 1`.
- [ ] **Step 4:** Correr las tres pruebas: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: captcha obligatorio, también con Google, y cerrado si Cloudflare no responde`.

### Task 4: Topes de registro en la base

**Files:**
- Create: `test/signup-limits.test.ts`
- Modify: `src/routes/signup.ts:88`, `src/routes/google-login.ts:130`, `src/config.ts` (`signup.dailyMax: Number(env('SIGNUP_DAILY_MAX', '200'))`)

**Interfaces:**
- Produces: `assertSignupAllowed(ip: string): Promise<void>` en `src/routes/signup.ts` (exportada; la usa también Google). Claves: `signup-ip-h:<ipKey>` (1 h), `signup-ip-d:<ipKey>` (1 día), `signup-day` (1 día).

- [ ] **Step 1: Pruebas que fallan:**
  - Desde una conexión, el 4.º registro en una hora → 429 «Intenta más tarde»; dos IPv6 del mismo /64 cuentan juntas.
  - El 11.º en un día desde una conexión (con las horas avanzadas en `rate_limits`) → 429.
  - Con `SIGNUP_DAILY_MAX = 5`: el 4.º registro del día manda un aviso al superadministrador (80 %), uno solo; el 6.º → 429.
  - El registro con Google comparte los mismos topes.
  - Un registro rechazado por datos inválidos (correo desechable) no cuenta para el tope global.
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar** con `countHit`/`releaseHit` (se devuelve el intento global si el registro no se crea).
- [ ] **Step 4:** Correr `test/signup-limits.test.ts` y `test/signup.test.ts`: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: topes de registro en la base, por conexión y por día`.

### Task 5: La cuenta nueva espera la tarjeta

**Files:**
- Create: `src/billing/card-check.ts` (solo `cardRequired` en esta tarea)
- Modify: `src/routes/signup.ts:37-40,111-150`, `src/routes/google-login.ts` (registro con Google), `src/store/index.ts:59-63` (`createAccount` acepta `pausedAt` y `pauseReason`), `src/config.ts` (`requireEmail` siempre `true` en producción), `test/billing-signup.test.ts`, y las pruebas de cobro que se registran con un proveedor y esperaban `trial`: `billing-autopilot`, `billing-cfdi`, `billing-payments`, `billing-plan-change`, `billing-reliability`, `billing`

**Interfaces:**
- Produces: `cardRequired(): Promise<boolean>` (hay al menos un proveedor activo); `newAccountState(now?)` → con tarjeta requerida `{ status: 'paused', pauseReason: 'card', pausedAt: now, trialEndsAt: null }`.

- [ ] **Step 1: Pruebas que fallan** (en `test/billing-signup.test.ts`):
  - Con Stripe configurado, registrarse (con o sin plan) deja la cuenta `paused` / `card`, con `paused_at`, sin `trial_ends_at`, con `signup_plan` = el plan elegido; la respuesta no trae `checkout_url` y no se llamó a `/v1/checkout/sessions`.
  - Sin proveedores: queda en `trial` con `TRIAL_DAYS`, como hoy.
  - El registro con Google hace lo mismo.
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** Correr todas las `test/billing*.test.ts`. Las que se registraban para probar otra cosa ponen el estado que necesitan con SQL (`status = 'trial'`, `trial_ends_at`) en su función de alta, con un comentario; las que probaban el registro siguen el camino nuevo. PASA.
- [ ] **Step 5: Commit** `Etapa 3a: la cuenta nueva espera la tarjeta (el asistente no responde)`.

### Task 6: La verificación de tarjeta: puertas, topes y sesión vigente

**Files:**
- Create: `test/card-check.test.ts`
- Modify: `src/billing/card-check.ts`, `src/routes/billing.ts:226-241` (sale el `tooMany` en memoria de checkout), `src/billing/service.ts:120-144` (`startCheckout` con `trialDays`), `src/billing/types.ts` (`CreateCheckoutInput.trialDays?: number`), `src/billing/stripe.ts:166-184`, `src/billing/mercadopago.ts:114-129`, `test/billing-fakes.ts`

**Interfaces:**
- Consumes: `trialAvailable` (tarea 1), `cardRequired` (tarea 5).
- Produces:
  - `openCardCheck(o: { accountId: string; ip: string; provider: ProviderName; planKey: string; open: () => Promise<{ url: string; ref: string }> }): Promise<string>`: correo del dueño verificado (si no, 403 «Falta verificar tu correo»), freno, sesión vigente (misma cuenta, proveedor y plan, abierta hace menos de 30 minutos y sin completar: devuelve su `url` sin contar), topes `card-check-acct:<id>` 5/día, `card-check-ip:<ipKey>` 10/día y `card-check-day` 300/día, y guarda la fila en `card_checks`.
  - `CHECK_TTL_MS = 30 * 60_000`.

- [ ] **Step 1: Pruebas que fallan:**
  - Sin el correo verificado → 403 «Falta verificar tu correo»; sin verificación reciente → `step_up` (como hoy).
  - Pago de Stripe con prueba disponible: cuerpo con `subscription_data[trial_period_days]=14`, `payment_method_collection=always`, `expires_at` entre ahora + 30 y + 32 minutos, `payment_method_options[card][request_three_d_secure]=any`, `success_url` con `{CHECKOUT_SESSION_ID}` y sin `allow_promotion_codes`.
  - Sin prueba disponible (marca del correo): sin `trial_period_days`; la respuesta trae `trial: false` para el aviso «Ya usaste tu prueba gratis con este correo».
  - Mercado Pago con prueba: `auto_recurring.start_date` a `TRIAL_DAYS` días; sin prueba: sin `start_date`.
  - Review Focus 2: dos pedidos seguidos devuelven la misma `url` y solo una fila en `card_checks`; con la fila de hace 31 minutos se abre otra y cuenta.
  - El 6.º del día en una cuenta, el 11.º desde una conexión y el 301.º del día → 429 «Intenta más tarde».
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar.** El falso de Stripe guarda el cuerpo como ya lo hace; el de Mercado Pago igual.
- [ ] **Step 4:** Correr `test/card-check.test.ts` y `test/billing*.test.ts`: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: la verificación de tarjeta pide el correo verificado, con topes y sesión de 30 minutos`.

### Task 7: La prueba empieza al confirmar la tarjeta

**Files:**
- Create: `test/trial-start.test.ts`
- Modify: `src/billing/types.ts:45-54` (`SubscriptionState.trialEnd: Date | null`, `SubscriptionState.cardKey: string | null`; `PaymentProvider.endTrialNow(subscriptionId: string): Promise<void>`), `src/billing/stripe.ts:118-140,186-193,258-270` (`trialing` con `trial_end`; la suscripción se lee con `expand[]=default_payment_method` y `cardKey = card.fingerprint`), `src/billing/mercadopago.ts:27-40,131-168` (`authorized` con `start_date` futura → `trialEnd`; `cardKey` con `GET /v1/customers/{payer_id}/cards/{card_id}` y `mpCardKey`), `src/billing/service.ts:390-410`, `src/billing/card-check.ts`, `src/lifecycle.ts:67`, `test/billing-fakes.ts`

**Interfaces:**
- Consumes: `cardClaim`, `recordTrialClaims` (tarea 1); `card_checks` (tarea 6).
- Produces: `startTrialFromState(accountId: string, state: SubscriptionState, client: PoolClient): Promise<'trial' | 'card_used' | 'none'>`, llamada desde `applyStateLocked` cuando `state.status === 'active'` y `state.trialEnd > now`.

- [ ] **Step 1: Pruebas que fallan:**
  - Stripe: `checkout.session.completed` de una suscripción `trialing` con `trial_end` y tarjeta `fp_nueva` → cuenta `trial`, `trial_ends_at` = `trial_end`, marcas de correo y tarjeta guardadas, `card_checks.completed_at` puesto, aviso «Tu prueba gratis empezó» con la fecha.
  - Review Focus 1: el mismo webhook dos veces, y «Ya pagué» antes del webhook, dejan una sola prueba, una marca de cada tipo y un solo aviso.
  - Tarjeta `fp_usada` ya marcada → se llama `POST /v1/subscriptions/{id}` con `trial_end=now`, la cuenta no entra en prueba y el dueño ve «Esta tarjeta ya tuvo una prueba gratis»; con el `invoice.paid` siguiente queda `active`.
  - Mercado Pago `authorized` con `start_date` futura → prueba con esa fecha; tarjeta repetida → se cancela la suscripción (`PUT /preapproval/{id}` con `status: 'cancelled'`) y la cuenta sigue esperando tarjeta.
  - Review Focus 3: con `trial_ends_at` vencido y la suscripción viva, `checkTrials` no pausa la cuenta; sin suscripción, sí (como hoy).
  - Una cuenta con prueba vieja sin tarjeta (`trial` de antes) sigue funcionando como hoy al pagar (pasa a `active`).
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar.** La prueba se arranca dentro del mismo `withTransaction` de `applyStateLocked`; los avisos van en `later`.
- [ ] **Step 4:** Correr `test/trial-start.test.ts` y `test/billing*.test.ts`: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: la prueba empieza al confirmar la tarjeta, una por tarjeta`.

### Task 8: Freno contra prueba de tarjetas

**Files:**
- Modify: `src/billing/card-check.ts`, `src/routes/admin.ts` (`DELETE /api/billing/card-check-brake`, solo superadministrador), `test/card-check.test.ts`

**Interfaces:**
- Produces: `brakeOn(): Promise<boolean>`; `clearBrake(actor: User): Promise<void>`. El freno es la clave `card-check-brake` en `rate_limits` con ventana de 1 hora; se evalúa al abrir cada verificación.

- [ ] **Step 1: Pruebas que fallan:** con 20 filas en `card_checks` de la última hora y 3 completadas, la siguiente apertura → 429 «Intenta más tarde», un aviso urgente al superadministrador (uno solo aunque sigan los intentos) y bitácora; con 20 y 4 completadas (20 %) no frena; con el freno puesto, `DELETE /api/billing/card-check-brake` del superadministrador lo quita (un administrador recibe 403).
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** Correr `test/card-check.test.ts`: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: freno automático si se abren muchas verificaciones y casi ninguna termina`.

### Task 9: «Activar sin tarjeta» y lo que ve el panel

**Files:**
- Modify: `src/routes/admin.ts` (`POST /api/accounts/:id/trial-without-card`, superadministrador con `stepUp`), `src/routes/billing.ts:165-182` (`GET /api/billing` agrega `card_check`), `src/store/index.ts` (`publicAccount` incluye `pause_reason`), `test/card-check.test.ts`, `test/identity-step-up.test.ts` (la ruta nueva en `STEP_UP`)

**Interfaces:**
- Produces: `GET /api/billing` → `card_check: { required: boolean; waiting: boolean; trial_available: boolean; email_verified: boolean; signup_plan: string; brake: boolean }`.

- [ ] **Step 1: Pruebas que fallan:** «Activar sin tarjeta» deja la cuenta `trial` con `TRIAL_DAYS`, la bitácora dice quién fue, y para un administrador → 403; sin verificación reciente → `step_up`. `GET /api/billing` de una cuenta esperando tarjeta trae `card_check` con los valores de cada caso (correo sin verificar, sin prueba disponible, freno puesto).
- [ ] **Step 2:** Correr: FALLA.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** Correr: PASA.
- [ ] **Step 5: Commit** `Etapa 3a: «Activar sin tarjeta» y el estado de la verificación en Mi plan`.

### Task 10: Panel

**Files:**
- Modify: `public/js/auth.js` (captcha en «Registro con Google»; el registro ya no salta a `checkout_url`), `public/js/shell.js:244-265` (avisos de los tres casos), `public/js/billing.js` (Mi plan: el paso y el plan del registro elegido; «Usar otra tarjeta»), `public/js/session.js` (`aiPaused(): string | ''` con el motivo), los botones de IA (Copiloto, asistente de instrucciones, prueba del agente, playground, flujo con IA, importar) deshabilitados con `title` y texto del motivo, `public/js/admin.js` (Cuentas: «Esperando tarjeta», «Activar sin tarjeta» con confirmación, «Quitar freno»)

- [ ] **Step 1:** Implementar con los textos fijos de Global Constraints.
- [ ] **Step 2:** `npm run -s check:frontend`: sin errores.
- [ ] **Step 3: Commit** `Etapa 3a: el panel del registro con tarjeta`.

### Task 11: Recorrido en navegador y auditoría de botones

**Files:**
- Create: `scripts/test-signup-ux.mts`
- Modify: `package.json` (`test:signup:ux`), `.github/workflows/ci.yml` (el paso junto a `test:account:ux`), `scripts/buttons/areas/*.mts` y `scripts/buttons/sin-presionar.json` (controles nuevos), `scripts/test-billing-ux.mts` (el registro ya no abre el pago)

- [ ] **Step 1:** Escribir el recorrido: registrarse con captcha falso → verificar el correo → configurar 2FA → panel en preparación (aviso, IA deshabilitada) → «Agregar tarjeta» → completar en el Stripe falso → «Periodo de prueba: quedan 14 días»; el mismo correo con `+etiqueta` en otra cuenta ve «Ya usaste tu prueba gratis»; el superadministrador ve «Esperando tarjeta» y usa «Activar sin tarjeta». Revisa axe en computadora y teléfono.
- [ ] **Step 2:** Correrlo: PASA. Correr `test:billing:ux`: PASA.
- [ ] **Step 3:** `npm run test:buttons`: cada control nuevo presionado en un área o anotado con su motivo; PASA.
- [ ] **Step 4: Commit** `Etapa 3a: recorrido en navegador del registro y auditoría de botones`.

### Task 12: Documentación

**Files:**
- Modify: `docs/seguridad.md` (fila de la etapa 3: «3a ✅»; sección «Etapa 3a: lo que se corrigió» con PAY-2, PAY-3 y la parte de PAY-6; «Cambios que nota la gente»), `docs/produccion.md` (Turnstile obligatorio, `SIGNUP_DAILY_MAX`, reglas de Radar recomendadas, quitar el freno), `README.md` (registro y prueba con tarjeta), la página `/privacidad` (`src/routes/self-service.ts:183`: las marcas no reversibles por 2 años), la spec (decisiones 1, 2 y 6 de este plan, en «3a.9 Lo que cambió al implementar»)

- [ ] **Step 1:** Escribir. **Step 2:** `npm run -s check:frontend` y `test/owner-self-service.test.ts` (revisa las páginas públicas): PASA. **Step 3: Commit** `Etapa 3a: documentación`.

### Task 13: Verificación final y PR

- [ ] **Step 1:** Suite completa en una copia `git worktree` (base `chatbot_test`), los recorridos en navegador (`test:ux`, `test:billing:ux`, `test:public:ux`, `test:identity:ux`, `test:account:ux`, `test:signup:ux` y los otros cuatro) y `test:buttons`, cada uno en su base.
- [ ] **Step 2:** Revisión independiente de toda la rama; corregir lo importante, cada cosa con su prueba.
- [ ] **Step 3:** `tsc`, `check:frontend`, `shellcheck -S warning` y `scripts/test-cli.sh`.
- [ ] **Step 4:** Push; el PR #93 deja de ser borrador, con su descripción al día (qué cambia, qué nota la gente, revisión y verificación).
