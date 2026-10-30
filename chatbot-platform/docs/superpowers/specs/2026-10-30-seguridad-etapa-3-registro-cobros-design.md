# Seguridad, etapa 3: registro y cobros — diseño

**Fecha:** 30 de octubre de 2026 · **Base:** `main` en `31a3e1f` (etapas 1, 2a y 2b ya mezcladas) · **Hallazgos:**
PAY-2…PAY-16 de [`docs/seguridad.md`](../../seguridad.md). PAY-14 (cualquier administrador maneja el cobro y los datos
fiscales) ya quedó cerrado en la 2b con los poderes del dueño. De PAY-6 entra aquí la parte de las cuentas en pausa;
la del cupo de IA sigue en la etapa 4.

Se entrega en dos PR, cada uno con pruebas que fallan con el código anterior:

- **3a · Registro:** captcha → correo → 2FA → tarjeta → prueba, captcha obligatorio, panel en preparación sin IA,
  verificación de tarjeta de $0, límites en la base con freno contra prueba de tarjetas, una prueba por persona.
- **3b · Cobros:** disputas, el plan sale del precio, códigos de promoción y portal propios, mensual ↔ anual,
  reactivaciones y plan del superadministrador, CFDI en la moneda del cobro, Mercado Pago (autorizada no es pagada y
  su firma), errores del proveedor, precios públicos y cobros a clientes.

Las secciones 3a.1–3a.8 y 3b.1 se presentaron y aprobaron en la conversación. **Las secciones 3b.2–3b.10 son nuevas en
este documento**: se escribieron con las decisiones de abajo y se revisan aquí.

## Lo que cambia para la gente

- Registrarse pide el captcha también con Google, verificar el correo y configurar la app de verificación, como hoy.
  Después la cuenta queda **esperando tarjeta**: se puede preparar el agente, los canales y los ajustes, pero el
  asistente no responde ni envía nada y la IA del panel (Copiloto, asistente de instrucciones, pruebas del agente) está
  apagada.
- La prueba gratis de 14 días empieza al **agregar una tarjeta** (no se cobra nada hasta que termina). Hay una prueba por
  persona: el mismo correo (aunque cambie un `+etiqueta` o los puntos de Gmail), la misma cuenta de Google o la misma
  tarjeta ya no dan otra.
- Elegir un plan al registrarse ya no abre el pago en el acto: el plan queda recordado y se ofrece al agregar la tarjeta.
- Un cliente que desconoce un cargo pausa la cuenta y detiene los cobros hasta que la disputa se resuelve.
- Los códigos de promoción se escriben en Riverrun (Mi plan) y solo sirven los que el superadministrador creó para eso.
- Un agente ya no cambia el monto ni el enlace de pago de un cobro a cliente; un administrador sí, y queda en la
  bitácora con el antes y el después.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Entrega | Dos PR: 3a registro y 3b cobros, con esta sola spec. |
| Proveedores | Stripe y Mercado Pago en el lanzamiento: los dos se endurecen igual. |
| Prueba gratis | **Con tarjeta obligatoria** (verificación de $0), una por correo normalizado, por cuenta de Google y por tarjeta; límites completos del plan. |
| Captcha | Obligatorio y **cerrado ante fallas**: sin claves no abre el registro público en producción; si Cloudflare no responde, «intenta en un momento». |
| Antes de la tarjeta | Panel en preparación: el asistente no responde y la IA está apagada (la misma revisión aplica a toda cuenta en pausa). |
| Disputas | Pausa automática y alto a los cobros; ganada reactiva; perdida queda en pausa hasta pagar con otra tarjeta; la alerta temprana de fraude de Stripe reembolsa y cancela. |
| Códigos de promoción | Solo los que Riverrun marca (metadata `riverrun=1`) y válidos para ese plan. |
| Cobros a clientes | El agente crea y edita concepto, fecha y recordatorios; monto, moneda y enlace solo los cambia un administrador, con bitácora del antes y el después. |

## PR 3a · Registro

### 3a.1 El orden: captcha → correo → 2FA → tarjeta → prueba (PAY-2)

Cada paso es una puerta revisada en el servidor; no se puede saltar al siguiente.

1. **Formulario o Google, con captcha** (3a.2). La cuenta se crea con `status = 'paused'`, `pause_reason = 'card'` y
   sin `trial_ends_at`. Si eligió un plan, se guarda en `accounts.signup_plan` (solo para ofrecerlo después).
2. **Verificar el correo.** Obligatorio en producción (`SIGNUP_REQUIRE_EMAIL` ya no se puede apagar ahí). Google cuenta
   como verificado solo si Google lo marca verificado.
