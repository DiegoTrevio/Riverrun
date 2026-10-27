# Auditoría Riverrun, octubre 2026

**Base revisada:** `main` en 23574a1, con cobros P1–P3 ya integrados.

**Cómo se hizo.** Se usaron cuatro revisores de ECC, independientes y de solo lectura:
- `security-reviewer`: seguridad.
- `silent-failure-hunter`: listo para producción.
- `database-reviewer`: base de datos y rendimiento.
- `a11y-architect`: panel y accesibilidad.

Además:
- **Barridos automáticos:**
  - `npm audit`, más `tsc` buscando código sin usar;
  - búsquedas de SQL interpolado, `innerHTML`, `fetch` sin tiempo límite y `catch` vacíos.
- **Navegador:** se pasaron axe y una revisión de desbordes en las páginas públicas que no cubrían los recorridos de UX. Cada una en 320 px (claro), 390 px (oscuro) y 1440 px (claro).

Cada hallazgo crítico o alto se comprobó en el código. Los que no se sostuvieron están al final.

## Resumen

| Área | Crítico | Alto | Medio | Bajo |
|---|---|---|---|---|
| Seguridad | 1 | 0 | 2 | 7 |
| Listo para producción | 0 | 5 | 11 | 12 |
| Base de datos y rendimiento | 0 | 4 | 11 | 8 |
| Panel y accesibilidad | 0 | 6 | 13 | 9 |

**Lo que está sólido:**
- **Aislamiento entre cuentas:** todas las rutas con `:id` y los ids que vienen en el cuerpo se revisan contra la cuenta. Las llaves foráneas compuestas `(id, account_id)` lo refuerzan en la base.
- **Sesión:** scrypt con comparación de tiempo constante, cookie `httpOnly` y `SameSite=Strict`, y tokens de un solo uso.
- **Webhooks:** todos con firma y protección de repetición.
- **Llamadas a URLs de terceros:** revisión de DNS e IP privadas en los webhooks salientes y en la importación.
- **Archivos:** el tipo se detecta por su contenido.
- **XSS:** sin `innerHTML` con datos del usuario.
- **SQL:** sin inyección; todo lo interpolado es constante o un número ya validado.
- **Dependencias:** sin avisos en producción (`npm audit --omit=dev`: 0).
- **Llamadas externas:** todas con tiempo límite.
- **Colas:** con lease, reintentos y dead letter.
- **Respaldos:** cifrados y verificados.
- **Formularios:** el panel usa diálogos nativos accesibles, foco visible y `autocomplete`.

## Crítico y alto (se corrigen en PRs)

### Seguridad

**S1 · Crítico · Una cuenta puede quedarse con la página de Facebook o el Instagram de otra.** ✅ Corregido en el PR de seguridad (rama `audit-seguridad`).
- **Dónde:** `src/routes/channels.ts:47-58` (`clientConfig`) y `src/channels/meta-connect.ts:236` (`channelsForEntry`).
- **Causa:** en canales `messenger` e `instagram`, el administrador de una cuenta puede guardar cualquier `config`. El webhook de la plataforma entrega cada evento de Meta a todo canal con `connected_via='facebook'`, el `page_id` o `account_id` del evento y un token no vacío.
- **Ataque:** cualquiera que se registre crea un canal con `{connected_via:'facebook', page_id:<id público de la víctima>, page_access_token:'x'}`. Desde ese momento recibe los mensajes de los clientes de la víctima, y su asistente les contesta. Además puede «apartar» un `page_id` para que la conexión legítima se rechace.
- **Verificado en el código.**
- **Arreglo:**
  - Para quien no es superadmin, quitar `connected_via`, `page_id`, `account_id`, `page_access_token` e `instagram_*` de lo que manda el panel. Esos campos solo los escribe el flujo «Conectar con Facebook».
  - `channelsForEntry` exige además que el canal se haya conectado por ese flujo.
  - Un índice único por página conectada.

### Listo para producción

