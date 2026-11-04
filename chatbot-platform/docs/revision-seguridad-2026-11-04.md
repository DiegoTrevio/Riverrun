# Revisión de seguridad del 4 de noviembre de 2026 (independiente)

**Base revisada:** `main` en 9a9f14d (después del PR #124). Seis revisores de solo lectura, cada uno en un área: identidad
y permisos; superficie pública, webhooks y entradas; cobros; IA y Copiloto; servidor, secretos y CI; navegador (panel,
páginas públicas y widget). Se les dio [`seguridad.md`](seguridad.md) y [la revisión del 31 de
octubre](revision-seguridad-2026-10-31.md) para buscar **solo lo nuevo**, regresiones o arreglos incompletos. Cada medio
se volvió a comprobar en el código; el de las plantillas DOCX, además, reproduciéndolo con `inspectTemplate` real.

**Resultado:** ningún crítico; ningún alto con la configuración del instalador (uno sube a alto con un proveedor de IA
distinto de OpenRouter); 7 medios o medio-bajos y unos 20 bajos. **Ninguna regresión**: ID-1…ID-17, IN-1…IN-22,
PAY-1…PAY-23, AI-1…AI-14 e INF-1…INF-15 siguen corregidos en el código. La numeración sigue la de `seguridad.md`.

## Herramientas automáticas

| Qué | Resultado |
|---|---|
| Tipos (`tsc --noEmit`) | Sin errores. |
| Dependencias de producción (`npm audit --omit=dev`) | 3 moderadas: `glob` y `minimatch` por `@fastify/static` (solo se usan al registrar la carpeta `public/`, sin entrada del usuario). Las mismas que en la revisión anterior. |
| Dependencias de desarrollo | 8 altas, todas por `promptfoo` (evaluaciones; no entra a la imagen). |
| Secretos en el historial (gitleaks 8.21.2, la versión fijada en el CI, con `.gitleaks.toml`) | **Ningún secreto real.** 4 coincidencias: el `SESSION_SECRET` de prueba del CI (`0123456789…`) en `.github/workflows/ci.yml` de los commits 5482deba, c54b9486, 91ff79f0 y 22027671, que `.gitleaksignore` no cubre (solo cubre c31c4578). La primera búsqueda semanal del historial completo (lunes) va a salir en rojo (INF-20). |
| Suite (`npm test`, PostgreSQL 16 local sin pgvector) | Ver [Pruebas](#pruebas). |

## Cómo funciona hoy la seguridad (resumen para el dueño)

- **Entrar al panel.** Contraseña de 12 caracteres o más, fuera de las filtradas; verificación en dos pasos obligatoria
  para todos (app de autenticación, sin SMS); límites de intentos guardados en la base (por conexión, por persona y por
  reto). La sesión es una cookie `HttpOnly`, `SameSite=Strict` (y `__Host-` con HTTPS) registrada en la base: cerrar
  sesión, cambiar la contraseña o dar de baja a alguien la corta al momento. Caduca a las 12 h sin uso (30 min el
  superadmin) y a los 7 días como máximo.
- **Quién ve qué.** El agente solo ve lo que tiene asignado; el administrador, todo su negocio; el dueño es el único que
  toca dinero, a otros administradores, la retención y el borrado; lo de otra cuenta responde 404. Lo delicado (llaves,
  webhooks, descargas, roles, plan, borrar) pide el código otra vez si pasaron 15 minutos, y el Copiloto nunca llega ahí.
- **Llaves de la API.** Se guardan como huella (SHA-256), son de lectura o de escritura, y valen lo que su creador: si
  deja de ser administrador activo, dejan de servir.
- **Lo que llega de afuera.** Cada webhook se comprueba con la firma de su proveedor (Meta, Stripe, Mercado Pago,
  Zernio) o con un secreto (Telegram); WhatsApp solo se acepta desde la red interna. Los cuerpos tienen tope, y los
  mensajes se cortan a 8 000 caracteres. Cuando el sistema abre una dirección que puso alguien (webhooks salientes,
  importar una página, adjuntos, correo propio), resuelve el nombre al conectar y rechaza IP privadas, locales o de la
  nube, también en cada redirección.
- **Archivos.** El tipo se decide por los bytes, no por la extensión; no se aceptan HTML, SVG, ejecutables ni Office con
  macros; se sirven con `nosniff` y la mayoría como descarga. Las plantillas Word se revisan con topes reales antes de
  convertirlas en un contenedor sin internet y sin secretos.
- **El navegador.** El panel nunca escribe HTML con texto de clientes (todo va como texto), y la CSP estricta solo deja
  correr el código del propio servidor (más el captcha). Ninguna página se puede meter en un iframe ajeno salvo la de
  reservas y la ayuda. Lo que cambia algo y viene de otro sitio se rechaza.
- **Cobros.** Un aviso de pago nunca se cree tal cual: el sistema le pregunta al proveedor el estado real. El plan sale
  del precio cobrado. Una prueba gratis por persona (correo, Google y tarjeta), frenos contra prueba de tarjetas robadas,
  disputas que pausan y cobros a clientes cuyo enlace de pago solo pone un administrador.
- **La IA.** El asistente responde con un formulario estricto que el sistema verifica: precios, horarios, enlaces y
  afirmaciones deben estar en la información del negocio; lo que no, se quita. Un detector impide que repita sus
  instrucciones. El Copiloto usa las mismas rutas del panel con los permisos de la persona; después de leer texto de
  clientes, los cambios de configuración piden confirmación con una tarjeta que muestra todo. Cada llamada reserva su
  costo antes de salir y hay topes por cuenta, por plan y por pedido.
- **El servidor.** Solo Caddy publica 80 y 443; PostgreSQL y Redis viven en una red interna sin internet; la app y
  Evolution entran a la base con roles propios sin superusuario. Los secretos de canales, Google, Outlook y el 2FA van
  cifrados (AES-256-GCM) con `DATA_KEY`, que se rota sin desconectar nada. Respaldos diarios cifrados y verificados
  restaurándolos. `./riverrun harden` pone firewall (también delante de Docker), SSH con llave, fail2ban y parches
  automáticos; `./riverrun update` solo despliega un commit con el CI en verde y vuelve atrás si algo falla.
- **Detección.** Bitácora de seguridad aparte (un año), avisos al superadmin por listas de contraseñas, fuerza bruta,
  descargas o borrados fuera de lo normal, y bloqueo automático de la IP que prueba listas de contraseñas.

## Medios

| # | Hallazgo | Escenario | Arreglo | Comprobado |
|---|---|---|---|---|
| PAY-24 | **Las tarifas que pone la cuenta cuentan para el tope de IA de la plataforma** (PAY-20 incompleto). `price()` usa primero `policy.prices` de `ai_budget_settings` (`src/ai/budget.ts:35-37`), que cualquier administrador cambia en `PUT /api/ai-budget` (`src/routes/ai-budget.ts:28`); con ese precio se reserva contra el tope del plan o de la prueba (`:85-102`) y se liquida cuando el proveedor no informa el costo (`:120`). | Un administrador guarda su modelo con tarifa 0.000001 (o `is_free: true`). Con un proveedor que no devuelve `usage.cost` (`OPENAI_BASE_URL` distinto de OpenRouter) cada llamada cuenta ≈0 y el tope del plan y `TRIAL_AI_USD` dejan de cortar: **alto** en esa configuración. Con OpenRouter (el instalador) manda el costo informado y solo se subestima la reserva de la llamada en curso. | El tope de la plataforma y `price_unknown` usan solo `ai_prices`; las tarifas del cliente sirven para sus topes propios y nunca por debajo de las de la plataforma. | Leído |
| AI-15 | **No hay tope de respuestas de IA por contacto en WhatsApp, Telegram, Instagram y Messenger.** Cada mensaje entrante (después de juntar los que llegan seguidos) dispara una decisión de IA con hasta 2 intentos, el juez de afirmaciones y, si trae audio, foto o PDF, transcripción o lectura (`src/service.ts:521`, `src/engine/engine.ts:252`). El único freno por contacto es `repeatedCustomerText`, que se salta cambiando una palabra; los topes de AI-4 son solo del chat web. | Quien conozca el número del negocio manda un mensaje, foto o audio distinto cada pocos segundos: agota el presupuesto del mes de la cuenta (o el del plan) y la IA se detiene para todos sus clientes reales (`budget_exhausted`); desde el 80 % también se pausa el Copiloto. | Ventana por contacto (p. ej. 30 turnos de IA y 10 lecturas de medios por hora); pasado eso, sin IA: callar o pasar a una persona, con un solo aviso al equipo. | Leído |
| ID-18 | **Registrarse con el correo de otra persona deja una app de 2FA que restablecer la contraseña no quita** (ID-16 incompleto). El registro cuenta siempre como correo comprobado (`EMAIL_PROVEN` incluye `'signup'`, `src/identity/mfa.ts:32,93`), aunque en producción el correo queda sin verificar (`src/routes/signup.ts:165,193`); la app se guarda con `totp_email_confirmed = true` (`src/routes/mfa.ts:90`) y `/api/reset-password` solo quita las que no lo tienen (`src/routes/signup.ts:245`). | Alguien se registra con `victima@x.com` y configura su app. La víctima no puede registrarse; si usa «Olvidé mi contraseña», pone su contraseña pero el código sigue siendo el del otro: no entra hasta que el superadmin le restablezca el 2FA. (Quien se registró tampoco puede hacer mucho: sin el correo verificado no agrega tarjeta ni invita.) | `'signup'` cuenta como comprobado solo si el correo ya está verificado; si no, la app se guarda con `totp_email_confirmed = false` y el restablecimiento por correo la quita. | Leído |
| PAY-25 | **La huella de la tarjeta de Mercado Pago incluye el número de documento del titular**, que escribe el comprador (`src/billing/trial-claims.ts:25-34`). | La misma tarjeta con otro número de documento y otro correo (un dominio propio da los que quiera) da otra prueba gratis cada vez (14 días y `TRIAL_AI_USD`). Depende de que Mercado Pago no valide el documento (en México suele ser opcional). | Armar la marca solo con primeros 6, últimos 4 y vencimiento (acepta algún falso positivo), o con la huella si la API la trae. | Leído (probable) |
| IN-23 | **El filtro de contenido externo de las plantillas DOCX se salta** (IN-21 incompleto en los `.rels`). `src/quotes/template.ts:91-92` corta cada `<Relationship>` con `[^>]*>` y busca `TargetMode="External"` y `/hyperlink"` en todo el trozo. Reproducido con `inspectTemplate` (el caso normal sí se rechaza): **(1)** un `>` dentro de un atributo (`Foo=">"`, válido en XML) corta el trozo antes de `TargetMode`; **(2)** cualquier atributo que termine en `/hyperlink"` (`Z="/hyperlink"`) lo hace pasar por hipervínculo; **(3)** con comillas simples (`TargetMode='External'`) no se reconoce. | Un administrador sube un formato con una imagen vinculada a `http://169.254.169.254/…` o a un archivo local. Con Docker (Gotenberg en una red interna sin internet ni secretos) el daño es casi nulo. Con `QUOTE_PDF_BACKEND=soffice` (lo de por omisión fuera de Docker: `src/config.ts:77`), LibreOffice dentro del backend la sigue: SSRF ciega o una imagen local dentro del PDF. | Leer cada `Relationship` con sus atributos entre comillas dobles o simples (como ya hace `externalFields`) y rechazar todo `TargetMode` externo cuyo atributo `Type` no termine exactamente en `/hyperlink`. Agregar los tres casos a `quotes-template.unit.test.ts`. | **Reproducido** |
| AI-16 | **El tope diario del Copiloto se pasa con hilos en paralelo.** `POST /api/copilot/threads/:id/messages` lee los turnos y el gasto del día, decide y después inserta, sin candado (`src/copilot/routes.ts:177-191`); `startTurn` solo impide dos pedidos a la vez en el mismo hilo, y un turno en curso cuenta ≈0 hasta que termina. | Una persona del panel abre 20 hilos y manda un pedido en cada uno a la vez: todos pasan con `maxUsd` ≈ 3 y cada uno gasta hasta `turnMaxUsd` (0.5). Con 30 por hora, unos USD 15 contra los USD 3 del día, y se multiplica por cada persona de la cuenta. Lo frena el presupuesto del mes o del plan, si lo hay. | Reservar `turnMaxUsd` por cada turno `running` en `recentTurns`, y contar e insertar bajo un candado por cuenta; tope de turnos simultáneos por cuenta. | Leído |
| INF-16 | **Contenedores sin endurecer.** Solo `pdf` lleva `no-new-privileges` (`docker-compose.yml:315`); ningún servicio tiene `cap_drop`, `read_only` ni `tmpfs`, y solo el backend corre sin root (`USER node`). | Una ejecución de código en Evolution (procesa mensajes de desconocidos y tiene internet) o en Caddy corre con las capacidades de Docker por omisión, lo que facilita escalar a la máquina. | `security_opt: ["no-new-privileges:true"]` y `cap_drop: [ALL]` en todos, con `cap_add` solo lo necesario (Caddy: `NET_BIND_SERVICE`); `read_only` con `tmpfs` en backend, Caddy y Redis; probar en staging. | Leído |

## Bajos

| # | Hallazgo | Arreglo |
|---|---|---|
| ID-19 | `POST /api/conversations/:cid/report/send` manda la transcripción completa a correos o teléfonos externos sin verificación reciente (`src/routes/conversations.ts:287-296`); el resto de las salidas de datos (CSV, reglas con webhook o destinos externos) sí lo pide (ID-14). | `assertRecentMfa(req)` cuando hay `emails` o `phones`. |
| ID-20 | Una llave de API de **solo lectura** gasta IA y escribe: `GET /api/v1/conversations/:id/export?refresh=true` llama a `service.summarize` (`src/routes/api-v1.ts:450-453`). | Ignorar `refresh` si la llave no es de escritura. |
| ID-21 | El tope de invitaciones a un correo (`invite-email:<correo>`, 3 por día) es de toda la plataforma (`src/routes/invitations.ts:108`): una cuenta de prueba agota el cupo de un correo ajeno y otro negocio no puede invitar a esa persona durante 24 h. | Incluir la cuenta en la clave, o contar solo las que salen. |
| PAY-26 | El límite de redes sociales (`social_accounts`) se revisa sin candado: `src/routes/social.ts:90`, `src/channels/zernio-connect.ts:212,235`, `src/channels/zernio-accounts.ts:73` (los canales ya usan `assertWithinLimitLocked`). Altas simultáneas pasan el límite. | La variante con candado dentro de la transacción del alta. |
| PAY-27 | Bajar de plan se revisa solo al pedirlo: un cambio programado (anual → mensual en Stripe) entra meses después sin volver a revisar, y la revisión no incluye `storage_mb` ni `messages_per_month`. | Revisar otra vez al aplicar el plan programado (y avisar si no cabe). |
| PAY-28 | Subir el precio de un plan hace que cada aviso de los suscriptores viejos dispare una alerta urgente de «precio sin plan» (`planFromPrice`, `planFromPreapproval`): no pierde dinero, pero ahoga las alertas reales. | Comparar con el monto contratado de esa suscripción. |
| PAY-29 | El filtro de texto del agente en cobros (`assertAgentText`, `src/routes/receivables.ts:189`) usa `\d`: dígitos de ancho completo («０１２…») pasan. Lo frena la aprobación del administrador antes de que salga el recordatorio. | Normalizar con NFKC antes de revisar. |
| AI-17 | La corrección del validador vuelve al modelo como mensaje `system` y cita valores que el modelo copió del cliente (`src/engine/context.ts:648-651`). Solo afecta a la propia conversación y la salida se vuelve a validar. | Mandarla como `user`, con los valores entre comillas y recortados, o sin citarlos. |
| AI-18 | En las respuestas públicas en redes, el nombre del autor solo pierde `<>"` (`src/social/replies.ts:134`): conserva saltos de línea y no tiene largo máximo. Lo frenan la revisión de respuestas públicas y el sentimiento positivo. | Colapsar espacios y cortar a 80 caracteres, como `inert`. |
| AI-19 | La marca de «turno contaminado» del Copiloto dura 6 turnos (`src/copilot/store.ts:167`, `FULL_TURNS`), pero el texto de turnos más viejos que citaron a un cliente puede seguir en el historial; los turnos que solo proponen una tarjeta no marcan `tainted`. | Que la marca dure mientras haya un turno contaminado en lo que `buildHistory` aún manda. |
| AI-20 | Una cuenta activa sin plan, sin prueba y sin tope propio no tiene tope de IA (`platformAiCap` devuelve `null`; `PLAN_DEFAULT_AI_USD` solo aplica con plan). | Aplicar `PLAN_DEFAULT_AI_USD` también sin plan, y avisar al superadmin de cuentas activas sin tope. |
| IN-24 | `scripts/check-frontend.mjs` no ve `innerHTML +=`, `{'html': …}`, lo que va después de un `//` dentro de un texto (`'https://…'`), `setHTMLUnsafe`, `createContextualFragment`, `DOMParser` ni `srcdoc`, y solo revisa `public/js/*.js` (no `widget.js`, `reservar.js`, `api-docs.js`). Hoy no hay ningún caso real: es la red de quien programa. | Cubrir esos casos (o una regla de ESLint) y todo `public/`. |
| IN-25 | El enlace «Confirmar pago» (`payment_action_url`, `public/js/shell.js:248`) va a un `href` sin revisar el esquema. Lo pone el proveedor de pagos, no un usuario, y la CSP bloquearía un `javascript:`. | Exigir `https://` al guardarlo y al pintarlo. |
| IN-26 | El `verify_token` de Meta por canal se compara con `===` (`src/channels/meta.ts:226`); el de la plataforma usa `safeEqual`. Hace falta conocer el token de la URL. | `safeEqual`. |
| IN-27 | `src/routes/pools.ts:97` arma la página con `${title}` y `${body}` sin escapar. Hoy los tres usos son texto fijo. | `esc()` por si se agrega uno con datos. |
| INF-17 | Las imágenes base van por etiqueta (`node:22-alpine`, `redis:7-alpine`, `caddy:2-alpine`, `pgvector/pgvector:0.8.7-pg16`, `postgres:16-alpine`, el `COPY --from=redis:7-alpine` del respaldo); solo Evolution y Gotenberg van por digest. Es a propósito para que `update --pull` traiga parches (INF-3), pero `seguridad.md` dice «fijadas por SHA y digest», y una etiqueta movida en Docker Hub llega sin pasar por el CI. `npm ci` de la imagen corre los scripts de instalación. | Digests que Dependabot actualice (ya vigila Docker), o corregir el texto; `npm ci --ignore-scripts` si ninguna dependencia lo necesita. |
| INF-18 | AES-256-GCM sin datos asociados (`src/secret.ts:44-52`): un valor cifrado se puede copiar a otra fila o campo y se descifra igual (requiere escritura en la base). La derivación es SHA-256 con etiqueta, sin HKDF; aceptable con llaves de 256 bits. | `setAAD('tabla:campo:id')` en un formato `v3`, con `rekey-secrets`. |
| INF-19 | `REDIS_PASSWORD` vacío arranca Redis sin `requirepass` sin ningún aviso (`docker-compose.yml:45`). Mitigado: `install` y `update` la generan y Redis está en la red interna. | Aviso en `preflight` y `config-check`. |
| INF-20 | gitleaks: el allowlist es por ruta (`test/`, `evals/`, `scripts/test-*`, `scripts/eval-*`): una llave real en esas carpetas, o en un archivo que se llame `scripts/test-…`, no se detecta. Y las 4 coincidencias del `SESSION_SECRET` de prueba de otros commits harán fallar la búsqueda semanal del historial. | Agregar sus 4 huellas a `.gitleaksignore` (o una regla `regexes` para ese valor exacto) y pasar del allowlist por ruta a uno por patrón (`sk_live_prod…`, `humo-…`, `prueba…`). |
| INF-21 | `update` confía en GitHub: verifica que el commit pasó el CI, pero quien pueda escribir en `main` despliega lo que quiera en todos los servidores (a menudo como root). La firma (`UPDATE_ALLOWED_SIGNERS`) existe pero viene apagada. | Protección de rama y 2FA obligatorio en GitHub; `preflight` avisa sin firma; documentar cómo activarla. |

## Informativo y ya documentado

- `/reservar/:token` lleva `frame-ancestors *` y `'unsafe-inline'` (a propósito, para incrustarla): un sitio ajeno podría
  superponerla, pero reservar pide captcha y confirmar el correo. Opcional: lista de dominios que la pueden incrustar.
- `allowed_origins` del chat web solo impide que otro sitio lea las respuestas en un navegador; con el token del canal,
  `curl` sin `Origin` funciona. La protección real son los topes y la sesión firmada: no presentarlo como control de acceso.
- Algunos topes viven en la memoria de cada proceso (consultas del chat web, `recent`, `limitedFor` en `auth.ts`): con
  varias réplicas se multiplican. Los de entrar, registrarse, reservar y clientes nuevos del chat web van a la base.
- Las firmas de Zernio, Meta y Telegram no llevan marca de hora (los proveedores no la mandan); se deduplica por id.
- Ya estaban en «Queda para después» de `seguridad.md` y siguen igual: la imagen del backend trae LibreOffice; el correo
  de un hosting que no agrega su `Authentication-Results`; el detector de fuga solo ve copias literales; la cadena de
  reglas del Copiloto se corta a 3 saltos.

## Lo que se revisó y está bien

- **Aislamiento entre cuentas:** unos 120 handlers con `:id` muestreados; todos pasan por `assertAccount`, `botFor`,
  `channelFor`, `conversationFor`, `contactFor` o un `WHERE account_id`. El agente, limitado a lo asignado en
  conversaciones, contactos, cobros, citas, embudos y archivos.
- **Sesiones y 2FA:** cookie firmada con prefijo, `timingSafeEqual`, `sid` en la base, sin fijación de sesión (se abre
  después del 2FA); TOTP sin reuso aun con peticiones simultáneas; códigos de recuperación con hash y de un solo uso;
  Google con `state` firmado ligado a cookie, `iss`, `aud` y `email_verified`; `x-copilot` solo quita permisos.
- **Webhooks y SSRF:** Stripe y Meta con el cuerpo crudo y comparación en tiempo constante; Mercado Pago con el id
  firmado; todos los `fetch` con una URL de usuario pasan por `fetchPublic`/`postSigned` (resolución al conectar,
  todas las direcciones, cada redirección, IPv4 dentro de IPv6, NAT64, 6to4, `100.64/10`, `169.254/16`).
- **Entradas:** `htmlToText` lineal (200 KB hostiles en < 20 ms); ZIP descomprimido con tope real; rutas de archivos sin
  salida de la carpeta; CSV con fórmulas neutralizadas; sin redirecciones abiertas.
- **Cobros:** el plan sale del precio cobrado, dinero en enteros, avisos idempotentes y desordenados sin efecto, una
  cotización se acepta una vez, ningún camino para tocar la facturación de otra cuenta.
- **Copiloto:** las herramientas van por `app.inject` con la cookie de la persona (cada ruta aplica rol, cuenta y lo
  asignado); argumentos con esquema, vueltos a validar al confirmar, con `args_hash`.
- **Navegador:** sin `innerHTML` con datos, sin tokens en `localStorage`, colores validados como `#RRGGBB` en el servidor
  y al pintar, `esc()` en todo HTML del servidor, widget en Shadow DOM con solo texto y enlaces http(s).
- **Servidor y CI:** contraseñas por stdin y `--passphrase-fd` (nunca en `ps`), `.env` en 600, sin `eval` ni `curl | sh`;
  CI sin `pull_request_target`, `permissions: contents: read`, acciones por SHA, secretos de OpenRouter solo en `main`;
  `randomBytes` para todo token y nada de `Math.random`.

## Pruebas

`npm run check:frontend` y `node --check public/app.js` pasan (60 módulos). La suite completa (`npm test`, 19 minutos)
contra PostgreSQL 16 local **sin pgvector**: **1 848 de 1 884 pasan**, 23 se saltan y 13 fallan, todas de búsqueda
semántica (`architecture-recovery`, `knowledge-monitor` y `operations`): sin la extensión no existe `knowledge_chunks`
(migración 011) y responden «La base de datos no está lista para búsqueda semántica». En el CI corren con
`pgvector/pgvector`. Todas las pruebas de identidad, sesiones, límites, aislamiento, webhooks, cobros, Copiloto y bitácora
de seguridad pasan.

## Orden sugerido

1. **PAY-24, AI-15 e IN-23**: los tres se cierran con cambios chicos y con prueba que falla hoy (IN-23 ya tiene los tres
   casos reproducidos).
2. **ID-18 y AI-16**: una línea en `EMAIL_PROVEN` y un candado en el Copiloto.
3. **INF-20** antes del lunes, para que la búsqueda semanal no salga en rojo.
4. **INF-16** con una prueba en staging (`docs/prueba-en-staging.md`).
5. **PAY-25**: decidir si vale más algún falso positivo que pruebas repetidas en Mercado Pago (decisión del dueño).
6. Los bajos, en un PR como los de la etapa «Bajos».