3. **Configurar la verificación en dos pasos.** Ya es así desde la 2a: sin ella no hay sesión.
4. **Panel en preparación** (3a.3).
5. **Verificación de tarjeta** (3a.4): `POST /api/billing/card-check`, solo el dueño, con el correo verificado y la
   verificación reciente (como el resto de Mi plan). Abre una
   sesión de pago del proveedor y devuelve su URL.
6. **Empieza la prueba** cuando el proveedor confirma la tarjeta (webhook o «Ya pagué», siempre releyendo al proveedor):
   la cuenta pasa a `trial` y `trial_ends_at` toma el fin de prueba que dice el proveedor. Las marcas de prueba (3a.6)
   se guardan en ese momento.

`POST /api/signup` y el registro con Google ya no abren el pago ni devuelven `checkout_url`.

### 3a.2 Captcha obligatorio y cerrado ante fallas

- `captchaRequired()`: en producción siempre. Sin `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY`, `config:check` da
  error y las rutas de registro responden 503 «El registro no está disponible por ahora». Fuera de producción, sin
  claves no se pide (desarrollo y pruebas, que usan un Turnstile falso cuando lo prueban).
- Si Cloudflare no responde o responde con error: 503 «No pudimos comprobar el captcha: intenta en un momento», una
  línea en la bitácora y, a lo más una vez por hora, un aviso al superadministrador.
- **Google:** el inicio de sesión con Google desde la pantalla de registro manda el token del captcha; el servidor lo
  revisa **antes** de ir a Google y lo anota en la cookie de estado firmada. Al volver, el pase de registro
  (`cp_gpass`) solo se emite si ese inicio pasó el captcha. Entrar con Google a una cuenta que ya existe no pide captcha.
- El campo trampa y los correos desechables siguen como están.

### 3a.3 Esperando tarjeta: panel en preparación y sin IA (PAY-2, parte de PAY-6)

- Con `pause_reason = 'card'` la cuenta es una cuenta en pausa más: el asistente no responde ni envía (la revisión de
  `account_active` que ya existe).
- **Una sola puerta para la IA:** `assertAiAllowed(accountId)` en `src/ai/gate.ts`. Una cuenta en pausa (por cualquier
  motivo: tarjeta, prueba vencida, pago, disputa, a mano) o inactiva no usa IA: responde 402 con `code: 'ai_paused'` y
  un texto según el motivo («Activa tu prueba para usar la IA», «Tu cuenta está en pausa»).
- La revisión vive en el envoltorio de llamadas de IA de la cuenta (`ai/budget.ts`) y, para dar el error antes y cubrir
  lo que no pase por él, en cada entrada: Copiloto, asistente de instrucciones, pruebas del agente, playground y «Probar
  mensaje», transcripción de audio y lectura de imágenes de mensajes entrantes (se guarda el mensaje y no se transcribe),
  flujos con IA e importar conocimiento. Las pruebas del agente y el playground dejan de saltarse la revisión con
  `ignoreInactive`.
- Una prueba recorre la lista completa de rutas con IA y comprueba que cada una pasa por la puerta (como la lista de
  verificación reciente de la 2a).

### 3a.4 La verificación de tarjeta ($0)

- **Stripe:** Checkout en modo suscripción con `subscription_data.trial_period_days` (`TRIAL_DAYS`, 14), `payment_method_collection:
  'always'`, `expires_at` a 30 minutos, `payment_method_options.card.request_three_d_secure: 'any'` (3D Secure cuando
  el banco lo tiene), `success_url` con `{CHECKOUT_SESSION_ID}` y sin `allow_promotion_codes` (los códigos van en 3b.3).
  Al completar se lee la tarjeta: `subscription.default_payment_method` → `card.fingerprint`.
- **Mercado Pago:** suscripción (`preapproval`) con el primer cobro al terminar la prueba (`start_date` a `TRIAL_DAYS`). Al
  quedar `authorized` se lee la tarjeta (`card_id` del preapproval y la tarjeta guardada del cliente: primeros 6,
  últimos 4, vencimiento y, si viene, la identificación del titular) para su huella (3a.6). Si en el sandbox Mercado
  Pago exige otra forma para validar la tarjeta sin cobrar, se ajusta en el plan sin cambiar el resto de este diseño.
- Una sesión abierta por cuenta: si hay una vigente se devuelve la misma; si venció se abre otra (cuenta para el tope).
- **Sin prueba disponible** (el correo, la cuenta de Google o la tarjeta ya tuvieron una): la verificación es el primer
  cobro del plan, sin días gratis. Si la tarjeta repetida se descubre al completar: en Stripe la prueba termina al
  momento (`trial_end = now`, se cobra); en Mercado Pago se cancela esa suscripción y se abre el pago sin prueba. El
  dueño ve «Esta tarjeta ya tuvo una prueba gratis» con «Usar otra tarjeta».