**P1 · Alto · `enforceAccess` puede dejar activa para siempre una cuenta sin pago.** (`src/billing/service.ts:329-347`) ✅ Corregido en el PR de cobros (rama `audit-cobros`).
- **Causa:** primero marca `access_ended_at` y después, fila por fila y sin transacción, pausa la cuenta.
- **Escenario:** si el proceso cae entre los dos pasos, la cuenta sigue activa. La consulta ya no la vuelve a tomar, porque exige `access_ended_at IS NULL`.
- **Arreglo:** pausar en la misma sentencia (CTE) o en la misma transacción.

**P2 · Alto · `cancelLongUnpaid` cancela en la base antes de encolar la cancelación en el proveedor.** (`src/billing/service.ts:429-448`) ✅ Corregido en el PR de cobros (rama `audit-cobros`).
- **Escenario:** si el proceso cae entre los dos pasos, la suscripción queda «cancelada» en la base, pero Stripe o Mercado Pago siguen reintentando el cobro. Nadie la vuelve a tomar.
- **Arreglo:** el cambio de estado y el `billing_actions` en la misma transacción.

**P3 · Alto · WhatsApp (Evolution) reintenta los envíos y puede mandar mensajes duplicados.** (`src/evolution/client.ts:18-50`) ✅ Corregido en el PR de mensajes (rama `audit-mensajes`).
- **Causa:** `sendText` y `sendMedia` usan `retries = 1` por defecto. Ante un tiempo agotado de 30 s o un 5xx, vuelven a hacer el POST aunque Evolution ya haya entregado el primero.
- **Escenario:** el reintento ocurre dentro de la llamada, así que la protección de entrega incierta (`delivery_attempts`) no lo ve. El cliente recibe el mensaje dos veces, también los recordatorios de pago.
- **Arreglo:** `retries = 0` en los envíos. La capa durable decide si reintentar.

**P4 · Alto · Un aviso de cobro se da por procesado antes de procesarlo.** (`src/routes/billing.ts:69-91`) ✅ Corregido en el PR de cobros (rama `audit-cobros`): se reserva al llegar y se da por procesado al terminar; lo que quede atorado más de un día se avisa al superadmin.
- **Causa:** `recordEvent` guarda el evento y después se aplica. Si el proceso muere en medio (despliegue o watchdog), el `DELETE` de compensación nunca corre, y el reintento del proveedor responde «ya procesado».
- **Escenario:** la conciliación diaria recupera el estado de la suscripción y los pagos, pero no los reembolsos ni los contracargos. Un contracargo así no pausa la cuenta, y un reembolso no genera su nota de crédito.
- **Arreglo:** guardar el evento con `processed_at` y reprocesarlo si quedó sin terminar.

**P5 · Alto · `docker-compose.yml` no le pasa al contenedor varias variables que la app lee.** ✅ Corregido en el PR de despliegue (rama `audit-despliegue`): compose pasa todas y `test/compose-env.test.ts` lo vigila.
- **Faltan, sobre todo:**
  - `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID` y `META_VERIFY_TOKEN`;
  - `CFDI_PRODUCT_KEY` y `CFDI_MAX_ATTEMPTS`;
  - `WATCHDOG*`, `SCHEDULER_INTERVAL_MS`, `JOB_TIMEOUT_MS`, `LOG_RETENTION_DAYS`, `AI_RUN_DETAIL_DAYS`, `QUOTE_PDF_*`, `OPENAI_MEDIA_MODEL` y `WHATSAPP_ALERT_*`.
- **Escenario:** al desplegar con Docker, «Conectar con Facebook» queda apagado aunque las variables estén en `.env`, y el CFDI usa la clave de producto por defecto.
- **Arreglo:** pasar todas las que lee `config.ts`, más una prueba que lo compare.

### Base de datos y rendimiento

