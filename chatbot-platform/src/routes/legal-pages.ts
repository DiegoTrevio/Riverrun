/**
 * Avisos de privacidad de la plataforma, conforme a la Ley Federal de Protección de Datos Personales en Posesión de
 * los Particulares (DOF 20-03-2025):
 * - /privacidad: aviso integral (art. 15: responsable, datos, finalidades, transferencias, ARCO, revocación, cookies…);
 * - /privacidad/simplificado: aviso simplificado (art. 16), el que se da al registrarse en línea;
 * - /proteccion-de-datos: cómo tratamos los datos de los clientes de cada negocio (somos su encargado), con qué
 *   proveedores, qué medidas de seguridad hay y un texto de aviso que el negocio puede usar con sus clientes.
 * Los datos que solo el operador puede dar (razón social, domicilio, correo) salen de PRIVACY_COMPANY, PRIVACY_ADDRESS
 * y PRIVACY_CONTACT; mientras falten se ven entre corchetes y `npm run config:check` lo avisa.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { PRIVACY_NOTICE_VERSION } from '../signup-guard.js';
import { esc } from './util.js';

interface LegalDeps {
  page: (o: { title: string; brand: any; body: string }) => string;
  brandFor: (req: FastifyRequest) => Promise<{ brand: unknown }>;
  privacyContact: () => string;
}
/** Datos del responsable, ya escapados para HTML. */
interface Responsible { company: string; address: string; contact: string }
interface Processor { name: string; purpose: string; data: string }

/** Lo que falta por definir se ve como marcador, para que no pase desapercibido antes de publicar. */
const pending = (what: string) => `<mark>[${esc(what)}]</mark>`;

/** Quién es el responsable (con marcadores si falta algo). */
export function responsible(contact: string): Responsible {
  return {
    company: config.signup.privacyCompany ? esc(config.signup.privacyCompany) : pending('Razón social del responsable'),
    address: config.signup.privacyAddress ? esc(config.signup.privacyAddress) : pending('Domicilio del responsable'),
    contact: contact ? esc(contact) : pending('Correo para privacidad'),
  };
}

const updated = () => new Date(`${PRIVACY_NOTICE_VERSION}T12:00:00Z`).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });

/** Proveedores que tratan datos por cuenta nuestra (encargados): quién, para qué y qué datos reciben. */
export const PROCESSORS: readonly Processor[] = [
  { name: 'DigitalOcean', purpose: 'Servidores donde funciona la plataforma, su base de datos y los respaldos cifrados.', data: 'Todos los datos que guarda la plataforma.' },
  { name: 'Zernio', purpose: 'Conexión con las redes sociales (Facebook, Instagram, TikTok y otras) para recibir y enviar mensajes y comentarios.', data: 'Mensajes, nombre y usuario de la persona en la red social.' },
  { name: 'OpenRouter y los modelos de inteligencia artificial que usa', purpose: 'Escribir las respuestas del asistente, transcribir notas de voz, leer imágenes y armar cotizaciones.', data: 'El texto de la conversación y la información del negocio necesarios para cada respuesta.' },
  { name: 'Stripe y Mercado Pago', purpose: 'Cobrar las suscripciones y los pagos que el negocio pide a sus clientes.', data: 'Nombre, correo, monto y estado del pago. La tarjeta la capturan ellos: nosotros no la vemos.' },
  { name: 'Facturapi', purpose: 'Emitir facturas electrónicas (CFDI).', data: 'RFC, razón social, régimen fiscal, código postal, correo y montos.' },
  { name: 'Resend (u otro servicio de correo)', purpose: 'Enviar los correos de la plataforma: confirmación de cuenta, avisos y recordatorios.', data: 'Correo, nombre y el contenido del aviso.' },
  { name: 'Cloudflare Turnstile', purpose: 'Comprobar que quien llena un formulario no es un robot.', data: 'Dirección IP y datos del navegador.' },
  { name: 'Google y Microsoft', purpose: 'Entrar con tu cuenta de Google y conectar tu calendario de Google u Outlook, solo si tú lo activas.', data: 'Nombre, correo y las citas del calendario conectado.' },
];