### 3a.5 Límites en la base y freno contra prueba de tarjetas (PAY-2)

Con `countHit` (tabla `rate_limits` de la 2a) y la IP agrupada por /64 con `ipKey`:

| Qué | Tope |
|---|---|
| Registros por conexión (formulario y Google) | 3 por hora y 10 por día |
| Registros en toda la plataforma | `SIGNUP_DAILY_MAX` por día (200 por omisión); al 80 % aviso al superadministrador, al 100 % «Intenta más tarde» |
| Verificaciones de tarjeta por cuenta | 5 por día |
| Verificaciones de tarjeta por conexión | 10 por día |
| Verificaciones de tarjeta en toda la plataforma | 300 por día |

- **Freno:** cada verificación abierta queda en `card_checks` (cuenta, proveedor, referencia, abierta, completada). Si
  en la última hora se abrieron 20 o más y se completaron menos del 20 %, se avisa con urgencia al superadministrador y
  se cierran las verificaciones nuevas una hora («Intenta más tarde»). El freno se puede quitar a mano desde Cuentas.
- **Radar (Stripe):** además del 3D Secure, `docs/produccion.md` lista las reglas recomendadas del tablero (bloquear si
  falla el CVC, si el riesgo es alto o si la tarjeta es de prepago en una prueba), porque se configuran en Stripe.

### 3a.6 Una prueba por persona (PAY-3)

- Tabla `trial_claims`: `kind` (`email`, `google`, `card`), `digest` (HMAC-SHA256), `account_id` (nulo si se borra la
  cuenta), `provider`, `disputed`, `created_at`, `expires_at` (2 años). Único por `(kind, digest)`.
- **Correo normalizado:** minúsculas; la parte local pierde todo desde el primer `+`; en `gmail.com` y `googlemail.com`
  pierde los puntos y el dominio queda `gmail.com`. Solo sirve para las marcas: el correo de la cuenta no cambia.
- **Tarjeta:** Stripe da `card.fingerprint`; para Mercado Pago la huella sale de primeros 6, últimos 4, vencimiento e
  identificación del titular (si viene). La de Mercado Pago es más débil y se documenta así.
- La llave del HMAC son 32 bytes aleatorios que se crean al migrar y viven en la base (`system_keys`), no en `.env`:
  rotar `SESSION_SECRET` no borra las marcas. Nunca se guarda el correo ni la tarjeta en claro.
- **Al registrarse** se buscan las marcas del correo y de Google; **al completar la tarjeta**, la de la tarjeta. Las
  marcas se escriben al empezar la prueba. Borrar la cuenta no borra las marcas; el aviso de privacidad lo dice.
- La migración guarda las marcas de correo de los usuarios dueños que ya existen (las cuentas de prueba de hoy no dan
  otra prueba).

### 3a.7 Panel

- **Registro:** el captcha siempre en el formulario y antes del botón de Google.
- **Aviso arriba** mientras espera tarjeta: «Activa tu prueba gratis de 14 días: agrega tu tarjeta. No se cobra nada
  hasta el …» con «Agregar tarjeta». Sin el correo verificado: «Falta verificar tu correo» con «Reenviar». Sin prueba
  disponible: «Ya usaste tu prueba gratis» con «Contratar».
- **Mi plan** muestra el paso en el que va y el plan elegido al registrarse.
- Los botones de IA, con la cuenta en pausa, se ven deshabilitados con el motivo en lugar de fallar.
- **Cuentas (superadministrador):** estado «Esperando tarjeta», y «Activar sin tarjeta» (confirmación y bitácora) para
  excepciones reales: demostraciones o un cliente cuya tarjeta no pasa. «Quitar freno» cuando el freno está puesto.

### 3a.8 Datos (migración 097)

- `accounts.pause_reason` admite `card`; `accounts.signup_plan text NOT NULL DEFAULT ''`.
- `trial_claims` y `system_keys` (con la llave del HMAC); marcas de correo de los dueños actuales.
- `card_checks` para el freno.
- Las cuentas que ya existen no cambian de estado (la plataforma no se ha lanzado).

## PR 3b · Cobros

### 3b.1 Disputas (PAY-4, PAY-5)

- **Manda el estado del proveedor:** en cada evento de disputa se relee la disputa (Stripe `GET /v1/disputes/{id}`;
  Mercado Pago el pago y su contracargo) y se guarda ese estado; un evento viejo que llega tarde ya no reabre una
  disputa ganada o perdida.