**D1 · Alto · `messages` no tiene índice por fecha.** ✅ Corregido en el PR de base de datos (rama `audit-db-indices`): índice BRIN por `created_at`.
- **Causa:** solo tiene `(conversation_id, id)`.
- **Escenario:**
  - Las estadísticas (unas 8 consultas por página), los mensajes de 24 h por agente en el panel del superadmin, el consumo de Zernio del mes y la retención recorren todo el historial de la cuenta, o de la plataforma.
  - Con millones de mensajes, esas páginas tardan segundos o más.
- **Arreglo:** índice BRIN en `messages (created_at)`, que es barato porque la tabla solo crece. Requiere el modo de migración sin transacción (D5).

**D2 · Alto (a escala) · `GET /api/contacts` calcula a todos los contactos de la cuenta en cada búsqueda, y pagina con OFFSET.** (`src/routes/contact-workspace.ts:15-34`)
- **Arreglo:** filtrar antes de agrupar, y paginar por cursor.

**D3 · Alto · `pruneLogs` borra en una sola sentencia todos los `event_logs` viejos, sin candado.** (`src/logs.ts:39`) ✅ Corregido en el PR de base de datos (rama `audit-db-indices`): lotes de 5,000 y una sola instancia.
- **Escenario:** es la tabla de más volumen. Cada 6 horas borra millones de filas a la vez, con picos de WAL y de vacuum, y lo corre cada instancia al mismo tiempo.
- **Arreglo:** borrar en lotes de 5,000, con candado consultivo.

**D4 · Alto · `pruneAutomationData` borra los `jobs` terminados y los `notifications` viejos sin un índice que los encuentre, en una sola sentencia.** (`src/automation/store.ts:576-577`) ✅ Corregido en el PR de base de datos (rama `audit-db-indices`): índices por fecha y borrado en lotes.
- **Escenario:** las campañas crean un trabajo por destinatario, así que se recorre toda la tabla cada vez.
- **Arreglo:** índices parciales por `created_at`, y borrado en lotes.

**D5 · (base de D1) El sistema de migraciones corre cada archivo en una transacción**, así que no permite `CREATE INDEX CONCURRENTLY`. (`src/db.ts:68-82`) ✅ Corregido en el PR de base de datos (rama `audit-db-indices`): encabezado `-- migrate:no-transaction` y `lock_timeout` en las demás.
- **Arreglo:** un encabezado `-- migrate:no-transaction` para las migraciones de índices en tablas grandes.

### Panel y accesibilidad

**A1 · Alto · La bandeja pierde el foco del teclado cada 10 segundos.** (`public/js/conversations.js:222,238`)
- **Causa:** la lista se reconstruye completa en cada sondeo.
- **Escenario:** quien navega con teclado o lector de pantalla pierde su lugar.
- **Arreglo:** devolver el foco al mismo enlace tras recargar, como ya se hace con el scroll.

**A2 · Alto · Los mensajes nuevos del chat no se anuncian, ni en el panel ni en el widget.** (`conversations.js:250,394`; `widget.js:115,184`)
- **Arreglo:** `role="log"` en la lista de mensajes, agregar los mensajes en lugar de reemplazarlos y poner quién habla en texto para lector de pantalla.

**A3 · Alto · El menú lateral en celular y tableta no se usa con teclado.** (`shell.js:151,159`)
- **Causa:** al abrir no recibe el foco, Escape no lo cierra y el botón no tiene `aria-expanded`.
- **Escenario:** también afecta a quien usa zoom de 200 a 400 %.
- **Arreglo:** mover el foco al abrir, cerrar con Escape y devolver el foco al botón.

**A4 · Alto · La página pública para reservar pierde el foco en cada paso.** (`reservar.html:37`, `reservar.js:40-49`)
- **Causa:** reemplaza todo el `<main aria-live>`, así que algunos lectores releen la tarjeta completa.
- **Arreglo:** quitar `aria-live` de `main`, enfocar el título de cada paso y asociar los errores a su campo.

**A5 · Alto · Los errores de formulario no se asocian a su campo.** (`core.js:144-168`)
- **Causa:** `run()` muestra un aviso genérico al final de la tarjeta, y la lista de campos con error va dentro de un desplegable cerrado. Solo `billing.js` lo hace bien.
- **Arreglo:** marcar `aria-invalid` y `aria-describedby` en los campos que vienen en `issues`, y enfocar el primero.

