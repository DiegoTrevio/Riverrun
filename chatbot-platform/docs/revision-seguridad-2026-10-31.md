# Revisión de seguridad del 31 de octubre de 2026

**Base revisada:** `main` en 567d6a6 (después de la etapa 3a). Cinco revisores de solo lectura, cada uno en un área:
identidad y permisos, superficie pública y webhooks, cobros, IA y Copiloto, archivos, panel e infraestructura. Se les dio
la lista de [`seguridad.md`](seguridad.md) para buscar **solo lo nuevo** o lo que las etapas «corregidas» dejaron abierto.

**Resultado:** ningún crítico; 7 altos, 17 medios y unos 30 bajos nuevos. Los altos se comprobaron en el código, y los dos
de caída del proceso además se midieron. La numeración sigue la de `seguridad.md` (ID-11 en adelante, etc.).

**Lo que no se hizo:** no se corrió la suite ni la app (no hay PostgreSQL en este entorno); las mediciones son con las
expresiones y bibliotecas reales, fuera de la app. Dependencias: `npm audit --omit=dev` da 3 moderadas (`glob` y `minimatch`
por `@fastify/static`, sin entrada del usuario); los 8 altos son de `promptfoo` (solo desarrollo). En el historial de git
no hay secretos reales (las claves que aparecen son de `test/config-check.test.ts`).

## Altos