- **Al abrirse** (disputa de Stripe o contracargo/mediación de Mercado Pago): se detienen los cobros (Stripe:
  `pause_collection` de la suscripción; Mercado Pago: suscripción en pausa), la cuenta queda en pausa con motivo
  `dispute`, aviso urgente al superadministrador y aviso claro al dueño.
- **Ganada:** se reanudan los cobros y la cuenta se reactiva si la pausa era por la disputa.
- **Perdida:** se cancela la suscripción y la cuenta queda en pausa hasta que el dueño pague **con otra tarjeta**; la
  marca de esa tarjeta (3a.6) queda `disputed` y ya no reactiva ni da prueba.
- **Alerta temprana de fraude de Stripe** (`radar.early_fraud_warning.created`): se reembolsa ese cargo y se cancela la
  suscripción antes de que llegue la disputa; queda como perdida (en pausa hasta otra tarjeta), con bitácora.
- Eventos nuevos: `radar.early_fraud_warning.created`, `charge.dispute.funds_withdrawn` y
  `charge.dispute.funds_reinstated` en Stripe; el tema de contracargos en Mercado Pago.

### 3b.2 El plan sale del precio (PAY-7)

- **Stripe:** el plan se toma del precio de la suscripción: su `stripe_price_id` o el producto `riverrun_<plan>` que crea
  Riverrun, y el monto y el periodo del precio deben ser los del plan. La metadata ya no decide. Si el precio no
  corresponde a ningún plan o su monto no cuadra, no se cambia el plan, se avisa al superadministrador y queda en la
  bitácora.
- **Mercado Pago:** el plan de `external_reference` solo vale si `transaction_amount`, moneda y frecuencia son los del
  plan; si no, lo mismo que arriba.

### 3b.3 Códigos de promoción y portal propios (PAY-2, PAY-7)

- El pago de Stripe ya no acepta cualquier código (`allow_promotion_codes` sale). En Mi plan hay un campo «Código de
  promoción»: el servidor busca el código en Stripe (`promotion_codes?code=…&active=true`) y solo lo acepta si tiene
  `metadata.riverrun = '1'` y, si su metadata `riverrun_plans` lista planes, el plan elegido está en ella. Va a Checkout
  como `discounts: [{ promotion_code }]`. Un código que no sirve responde «Ese código no es válido para este plan».
- Mercado Pago no tiene códigos: el campo no aparece con Mercado Pago.
- **Portal de Stripe:** Riverrun crea (una vez) su propia configuración del portal y la usa siempre: cambiar la tarjeta,
  ver facturas y cancelar al final del periodo; **sin** cambiar de plan desde el portal (los cambios de plan pasan por
  Riverrun, con sus reglas).

### 3b.4 Mensual ↔ anual (PAY-11)

- Pasar de mensual a anual es subir: se cobra al momento con prorrateo.
- Pasar de anual a mensual se programa para el final del periodo anual (el plan programado de PAY-1), sin reembolso.
- Entre planes del mismo periodo sigue la regla de hoy (comparar el precio mensual equivalente).

### 3b.5 Reactivaciones y plan del superadministrador (PAY-8)

- La pausa a mano del superadministrador guarda `pause_reason = 'manual'`. Un pago, una reconciliación o un webhook
  nunca la quitan: solo el superadministrador.
- El plan que asigna el superadministrador guarda `accounts.plan_source = 'manual'`; la reconciliación y los webhooks ya
  no lo pisan (si la suscripción dice otro plan, se avisa al superadministrador). Cuando el dueño cambia de plan desde
  Mi plan, vuelve a `provider`.

### 3b.6 CFDI en la moneda del cobro (PAY-9)

- La factura va en la moneda del pago. Para un pago que no es en pesos se manda `currency` y el tipo de cambio: el del
  movimiento de saldo de Stripe (`balance_transaction.exchange_rate`) cuando existe; si no hay tipo de cambio confiable,
  la factura queda «pendiente: tipo de cambio» para el superadministrador en lugar de salir en pesos.
- El IVA de cada línea es el del pago (`tax_percent`); la factura global agrupa por moneda y tasa.

### 3b.7 Mercado Pago: autorizada no es pagada, y su firma (PAY-10, PAY-15)

- Una suscripción `authorized` durante la verificación de tarjeta solo prueba la tarjeta (empieza la prueba, 3a.4).
  Fuera de eso, la cuenta se activa por un **pago aprobado** del periodo, no por `authorized`.