**A6 · Alto · Contraste insuficiente en páginas públicas (axe: serio).**
- **Dónde:** en modo oscuro, los enlaces del pie de `/estado`, `/contacto`, `/privacidad` y `/borrar-cuenta`. En `ayuda.html`, en claro y oscuro, el botón y los enlaces de color.
- **Ya fallan hoy:** cualquiera de esas páginas, en las pruebas hechas en esta auditoría.
- **Arreglo:** colores de acento con contraste de 4.5:1 en los dos temas. Además, agregar estas páginas a `test:ux`.

## Medio y bajo (quedan para que decidas)

**Seguridad**
- **Medio:**
  - ✅ Corregido en el PR de seguridad: descarga de medios entrantes de Meta sin protección de IP privadas (`meta.ts:254`), y comparación de origen de Zernio por prefijo (`zernio.ts:287`).
  - ✅ Corregido en el PR de seguridad (sesiones registradas, con su lista en Mi perfil): las sesiones no se podían revocar en el servidor: cerrar sesión solo borra la cookie, que dura 7 días.
- **Bajo:**
  - ✅ Corregido en el PR de despliegue: sin encabezados CSP, HSTS ni `frame-ancestors` (ahora CSP estricta en el panel, `X-Frame-Options` en las páginas salvo reservar y la ayuda, y HSTS en Caddy).
  - Los secretos de Telegram se muestran a los administradores de la cuenta.
  - `/api/me` devuelve `a.*` de la cuenta.
  - El límite de intentos de inicio de sesión es solo por IP.
  - Se puede saber si un correo ya está registrado.
  - El captcha deja pasar si Cloudflare no responde.

**Listo para producción**
- **Medio:**
  - ✅ Corregido en el PR de mensajes (rama `audit-mensajes`) (si el servidor de correo falla, el correo se reintenta solo): avisos marcados como enviados aunque el correo falló: el de fin de prueba, el de cobro fallido y el resumen del superadmin, porque `sendMail` devuelve `false` en lugar de lanzar un error.
  - ✅ Corregido en el PR de cobros (rama `audit-cobros`): `applyState` tenía un candado global mientras mandaba correos (ahora es por cuenta, los correos salen después y SMTP tiene tiempo límite).
  - ✅ Corregido en el PR de cobros (rama `audit-cobros`): en un reintento podía faltar el CFDI de un pago ya registrado.
  - ✅ Corregido en el PR de cobros (rama `audit-cobros`): un reembolso que llegaba antes que su pago se perdía (ahora el aviso se reintenta).
  - ✅ Corregido en el PR de cobros (rama `audit-cobros`): el lease del CFDI podía vencer a mitad del lote (ahora se reserva uno a la vez).
  - ✅ Corregido en el PR de mensajes (rama `audit-mensajes`): el `tick()` del ciclo de vida se podía encimar con el anterior.
  - ✅ Corregido en el PR de mensajes (rama `audit-mensajes`): errores que se perdían en el scheduler, la cola y los webhooks (no se guardaba el mensaje).
  - ✅ Corregido en el PR de mensajes (rama `audit-mensajes`): un recordatorio de pago que no se pudo enviar no se reintentaba (ahora, cada hora hasta 3 veces, y luego avisa).
  - ✅ Corregido en el PR de mensajes (rama `audit-mensajes`): el cuerpo de la respuesta de la IA se leía sin tiempo límite.
