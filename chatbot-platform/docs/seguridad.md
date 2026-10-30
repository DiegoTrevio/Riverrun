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
| 2. Identidad | 2FA obligatorio para todos, contraseñas filtradas, sesiones con caducidad por inactividad, límites por cuenta y en la base, dueño distinto de administrador, correo verificado de verdad (ID-2…ID-10) | Pendiente |
| 3. Registro y cobros | Captcha → correo → 2FA → pago, topes contra prueba de tarjetas (PAY-2), Radar, disputas, pruebas gratis por persona (PAY-3…PAY-16) | Pendiente |
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

## Hallazgos pendientes por etapa

Abreviaturas: ID identidad, PAY cobros, IN entradas, AI IA y Copiloto, INF servidor.

### Altos (en etapas 3 y 8)
- **PAY-2** Prueba de tarjetas robadas: el registro abre una sesión de pago de Stripe sin correo verificado, captcha opcional y límites en memoria (unas 100 sesiones por hora desde una conexión); la sesión no vence pronto y acepta cualquier cupón.
- **INF-2** Un solo superusuario de PostgreSQL compartido por el backend, Evolution y el respaldo; Redis sin contraseña (guarda las claves de las sesiones de WhatsApp); red plana.
- **INF-3** `./riverrun update` nunca actualiza Caddy, Node, Redis ni PostgreSQL.

### Medios
- **ID-2** Cualquier administrador equivale al dueño (puede cambiar su clave, degradarlo, borrar o exportar la cuenta).
- **ID-3** Límite de intentos de login solo por IP, con carrera y en memoria; scrypt con parámetros por omisión.
- **ID-4** Cuentas «verificadas» sin prueba de control del correo (también las que crea un administrador); el login con Google entra a ellas.
- **ID-5** Al dar de baja a alguien sobreviven sus invitaciones, llaves de API y webhooks.
- **ID-6** Las invitaciones sirven para mandar correo con texto controlado desde una cuenta sin verificar.
- **PAY-3** Pruebas gratis sin límite (correo sin normalizar, sin huella de tarjeta).
- **PAY-4/5** Disputas: un aviso fuera de orden re-pausa para siempre; una disputa abierta no detiene los cobros.
- **PAY-6** Cuentas en pausa o sin cupo siguen gastando IA (transcripción, Copiloto, herramientas con IA).
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
ID-7…ID-10 (tiempos en recuperar contraseña, tokens de recuperación vigentes tras cambiar la clave, cookies antiguas
irrevocables, enlaces de marca blanca), PAY-10…PAY-16, AI-10…AI-13, IN-8…IN-14 (calendario `.ics` sin escapar, asunto
reflejado, textos de la URL en el panel, reservas como relé de correo, `unsafe-inline` en páginas públicas, plazos de
descarga, analizador JSON propio), INF-12…INF-15 (secretos impresos por el instalador, cuerpos de correo en la bitácora sin
SMTP, `.gitignore`, acciones por etiqueta). `privacy.md` y `terms.md` (sitio de GitHub Pages) dicen «Viralize» y prometen
«encriptamos todos los datos»: lo revisa el dueño o su abogado.