- **Firma:** el id que se procesa es el firmado (`data.id` del query); si el cuerpo trae otro id, 400. El tipo de evento
  no viene firmado: se relee el recurso por su id y se actúa según lo que es. `x-request-id` es obligatorio. Tolerancia
  del `ts`: 5 minutos (era 1 hora), como Stripe.

### 3b.8 Errores del proveedor (PAY-12) y precios públicos (PAY-16)

- Al cliente, un texto fijo por acción («No pudimos abrir el pago. Intenta otra vez; si sigue, escribe a soporte con la
  referencia R-…») con una referencia corta. El texto del proveedor queda solo en la bitácora del sistema (la del
  superadministrador), no en la de la cuenta ni en avisos o correos.
- Los planes que ven el público y los administradores llevan solo lo que el panel usa (clave, nombre, precio, moneda,
  periodo, límites y descripción): sin `stripe_price_id` ni otros ids del proveedor. Solo el superadministrador los ve.

### 3b.9 Cobros a clientes (PAY-13)

- `PUT /api/receivables/:id` y `PUT /api/receivable-plans/:id`: un agente no cambia `amount_cents`, `currency` ni
  `payment_link` (403 «Solo un administrador cambia el monto o el enlace de pago»); concepto, fecha, referencia y
  recordatorios sí.
- Cada cambio de monto, moneda o enlace queda en la bitácora con el antes y el después y quién lo hizo; crear un cobro
  registra también el dominio del enlace.
- El Copiloto sigue la misma regla: `editar_cobro` con monto o enlace solo para administradores (además de su
  confirmación de la etapa 1).

### 3b.10 Datos (migración 098)

- `accounts.pause_reason` admite `manual`; `accounts.plan_source text NOT NULL DEFAULT 'provider'`.
- `billing_payments`: estado de la disputa releído del proveedor y cuándo; `trial_claims.disputed`.
- La configuración del portal de Stripe en `system_keys`.

## Pruebas

Cada puerta y cada hallazgo con una prueba que se ve fallar antes; nada que no pruebe algo de esta lista.

- **3a:** sin captcha y con Cloudflare caído (503); Google sin captcha no da pase de registro; verificación de tarjeta
  antes del correo verificado o sin 2FA; cada tope y el freno; la sesión de pago con `expires_at`, 3D Secure, sin
  códigos y reutilizada; la prueba empieza solo al confirmar la tarjeta (con el fin de prueba del proveedor); correo
  normalizado, cuenta de Google o tarjeta repetidos sin prueba; HMAC y llave en la base; la puerta de IA en todas las
  rutas de la lista; «Activar sin tarjeta». En navegador, `test:signup:ux` recorre el camino completo con axe en
  computadora y teléfono; la auditoría de botones cubre los controles nuevos.
- **3b:** cada transición de disputa y eventos fuera de orden; cobros detenidos y reanudados; alerta de fraude; reactivar
  solo con otra tarjeta; plan por precio y montos que no cuadran; códigos marcados y no marcados; configuración del
  portal; mensual ↔ anual; pausa a mano y plan manual que no se pisan; CFDI en otra moneda con y sin tipo de cambio; MP
  autorizada sin pago, id del cuerpo distinto al firmado, `ts` viejo; textos del proveedor que no llegan al cliente;
  planes sin ids; agente sin permiso para monto y enlace, con bitácora.
- Contra proveedores falsos (Stripe, Mercado Pago, Facturapi y Turnstile), como las pruebas de cobro de hoy.
- Arreglo previo: `test/limits.test.ts` espera también el correo del aviso al 100 % (una carrera: el aviso se guarda
  antes de mandar el correo).

## Riesgos

- **Mercado Pago:** cómo valida la tarjeta sin cobrar y qué datos de la tarjeta entrega se confirma en el sandbox al
  implementar; la huella derivada es más débil que la de Stripe.
- **3D Secure y tarjeta obligatoria** suben la fricción del registro: es lo que se eligió; «Activar sin tarjeta» cubre
  las excepciones.
- **El freno** puede cerrar verificaciones legítimas una hora si alguien lo provoca; cuesta captcha, correo y 2FA por
  intento, y el superadministrador lo quita a mano.
- **Marcas de prueba compartidas** (una familia con una tarjeta): «Usar otra tarjeta» o «Activar sin tarjeta».
- **Tipo de cambio del CFDI:** sin uno confiable la factura espera al superadministrador en lugar de salir mal.

## Fuera de esta etapa

- El cupo de IA (gastar IA por encima del plan): etapa 4 con el resto de PAY-6.
- Configurar las reglas de Radar en el tablero de Stripe (operación; quedan documentadas).
- Cobros a clientes por la API v1: no tiene ruta para editar monto ni enlace, no cambia.