- **Bajo:**
  - ✅ Corregido en el PR de cobros (rama `audit-cobros`): fechas imposibles («31 de febrero») daban 500.
  - ✅ Corregido en el PR de cobros (rama `audit-cobros`): la factura global solo cubría el mes anterior (ahora, cualquier mes cerrado de los últimos 3).
  - ✅ Corregido en el PR de mensajes (rama `audit-mensajes`): trabajos que tumban el proceso no tenían límite de intentos al recuperarse.
  - ✅ Corregido en el PR de despliegue: el apagado no tenía plazo máximo (ahora `SHUTDOWN_TIMEOUT_MS`, cierra la base y no se repite con otra señal).
  - ✅ Corregido en el PR de despliegue: `HEALTHCHECK` no revisaba la base (ahora `/health/db`, con `start-period`; Caddy espera al backend sano).
  - ✅ Corregido en el PR de despliegue: el CI no escaneaba la imagen (ahora Trivy y una prueba de humo de la imagen).

**Base de datos**
- **Medio:**
  - Orden de candados invertido entre contacto y conversación, que puede causar deadlocks.
  - La bandeja hace subconsultas por fila y no usa su índice para ordenar.
  - ✅ Corregido en el PR de base de datos: `cancelJobs` por `enrollment_id` y `conversation_id` no tenía índice.
  - El lanzamiento de una campaña es N+1, no es atómico y recalcula las estadísticas en cada envío.
  - ✅ Corregido en el PR de base de datos: la recuperación de trabajos colgados no tenía índice.
  - El borrado de una cuenta es una sola transacción gigante.
  - La conexión se queda tomada durante llamadas externas.
  - La exportación ordena toda la cuenta en cada lote.
  - ✅ Corregido en el PR de base de datos: faltaban índices de monitoreo en `event_logs` (ahora, errores por fecha).
  - Las migraciones antiguas tienen CHECK y FK sin `NOT VALID`.
- **Bajo:**
  - ✅ Corregido en el PR de base de datos: sin `statement_timeout` ni `idle_in_transaction_session_timeout` (ahora 60 s cada uno, configurables).
  - Reiniciar conversaciones va una por una.
  - `fillfactor` en `conversations`.

**Accesibilidad**
- **Medio:**
  - Sin enlace para saltar al contenido.
  - El inicio de sesión y el registro no tienen `<main>`.
  - El título de la pestaña no cambia por página.
  - El aviso emergente se crea al vuelo y queda debajo de un diálogo abierto.
  - Contraste de bordes de campos (1.5:1) y de botones rojos en modo oscuro (3:1).
  - El widget quita el contorno de foco.
  - El foco queda debajo de la barra fija.
  - El menú de usuario tiene `role="menu"` sin manejo de teclado.
  - Las pestañas de la bandeja están a medias.
  - Los botones de día en reservar tienen etiqueta distinta al texto visible.
  - Los errores del formulario de contacto no van a su campo.
  - Los controles dentro de un grupo se llaman «Dato 1».
  - El widget no lleva `lang="es"`.
- **Bajo:** objetivos de menos de 24 px, la tarea se borra sin confirmar, subrayado de enlaces tenue y otros detalles.

**Dependencias:** 9 avisos altos solo en dependencias de desarrollo (por `promptfoo`). No llegan a producción.

## Lo que no se sostuvo o se descartó
- **SQL interpolado:** las 40 interpolaciones dentro de consultas son constantes, columnas fijas, enumeraciones o enteros validados por zod. No hay inyección.
- **`html:` en el panel:** solo se usa con íconos SVG fijos.
- **`fetch` sin tiempo límite:** los 13 que parecían no tenerlo usan `AbortSignal.timeout` o un `AbortController`.
- **Código sin usar:** 6 variables sin uso. Es limpieza, no un riesgo.

## Plan de arreglos (crítico y alto)
1. **PR seguridad:** S1, con su prueba de aislamiento (otra cuenta no puede apartar ni recibir una página).
2. **PR cobros y producción:** P1, P2, P3 y P4, cada uno con su prueba de regresión. P5, con una prueba que compara `config.ts` con `docker-compose.yml`.
3. **PR base de datos:** D5, el modo de migración sin transacción, más D1, D3, D4 (la migración 084 con índices y los borrados en lotes) y D2.
4. **PR accesibilidad:** A1–A6, más la cobertura de las páginas públicas en `test:ux`.