**Estado:** los siete, corregidos en la etapa 3c (ver [`seguridad.md`](seguridad.md#etapa-3c-lo-que-se-corrigió)).

| # | Hallazgo | Escenario | Arreglo | Comprobado |
|---|---|---|---|---|
| IN-15 | **ReDoS en la verificación de hechos.** `URL_RE` y `EMAIL_RE` (`src/engine/text.ts:110-111`) son cuadráticas; `FactCorpus` se arma con el texto del cliente en cada decisión de IA, aunque `verify_facts` esté apagado (`src/engine/validator.ts:655-657`). Ningún mensaje entrante tiene tope de largo: `handleIncoming` (`src/service.ts:521`), y en correo `stripQuoted(m.text)` no pasa por `MAX_MAIL_TEXT` (`src/channels/email.ts:242`). | Cualquiera, sin cuenta, manda por WhatsApp una línea `a.a.a.…` de 65 000 caracteres: **17 s por pasada de `extractFacts`** (medido), al menos dos por turno. El proceso (HTTP, webhooks y trabajos, `PROCESS_ROLE=all`) se congela para todas las cuentas, y otra vez en cada turno mientras el mensaje siga en el historial. Por correo (hasta 10 MB) son horas. Es la misma clase que IN-1, en otra función. | Truncar el texto entrante (≈8 000 caracteres) en `handleIncoming` y `toInbound` (también lo que devuelve `stripQuoted`); cuantificadores acotados (`{1,64}`, `{0,63}`) en `URL_RE`, `EMAIL_RE` y `MONEY_RE`; prueba con 1 MB hostil < 100 ms, como `html-to-text.unit.test.ts`. | Medido |
| IN-16 | **Una plantilla DOCX tumba el proceso.** El guardia de `openZip` suma los tamaños que **declara** el ZIP (`src/quotes/template.ts:72-75`); PizZip infla todo y solo después compara. Un DOCX honesto con 29 MB de XML y miles de marcas pasa los topes y Docxtemplater agota la memoria. `new PizZip()` lee todo el directorio central antes del tope de 300 entradas. | Un administrador de cualquier cuenta (también una de prueba) sube a `POST /api/quote-templates` un DOCX de **199 KB que declara 400 B y se infla a 200 MB** (medido: pasa el guardia, 0.7 s). Con el máximo de 5 MB son varios GB: el proceso muere por memoria o lo reinicia el watchdog. Repetible, sin tope de ritmo. | Leer el directorio central e inflar cada parte con `zlib.inflateRawSync(raw, { maxOutputLength })` antes de PizZip (el patrón ya está bien en `src/engine/media-understanding.ts:43`); tope de marcas y de XML real; tope de ritmo por cuenta; idealmente, inspeccionar en un worker con `resourceLimits`. | Medido |
| ID-14 | **Rutas laterales que se saltan la verificación reciente y el dueño para sacar datos.** Crear un webhook (`/api/webhook-endpoints`) o descargar la cuenta (`export.zip`) piden el código, pero: las reglas de automatización con acción `webhook` a cualquier URL, `send_report` a correos externos o `send_conversation` se guardan solo con rol admin (`src/routes/automation.ts:183-197`, `src/automation/types.ts:239`), y los CSV de contactos, conversaciones, cotizaciones y **mensajes completos** también (`src/routes/export.ts:32, 69, 96, 122`). | Con la cookie robada de un administrador, sin código reciente: una regla `message_received → webhook https://atacante` manda cada mensaje con nombre, teléfono y datos del cliente, para siempre; o se baja `messages.csv` con todas las conversaciones. Un administrador que no es dueño hace lo mismo. | `stepUp` en los 4 CSV (o `ownerStepUp`); en reglas y flujos, `assertRecentMfa` cuando la regla lleve `webhook`, `send_report` externo, `send_conversation` o `alert_team.phones`; agregar todo a `STEP_UP` de `identity-step-up.test.ts`. | Leído |
| ID-12 | **Bajar de rol a un administrador no revoca sus llaves, webhooks ni invitaciones** (ID-5 incompleto). Solo se llama `offboard` al desactivar o mover de cuenta (`src/routes/admin.ts:510-516`), y la llave de API no mira el rol ni el estado de quien la creó (`src/routes/api-v1.ts:167`). | El dueño baja a una administradora a agente; su llave `write` sigue leyendo todos los contactos y mensajes, enviando como el negocio y marcando cobros pagados, y sus webhooks siguen recibiendo los mensajes. | `offboard` cuando el rol baja de admin; además, en api-v1 hacer JOIN con `users` y exigir creador activo con rol admin. Prueba en `offboarding.test.ts`. | Leído |
| ID-13 | **Cualquier administrador programa el borrado masivo de datos.** `PUT /api/settings` (solo `admins`, `src/routes/automation.ts:150`) acepta `retention.messages_days` e `inactive_contacts_days` desde 1 día (`src/automation/types.ts:59-64`); se aplica cada 6 h. La bitácora no guarda los valores. Igual `DELETE /api/channels/:id` (cascada a contactos y conversaciones). | Un administrador que no es dueño, o una cookie robada sin código reciente, pone 1 día: en menos de 6 h se borran mensajes, contactos inactivos y sus archivos, sin vuelta atrás. Borrar la cuenta exige dueño, código y 7 días de gracia; esto no. | Cambiar `retention` (y borrar un canal con conversaciones) pide dueño y verificación reciente; mínimo 30 días; el cambio entra con 7 días de demora y aviso al dueño; valores en la bitácora. | Leído |
| ID-11 | **El agente ve y opera los cobros de todos los clientes.** Las rutas de cobros usan `requireRole('agent')` con solo `assertAccount` (`src/routes/receivables.ts:148-303`); `createReceivable` solo comprueba que el contacto sea de la cuenta. El comentario de la línea 3 dice que es a propósito, pero contradice la regla de `access.ts` (el agente solo ve lo asignado). | Un agente con una conversación asignada lista todos los cobros (nombre, teléfono, monto, enlace); crea un cobro con **su propio enlace de pago** a un cliente de otro y le manda el recordatorio: desvío de pagos (lo mismo que AI-2 cerró para el Copiloto). También marca pagados o cancela cobros ajenos. | **Decisión del dueño.** Recomendado: para el agente, filtrar por `contactAssignedTo` y usar `contactFor` en `owned`, `ownedPlan`, `POST` y `/api/contacts/:id/receivables`; el enlace de pago, solo admin. | Leído |
| AI-5 (agravado) | **El nombre del contacto en la página abierta no marca el turno del Copiloto como contaminado.** `describePage` mete `name`/`push_name` (lo escribe el cliente) en el prompt de sistema (`src/copilot/page.ts:57-75`) y `ctx.tainted` solo lo ponen las lecturas de herramientas (`src/copilot/runner.ts:94-106`). | Un visitante del chat web pone como nombre una instrucción; el administrador abre esa ficha y pide cualquier cosa: el turno cuenta como limpio y el Copiloto puede cambiar reglas del asistente, conocimiento, instrucciones o precios **sin tarjeta**. `seguridad.md` lo tiene como medio y sin este efecto. | `ctx.tainted = true` cuando la página es de contacto, conversación o cobros; el nombre, marcado como texto de cliente; lo mismo en los títulos de acciones con nombres. | Leído (probable que el modelo obedezca) |

## Medios

| # | Hallazgo | Arreglo |
|---|---|---|
| PAY-17 | La prueba gratis empieza aunque no haya huella de tarjeta (`src/billing/card-check.ts:165-171`): Checkout no fija `payment_method_types` (`src/billing/stripe.ts:172`), así que Link u otros métodos no traen `card.fingerprint`; en Mercado Pago la lectura de la tarjeta lleva `.catch(() => null)`. Con alias de correo de un dominio propio, N pruebas. `trial-start.test.ts` solo prueba con huella. | `payment_method_types: ['card']`; sin huella, tratar como tarjeta ya usada (o reintentar la lectura antes de empezar la prueba). |
| PAY-18 | El portal de Stripe y «cambiar tarjeta» (`src/routes/billing.ts:270-311`) quedan fuera de los topes y del freno de PAY-2: solo un contador en memoria de 30 por hora. Una cuenta con una prueba válida prueba tarjetas robadas sin sumar a `card_checks`. | Contar cada sesión de portal con `countHit` (cuenta, conexión, plataforma) y registrarla en `card_checks`, o cambiar la tarjeta con Checkout en modo `setup` por `openCardCheck`. |
| ID-15 | Los códigos TOTP se cuentan **después** de comprobarlos (`src/routes/mfa.ts:31-37, 61-65`); `/api/2fa/step-up` no tiene tope por sesión. Mil peticiones simultáneas pasan la revisión antes del décimo fallo: ≈10 % por día de acertar, frente a «10 intentos por hora». | Contar antes de verificar (como la contraseña): `countHit`, rechazar si pasa el máximo, `releaseHit` si el código es bueno. |
| ID-16 | El primer enrolamiento de 2FA (todas las cuentas al desplegar la 2a, y tras «Restablecer 2FA») se hace solo con la contraseña; restablecer la contraseña por correo no quita una app ajena. Quien tenga una contraseña filtrada enrola su app primero. | El primer enrolamiento de una cuenta existente, o tras un reinicio, pide un enlace al correo de la cuenta; restablecer por correo quita la app si no estaba confirmada por correo. |
| ID-17 | Al dar de baja a alguien, su Google u Outlook conectado sigue recibiendo las citas asignadas (`src/integrations/staff-calendars.ts:137-158`), también si pasó a otra cuenta. | En `offboardUser`: `disconnectStaff` y desasignar las citas futuras. |
| PAY-19 | Límites del plan con carrera: `assertWithinLimit` cuenta y luego se inserta (`src/billing/limits.ts:145-157`). 20 `POST /api/chatbots` o `/api/channels` a la vez pasan todos. | `SELECT … FROM accounts WHERE id = $1 FOR UPDATE` (o `pg_advisory_xact_lock`) en la misma transacción que el conteo y el alta. |
| PAY-20 | No hay tope de gasto de IA que el cliente no pueda cambiar: los topes son `null` por omisión, cualquier administrador los cambia y «confirma» un costo dudoso con 0 USD (`src/routes/ai-budget.ts:28-47`). Es el fondo de PAY-6. | Tope de plataforma por plan, solo del superadmin, aplicado en `reserve`; `review` solo del superadmin o con piso igual a lo reservado. |
| PAY-21 | `runPlans` toma `LIMIT 2000` planes de **todas** las cuentas ordenados por antigüedad (`src/receivables/plans.ts:92-94`): pasando 2 000 (una cuenta con la API lo logra en ~35 min), los pagos recurrentes nuevos de todos dejan de generarse. | Lotes con `FOR UPDATE SKIP LOCKED` por próximo vencimiento; tope de planes activos por cuenta. |
| PAY-22 | CFDI: un pago que llega después de emitida la global del mes queda sin factura para siempre (`src/billing/cfdi.ts:130-148`, índice único de `073_cfdi.sql`). | Emitirlo en la global del mes en curso (o individual a público en general) y alertar si un pago lleva N días sin CFDI. |
| IN-17 | El correo entrante no verifica al remitente (sin SPF, DKIM ni DMARC; `src/channels/email.ts:114-122`). Con `From: cliente@real.com` se escribe en el historial de ese cliente («cancelen mi cita») y el bot responde a la dirección suplantada. | Exigir `dkim=pass`/`dmarc=pass` alineado en `Authentication-Results`; si no, solo guardar (`captureOnly`) y marcar «remitente no verificado». Tope global de respuestas por canal. |
| IN-18 | Reserva pública (`src/routes/booking.ts:205-229`): sin captcha ni confirmación del correo; el tope de 3 por correo se salta con `+etiqueta`; límite en memoria con la IP cruda. Sirve de relé de correo desde el SMTP de la plataforma (el mismo de los restablecimientos), llena la agenda y crea cobros de anticipo falsos. Amplía el IN-8…14 «reservas como relé». | Turnstile y confirmación por enlace antes de avisar; correo normalizado; topes en la base con `ipKey`; tope diario por enlace. |
| IN-19 | Sin cuota de almacenamiento ni tope de ritmo en subidas (adjuntos, biblioteca, plantillas); una cuenta en pausa también sube. Un registro gratis llena el disco que comparte PostgreSQL. | `storage_mb` por plan o prueba, tope de ritmo y de cantidad por cuenta. |
| IN-20 | La CSP estricta del panel se salta con `GET /%69ndex.html`: la regex `PANEL` se prueba contra `req.url` sin decodificar y `@fastify/static` sí decodifica (`src/security-headers.ts:15, 44`); el panel sale con `'unsafe-inline'`. Hoy no hay una inyección que encadenar, pero es la capa que se cita contra XSS. | Invertir: CSP estricta por omisión e `inline` solo para la lista de páginas del servidor, decidiendo sobre la ruta decodificada; `check-frontend` que vigile `html:`. |
| IN-21 | La revisión del DOCX solo mira `TargetMode="External"` en `.rels` (`src/quotes/template.ts:84-92`): pasan `INCLUDEPICTURE`, `INCLUDETEXT`, `LINK` y DDE en códigos de campo, que LibreOffice (dentro del backend, con los secretos) puede seguir a la red interna o a archivos locales. No probado con LibreOffice. | Rechazar esos códigos y atributos; de fondo, la conversión aislada de IN-6/7 (`network_mode: none`, sin secretos). |
| IN-22 | Chat web: el tope de 300 clientes nuevos por hora y canal se agota con ~10 conexiones (el cierre que AI-4 quería evitar se movió al primer mensaje); `GET /webchat/:token/messages` no tiene límite; la sesión viaja en la URL (`src/routes/public.ts:281, 299-306`). | Tope por /24 o /64 y captcha al superar un umbral; límite en el GET; sesión en cabecera. |
| AI-14 | `crear_regla` y `cambiar_regla` del Copiloto no siguen la cadena de etiquetas (`src/copilot/tools/automatizacion.ts:99-106`), a diferencia de `etiquetar`: «etiqueta como promo a quien escriba» se crea sin tarjeta y dispara una regla existente de envío masivo. | En `ruleRisk`, por cada `add_tag`/`set_field`, revisar `outwardRules` y subir a confirmar. |
| PAY-23 | Zernio: una sola cubeta para toda la plataforma; un negocio en bucle retrasa ~10 s cada envío de los demás y provoca pausas de 15 s por 429 (`src/channels/zernio-budget.ts:55-80`). | Tope por cuenta antes de tomar ficha y una parte reservada para las respuestas del bot. |

## Bajos

- **Identidad:**
  - Planes, `PUT /api/accounts/:id`, precios de IA y dominios de marca del superadmin sin verificación reciente.
  - El agente recibe campos de más (lista negra): `secret` de Telegram y `verify_token` de Meta en `GET /api/chatbots/:id`, y `limits_override`, `owner_user_id`… en `/api/me`. Conviene una lista blanca.
  - `stepUpHook` y `ownerHook` no rechazan las peticiones del Copiloto (`x-copilot-action`). Hoy lo impide solo la lista de herramientas.
  - El enlace de borrar la cuenta sirve varias veces en 24 h y no se anula al cancelar ni al transferir (lo encontraron dos revisores).
  - Enumeración de correos en el registro (409 y tiempo), al invitar y al cambiar el correo.
  - El `id_token` de Google no valida `iss` ni `aud`.
  - Un login fallido guarda el campo `email` crudo en la bitácora.
- **Topes:**
  - La mayoría de los `rateLimited` están en memoria y con la IP cruda. Pasar `ipKey` dentro de `rateLimited()` los corrige todos de una vez; moverlos a la base ya está en la etapa 4.
  - Los topes de diseño con IA e importación están en memoria.
- **Entradas:**
  - El parser JSON propio (`src/app.ts:119`) pierde la protección `__proto__` de Fastify. No se encontró dónde explotarlo.
  - El captcha de `/contacto` falla abierto.
  - Zernio y Mercado Pago deduplican con datos sin firmar.
  - Los archivos de clientes se descargan con la extensión que declaró el cliente (`.pdf.html`, `.lnk`) y sin quitar los caracteres bidi.
  - Los adjuntos de Office se aceptan solo con la firma ZIP.
- **Cobros:**
  - `/precios` dice «sin tarjeta» y la prueba ya la exige.
  - El freno de verificaciones se diluye con eventos `active`.
  - Un deudor pausa sus recordatorios cada 2 días sin límite.
  - Un estado viejo de Stripe puede pisar uno nuevo.
  - Una cotización aceptada dos veces a la vez deja cobros huérfanos.
  - `cfdi_invoices.amount_cents` es `integer`.
  - No hay planes privados.
- **IA:**
  - Los topes de costo del Copiloto quedan en 0 sin `cost_usd` (proveedor distinto de OpenRouter).
  - Importar una URL con `save` guarda texto oculto de la página.
  - Las respuestas automáticas en redes publican texto influido por comentarios.
- **Datos e infraestructura:**
  - El ZIP «Descargar mis datos» incluye `calendar_token` y `webhook_secret` (`src/accounts/self-service.ts:151`).
  - `HTTP_LOG=true` registra URLs con tokens.
  - Las claves de ejemplo (`cambia-esta-clave`) solo dan aviso en producción.
  - El instalador usa `curl https://get.docker.com | sh`.

## Plan propuesto

**Etapa 3c, antes del lanzamiento (un PR, lo más grave y barato):**
1. IN-15 y IN-16: las dos caídas del proceso, que cualquier cliente final (IN-15) o cualquier cuenta de prueba (IN-16) provoca. Se arreglan con topes, cuantificadores acotados y la inflación acotada que ya existe en `media-understanding.ts`. Cada una con su prueba hostil.
2. ID-14, ID-12 e ID-13: aplicar la verificación reciente y el dueño a las rutas laterales, revocar al bajar de rol y proteger la retención. Ampliar `identity-step-up.test.ts` con una prueba que recorra **todas** las rutas que sacan o borran datos.
3. ID-11: según lo que decida el dueño.
4. AI-5: marcar contaminada la página de contacto (una línea en `runner.ts` más su prueba). Lo demás de AI-5 sigue en la etapa 5.

**El resto, en las etapas que ya existen:**

| Etapa | Agregar |
|---|---|
| 3b (cobros) | PAY-17…PAY-23 y los bajos de cobros. PAY-17 y PAY-18 van primero: son la misma familia que PAY-2 y PAY-3. |
| 2c (identidad, nueva y corta) | ID-15, ID-16, ID-17 y los bajos de identidad. |
| 4 (entradas) | IN-17…IN-22 y `ipKey` dentro de `rateLimited()`. Conviene subir la etapa 4 por delante de la 5: junto con IN-2 e IN-3 concentra la superficie de abuso sin sesión. |
| 5 (IA) | AI-14 y los bajos de IA. |
| 6 (secretos y datos) | Los secretos en el ZIP, `HTTP_LOG` e IN-21 junto con IN-6/7. |
| 9 y 10 | Claves de ejemplo como error en producción y quitar `curl \| sh`. |