const processorTable = () => `<div class="card"><table>
    <thead><tr><th scope="col">Proveedor</th><th scope="col">Para qué</th><th scope="col">Qué datos recibe</th></tr></thead>
    <tbody>${PROCESSORS.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${esc(p.purpose)}</td><td><span class="lbl">Qué datos recibe: </span>${esc(p.data)}</td></tr>`).join('')}</tbody>
  </table></div>`;

const LEGAL_CSS = '<style>table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;vertical-align:top;padding:8px 6px;border-bottom:1px solid var(--border)}thead th{color:var(--muted)}mark{background:#fef0c7;color:#7a2e0e;padding:0 3px;border-radius:3px}blockquote{margin:0;padding:12px 16px;border-left:4px solid var(--border);background:var(--panel)}td,th{overflow-wrap:anywhere}.lbl{display:none}@media (max-width:600px){table,tbody,tr,th,td{display:block}thead{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}tr{padding:8px 0;border-bottom:1px solid var(--border)}th,td{border:0;padding:2px 0}.lbl{display:inline;font-weight:600}}</style>';

/** Cuánto se conservan los datos, con los plazos configurados. */
function retentionText() {
  const pause = config.billing.retentionDays > 0
    ? `Una cuenta en pausa se borra sola después de ${config.billing.retentionDays} días, con aviso previo, y puedes borrarla tú cuando quieras.`
    : 'Puedes borrar tu cuenta cuando quieras.';
  const logs = config.logRetentionDays > 0 ? `Los registros de actividad duran ${config.logRetentionDays} días y los` : 'Los registros';
  return `Mientras tu cuenta esté activa. ${pause} ${logs} de seguridad ${config.securityLogDays} días. Los respaldos cifrados se guardan por un tiempo limitado: los más antiguos se borran conforme se hacen nuevos. Los pagos y las facturas se conservan el tiempo que exige la ley fiscal.`;
}

function integral(r: Responsible) {
  return `<h1>Aviso de privacidad integral</h1>
  <p class="muted">Última actualización: ${esc(updated())}. ¿Prefieres la versión corta? Lee el <a href="/privacidad/simplificado">aviso simplificado</a>.</p>

  <h2>Quién es responsable de tus datos</h2>
  <p>${r.company}, con domicilio en ${r.address}, es responsable del tratamiento de los datos personales de quienes crean y usan una cuenta en esta plataforma. Para cualquier tema de privacidad escríbenos a <strong>${r.contact}</strong>.</p>
  <p>Los datos de los <strong>clientes de cada negocio</strong> (las personas que escriben por WhatsApp, redes sociales, correo o el chat de la página) los decide y controla ese negocio, que es su responsable; nosotros los tratamos por su cuenta, como encargados. Lo explicamos en <a href="/proteccion-de-datos">Protección de datos</a>.</p>

  <h2>Qué datos tratamos</h2>
  <ul>
    <li><strong>De identificación y contacto:</strong> nombre, correo, teléfono para avisos y, si entras con Google, el nombre y el correo de esa cuenta.</li>
    <li><strong>De tu negocio:</strong> nombre, giro y la información que cargas (productos, precios, horarios, documentos).</li>
    <li><strong>Fiscales y de pago:</strong> RFC, razón social, régimen fiscal, código postal, tus pagos y tus facturas. La tarjeta la procesan Stripe o Mercado Pago; nosotros no la vemos ni la guardamos.</li>
    <li><strong>Técnicos y de seguridad:</strong> dirección IP, navegador, inicios de sesión, registros de actividad y de errores, y el consumo de inteligencia artificial.</li>
    <li><strong>Si conectas tu calendario</strong> (Google u Outlook): las citas necesarias para agendar.</li>
  </ul>
  <p><strong>Datos sensibles:</strong> no te pedimos datos sensibles (salud, religión, origen, preferencias, etc.). Si los clientes de tu negocio los escriben en sus mensajes, se guardan como parte de la conversación y quedan bajo la responsabilidad de tu negocio.</p>

  <h2>Para qué los usamos</h2>
  <p><strong>Finalidades necesarias</strong> para darte el servicio (sin ellas no podemos prestarlo):</p>
  <ul>
    <li>Crear y administrar tu cuenta, y confirmar que eres tú.</li>
    <li>Prestar el servicio: responder mensajes, cotizar, agendar y avisarte cuando un cliente necesita a una persona.</li>
    <li>Cobrar tu plan y emitir tus facturas.</li>
    <li>Darte soporte y avisarte de cambios en el servicio, tu plan o tus pagos.</li>
    <li>Cuidar la seguridad, prevenir fraudes y abusos (incluido que la prueba gratis sea una por persona).</li>
    <li>Cumplir las obligaciones que nos imponen las leyes, como las fiscales.</li>
  </ul>
  <p><strong>Finalidades secundarias:</strong> hoy no usamos tus datos para nada más (ni publicidad, ni mercadotecnia, ni para venderlos). Si algún día quisiéramos hacerlo, te lo pediríamos antes y podrías negarte sin que eso afecte tu servicio, escribiendo a <strong>${r.contact}</strong>.</p>

  <h2>Con quién los compartimos</h2>
  <p>Para prestar el servicio nos apoyamos en proveedores que tratan los datos por cuenta nuestra y solo para eso (alojamiento, inteligencia artificial, redes sociales, correo, pagos y facturación). Esa comunicación no requiere tu consentimiento; la lista completa está en <a href="/proteccion-de-datos#proveedores">Protección de datos</a>. Algunos están fuera de México, por ejemplo en Estados Unidos.</p>
  <p>Solo transferimos datos a terceros cuando lo exige una ley o lo pide una autoridad competente. No hacemos otras transferencias que requieran tu consentimiento.</p>

  <h2 id="arco">Tus derechos (ARCO) y cómo ejercerlos</h2>
  <p>Puedes <strong>acceder</strong> a tus datos, <strong>rectificarlos</strong>, <strong>cancelarlos</strong> u <strong>oponerte</strong> a su uso. Hay dos formas:</p>
  <ul>
    <li><strong>Desde tu panel, al momento:</strong> en <em>Mi plan y pagos → Tus datos</em> descargas todos tus datos o borras tu cuenta; tus datos de perfil los corriges en <em>Mi perfil</em>.</li>
    <li><strong>Por escrito:</strong> manda un correo a <strong>${r.contact}</strong> con tu nombre, el correo de tu cuenta, el derecho que quieres ejercer y sobre qué datos, y una copia de tu identificación (o la de tu representante, con el documento que lo acredite). Te respondemos en un máximo de 20 días hábiles y, si procede, lo hacemos efectivo en los 15 días hábiles siguientes. Si el caso lo justifica, esos plazos pueden ampliarse una sola vez por el mismo tiempo, y te lo avisaremos.</li>
  </ul>
  <p>Si eres cliente de un negocio que usa este servicio, dirige tu solicitud a ese negocio; nosotros le ayudamos a atenderla.</p>

  <h2>Revocar tu consentimiento o limitar el uso de tus datos</h2>
  <p>Puedes revocar tu consentimiento o pedir que limitemos el uso o la divulgación de tus datos por el mismo correo y con los mismos plazos. Si los datos son necesarios para el servicio, revocar el consentimiento puede implicar cerrar tu cuenta.</p>

  <h2>Cookies y tecnologías parecidas</h2>
  <p>Usamos solo cookies necesarias: para mantener tu sesión, recordar un dispositivo de confianza en la verificación en dos pasos y completar el inicio con Google. El captcha de Cloudflare puede usar las suyas en los formularios. El chat de las páginas de los negocios guarda en tu navegador un identificador para continuar la conversación. No usamos cookies de publicidad ni de medición de terceros. Puedes borrarlas desde tu navegador; si lo haces, tendrás que volver a entrar.</p>

  <h2>Cuánto tiempo los conservamos</h2>
  <p>${esc(retentionText())}</p>
  <p><strong>Una prueba gratis por persona:</strong> para que nadie repita la prueba, guardamos durante 2 años una huella irreversible (no el dato) de tu correo, de tu cuenta de Google y de tu tarjeta. Con ella no se puede saber cuál es tu correo ni tu tarjeta, solo reconocerlos si vuelven a usarse para otra prueba. Borrar tu cuenta no borra esa huella antes de tiempo.</p>

  <h2>Cómo los protegemos</h2>
  <p>Conexiones cifradas, contraseñas guardadas de forma irreversible, verificación en dos pasos, separación entre cuentas, cifrado de las claves y credenciales guardadas, respaldos cifrados y registro de accesos. Si ocurriera una vulneración de seguridad que afecte de forma importante tus derechos, te avisaremos sin demora por correo, con lo que pasó y qué puedes hacer.</p>

  <h2>Cambios a este aviso</h2>
  <p>Publicaremos aquí cualquier cambio, con su fecha, y si es importante te avisaremos por correo o en tu panel.</p>

  <h2>Autoridad</h2>
  <p>Si crees que no atendimos bien tu solicitud o que se vulneró tu derecho a la protección de datos, puedes acudir a la Secretaría Anticorrupción y Buen Gobierno, autoridad encargada de aplicar la ley de protección de datos personales.</p>`;
}

function simplified(r: Responsible) {
  return `<h1>Aviso de privacidad simplificado</h1>
  <p>${r.company} es responsable de los datos personales que nos das al crear y usar tu cuenta.</p>
  <p><strong>Los usamos para:</strong> crear y administrar tu cuenta, prestarte el servicio, cobrarte y facturarte, darte soporte, cuidar la seguridad y cumplir la ley. No los usamos para publicidad ni los vendemos.</p>
  <p><strong>Los compartimos</strong> solo con los proveedores que nos ayudan a prestar el servicio (alojamiento, inteligencia artificial, redes sociales, correo, pagos y facturación) y con autoridades cuando la ley lo exige. No hacemos transferencias que requieran tu consentimiento.</p>
  <p>Para ejercer tus derechos ARCO, revocar tu consentimiento o conocer todos los detalles, lee el <a href="/privacidad">aviso de privacidad integral</a> o escribe a <strong>${r.contact}</strong>.</p>
  <p class="muted">Última actualización: ${esc(updated())}.</p>`;
}

function dataProtection(r: Responsible) {
  return `<h1>Protección de datos</h1>
  <p class="muted">Cómo cuidamos los datos de los clientes de tu negocio. Última actualización: ${esc(updated())}.</p>

  <h2>Quién decide y quién trata</h2>
  <p>Las personas que le escriben a tu negocio son <strong>tus clientes</strong>: tu negocio es el <strong>responsable</strong> de sus datos y decide para qué se usan. ${r.company} es tu <strong>encargado</strong>: los trata solo por cuenta tuya y para prestarte el servicio. Nos comprometemos a:</p>
  <ul>
    <li>Usarlos solo para lo que configuras: responder, cotizar, agendar, cobrar y avisarte.</li>
    <li>No usarlos para fines propios, no venderlos y no compartirlos salvo con los proveedores de abajo o cuando lo exija la ley.</li>
    <li>Guardar confidencialidad y limitar el acceso a quien lo necesita para darte soporte.</li>
    <li>Ayudarte a atender las solicitudes ARCO de tus clientes.</li>
    <li>Borrarlos cuando lo pidas o cuando termine tu cuenta, salvo lo que la ley obligue a conservar.</li>
  </ul>

  <h2>Lo que puedes hacer desde tu panel</h2>
  <ul>
    <li><strong>Entregar los datos de un cliente:</strong> en su conversación, «Privacidad de este cliente» descarga todo lo que guardamos de él.</li>
    <li><strong>Borrar los datos de un cliente:</strong> ahí mismo, «Borrar todos sus datos» elimina sus conversaciones, mensajes y archivos (las cotizaciones quedan sin sus datos).</li>
    <li><strong>Cuánto tiempo guardar los datos:</strong> en los ajustes de privacidad eliges a los cuántos días se borran los mensajes y los contactos inactivos.</li>
    <li><strong>Bajas de mensajes:</strong> quien responde BAJA deja de recibir campañas y recordatorios.</li>
    <li><strong>Tu cuenta completa:</strong> en Mi plan y pagos → Tus datos descargas todo o borras tu cuenta.</li>
  </ul>

  <h2 id="proveedores">Proveedores que nos ayudan</h2>
  <p>Estos proveedores tratan datos por cuenta nuestra y solo para lo que se indica. Algunos están fuera de México, por ejemplo en Estados Unidos.</p>
  ${processorTable()}
  <p>WhatsApp, Facebook, Instagram, TikTok, el correo y los demás canales son servicios de sus propias empresas: los mensajes pasan por ellos y los tratan según sus propios avisos de privacidad.</p>

  <h2>Cómo los protegemos</h2>
  <ul>
    <li>Conexiones cifradas (HTTPS) y credenciales de los canales guardadas cifradas.</li>
    <li>Cada negocio ve solo sus datos; dentro del negocio, cada persona entra con su propio usuario, su rol y, si la activa, verificación en dos pasos.</li>
    <li>Respaldos diarios cifrados, que se renuevan solos.</li>
    <li>Registro de accesos y de acciones delicadas (descargas, borrados, cambios de permisos).</li>
    <li>Al asistente le enviamos solo lo necesario para responder, y sus respuestas se revisan para que no invente precios, horarios ni enlaces.</li>
  </ul>

  <h2>Si algo sale mal</h2>
  <p>Si ocurriera una vulneración de seguridad que afecte los datos de tus clientes, te avisaremos sin demora por correo, con lo que pasó, qué datos se vieron afectados y qué recomendamos hacer, para que tú puedas avisar a tus clientes.</p>

  <h2>Tu aviso de privacidad para tus clientes</h2>
  <p>Como responsable, tu negocio debe dar a sus clientes su propio aviso de privacidad. Puedes partir de este texto, cambiar lo que está entre corchetes y publicarlo en tu página o enviarlo en el primer mensaje:</p>
  <blockquote>[Nombre de tu negocio], con domicilio en [tu domicilio], usará tu nombre, tu número o usuario y lo que nos escribas para atenderte, darte precios y cotizaciones, agendar tus citas y cobrarte. Para responderte más rápido usamos un asistente automático y proveedores de tecnología que tratan tus datos solo por nuestra cuenta. No vendemos tus datos. Para ejercer tus derechos ARCO escríbenos a [tu correo]. Aviso completo: [dirección de tu aviso].</blockquote>
  <p>Este texto es un punto de partida, no asesoría legal: revísalo con tu abogado.</p>
  <p>¿Dudas sobre privacidad? Escríbenos a <strong>${r.contact}</strong> o lee nuestro <a href="/privacidad">aviso de privacidad</a>.</p>`;
}

/** Registra las tres páginas en el ámbito de las páginas públicas (con su marca y su pie). */
export function registerLegalPages(app: FastifyInstance, deps: LegalDeps): void {
  const send = async (req: FastifyRequest, reply: FastifyReply, title: string, body: (r: Responsible) => string) => {
    const { brand } = await deps.brandFor(req);
    const html = deps.page({ title, brand, body: LEGAL_CSS + body(responsible(deps.privacyContact())) });
    return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').header('vary', 'Host').send(html);
  };
  // Si el operador publica su propio aviso (PRIVACY_URL), /privacidad lleva a ese: así todo enlace a /privacidad sirve.
  // Si por error apunta a esta misma página, se sirve la incluida (sin repetir la redirección sin fin).
  const own = (req: FastifyRequest, reply: FastifyReply) => {
    const to = config.signup.privacyUrl;
    if (!to) return null;
    let self = false;
    try {
      const here = new URL(`http://${req.headers.host ?? 'x.invalid'}`);
      const u = new URL(to, here);
      self = u.hostname === here.hostname && /^\/privacidad(\/|$)/.test(u.pathname);
    } catch { /* una dirección ilegible no es esta página */ }
    return self ? null : reply.header('cache-control', 'public, max-age=300').header('vary', 'Host').redirect(to, 302);
  };
  app.get('/privacidad', (req, reply) => own(req, reply) ?? send(req, reply, 'Aviso de privacidad', integral));
  app.get('/privacidad/simplificado', (req, reply) => own(req, reply) ?? send(req, reply, 'Aviso de privacidad simplificado', simplified));
  app.get('/proteccion-de-datos', (req, reply) => send(req, reply, 'Protección de datos', dataProtection));
}
