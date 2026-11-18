/**
 * Avisos de privacidad en inglés, para quien usa la plataforma desde Estados Unidos:
 * - /privacy: Privacy Policy (qué datos, para qué, con quién, derechos de las leyes estatales de privacidad de EE. UU.,
 *   cookies, conservación, menores y transferencias internacionales);
 * - /data-protection: cómo tratamos los datos de los clientes de cada negocio (somos su proveedor de servicio).
 * Son la versión en inglés de /privacidad y /proteccion-de-datos (legal-pages.ts): si cambias una, cambia la otra.
 * Es un borrador que debe revisar un abogado de EE. UU. antes de publicar (docs/idiomas.md).
 */
import { config } from '../config.js';
import { PRIVACY_NOTICE_VERSION } from '../signup-guard.js';
import { esc } from './util.js';

/** Datos del responsable, ya escapados para HTML. */
export interface ResponsibleEn { company: string; address: string; contact: string }
interface Processor { name: string; purpose: string; data: string }

const pending = (what: string) => `<mark>[${esc(what)}]</mark>`;

/** Quién es el responsable (con marcadores en inglés si falta algo). */
export function responsibleEn(contact: string): ResponsibleEn {
  return {
    company: config.signup.privacyCompany ? esc(config.signup.privacyCompany) : pending('Company legal name'),
    address: config.signup.privacyAddress ? esc(config.signup.privacyAddress) : pending('Company address'),
    contact: contact ? esc(contact) : pending('Privacy contact email'),
  };
}

const updated = () => new Date(`${PRIVACY_NOTICE_VERSION}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Los mismos proveedores que PROCESSORS (legal-pages.ts), en inglés y en el mismo orden. */
export const PROCESSORS_EN: readonly Processor[] = [
  { name: 'DigitalOcean', purpose: 'Servers that run the platform, its database and the encrypted backups.', data: 'All the data the platform stores.' },
  { name: 'Zernio', purpose: 'Connection to social networks (Facebook, Instagram, TikTok and others) to receive and send messages and comments.', data: "Messages, and the person's name and username on the social network." },
  { name: 'OpenRouter and the artificial intelligence models it uses', purpose: "Writing the assistant's replies, transcribing voice notes, reading images and preparing quotes.", data: 'The conversation text and the business information needed for each reply.' },
  { name: 'Stripe and Mercado Pago', purpose: 'Charging subscriptions and the payments a business requests from its customers.', data: 'Name, email, amount and payment status. They collect the card: we never see it.' },
  { name: 'Facturapi', purpose: 'Issuing Mexican electronic tax invoices (CFDI), only for businesses in Mexico.', data: 'Tax ID (RFC), legal name, tax regime, postal code, email and amounts.' },
  { name: 'Resend (or another email service)', purpose: 'Sending the platform emails: account confirmation, notices and reminders.', data: 'Email, name and the content of the notice.' },
  { name: 'Cloudflare Turnstile', purpose: 'Checking that whoever fills out a form is not a bot.', data: 'IP address and browser data.' },
  { name: 'Google and Microsoft', purpose: 'Signing in with your Google account and connecting your Google or Outlook calendar, only if you turn it on.', data: 'Name, email and the appointments in the connected calendar.' },
];

const processorTable = () => `<div class="card"><table>
    <thead><tr><th scope="col">Provider</th><th scope="col">What for</th><th scope="col">What data it receives</th></tr></thead>
    <tbody>${PROCESSORS_EN.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${esc(p.purpose)}</td><td><span class="lbl">What data it receives: </span>${esc(p.data)}</td></tr>`).join('')}</tbody>
  </table></div>`;

/** Cuánto se conservan los datos, con los plazos configurados. */
function retentionText(): string {
  const pause = config.billing.retentionDays > 0
    ? `A paused account is deleted automatically after ${config.billing.retentionDays} days, with prior notice, and you can delete it yourself at any time.`
    : 'You can delete your account at any time.';
  const logs = config.logRetentionDays > 0 ? `Activity logs are kept for ${config.logRetentionDays} days and security logs` : 'Security logs are kept';
  return `While your account is active. ${pause} ${logs} for ${config.securityLogDays} days. Encrypted backups are kept for a limited time: the oldest are deleted as new ones are made. Payment and tax records are kept for as long as the law requires.`;
}

export function privacyPolicy(r: ResponsibleEn): string {
  return `<h1>Privacy Policy</h1>
  <p class="muted">Last updated: ${esc(updated())}.</p>

  <h2>Who we are</h2>
  <p>${r.company}, located at ${r.address} ("we", "us"), runs this platform and is responsible for the personal information of the people who create and use an account on it. For anything about privacy, write to us at <strong>${r.contact}</strong>.</p>
  <p>The information about <strong>each business's customers</strong> (the people who write to it on WhatsApp, social media, email or the website chat) belongs to that business, which decides how it is used. We handle it only on the business's behalf, as its service provider. We explain how in <a href="/data-protection">Data protection</a>.</p>

  <h2>Information we collect</h2>
  <ul>
    <li><strong>Identity and contact:</strong> name, email, a phone number for notices and, if you sign in with Google, the name and email of that account.</li>
    <li><strong>About your business:</strong> name, type of business and the information you upload (products, prices, hours, documents).</li>
    <li><strong>Billing:</strong> your payments and, for businesses in Mexico, their tax details and invoices. Stripe or Mercado Pago process your card; we never see or store it.</li>
    <li><strong>Technical and security:</strong> IP address, browser, sign-ins, activity and error logs, and artificial intelligence usage.</li>
    <li><strong>If you connect your calendar</strong> (Google or Outlook): the appointments needed to book.</li>
  </ul>
  <p><strong>Sensitive information:</strong> we don't ask you for sensitive information (health, religion, ethnic origin, sexual orientation, etc.). If your customers write it in their messages, it is stored as part of the conversation and is your business's responsibility.</p>

  <h2>How we use it</h2>
  <ul>
    <li>Creating and managing your account, and confirming that it's you.</li>
    <li>Providing the service: answering messages, preparing quotes, booking appointments and letting you know when a customer needs a person.</li>
    <li>Charging for your plan.</li>
    <li>Giving you support and letting you know about changes to the service, your plan or your payments.</li>
    <li>Keeping the service secure and preventing fraud and abuse (including keeping the free trial to one per person).</li>
    <li>Complying with the law.</li>
  </ul>
  <p>We don't use your information for anything else: no advertising, no marketing and no selling it. If we ever wanted to, we would ask you first.</p>

  <h2>Who we share it with</h2>
  <p>To provide the service we rely on providers that handle information on our behalf and only for that purpose (hosting, artificial intelligence, social media, email and payments). The full list is in <a href="/data-protection#providers">Data protection</a>. We also share information when a law or a competent authority requires it.</p>
  <p><strong>We don't sell your personal information and we don't share it for targeted (cross-context behavioral) advertising.</strong></p>

  <h2 id="rights">Your privacy rights</h2>
  <p>Depending on the state where you live (for example, California, Colorado, Connecticut, Virginia, Texas and others with privacy laws), you may have the right to:</p>
  <ul>
    <li><strong>Know and access</strong> the personal information we have about you, and get a copy you can take elsewhere.</li>
    <li><strong>Correct</strong> information that is wrong.</li>
    <li><strong>Delete</strong> your information.</li>
    <li><strong>Opt out</strong> of the sale of your information, its use for targeted advertising and profiling. We don't do any of these, so there is nothing to opt out of.</li>
    <li><strong>Not be treated differently</strong> for using any of these rights.</li>
  </ul>
  <p>There are two ways to use them:</p>
  <ul>
    <li><strong>From your dashboard, right away:</strong> in <em>My plan and payments → Your details</em> you download all your data or delete your account; you correct your profile details in <em>My profile</em>.</li>
    <li><strong>By email:</strong> write to <strong>${r.contact}</strong> with your name, your account email and what you want us to do. We may ask you for information to confirm your identity. An authorized agent can make the request for you with your written permission. We reply within 45 days; if we need more time we'll tell you why, and it won't be more than another 45 days.</li>
  </ul>
  <p>If we turn down your request, you can appeal by replying to our answer; we'll respond within 60 days, and if you disagree you can contact your state attorney general.</p>
  <p>If you are a customer of a business that uses this service, send your request to that business; we help it handle it.</p>

  <h2>Cookies and similar technologies</h2>
  <p>We only use necessary cookies: to keep you signed in, remember your language, remember a trusted device for two-step verification and complete the Google sign-in. Cloudflare's captcha may use its own on forms. The chat on businesses' websites stores an identifier in your browser to continue the conversation. We don't use advertising or third-party analytics cookies. You can delete them from your browser; if you do, you'll have to sign in again.</p>

  <h2>How long we keep it</h2>
  <p>${esc(retentionText())}</p>
  <p><strong>One free trial per person:</strong> so nobody repeats the trial, we keep for 2 years an irreversible fingerprint (not the data itself) of your email, your Google account and your card. It can't be used to find out your email or card, only to recognize them if they are used again for another trial. Deleting your account doesn't delete that fingerprint early.</p>

  <h2>How we protect it</h2>
  <p>Encrypted connections, passwords stored irreversibly, two-step verification, separation between accounts, encryption of stored keys and credentials, encrypted backups and access logs. If a security breach affects your information, we'll let you know without delay by email, with what happened and what you can do.</p>

  <h2>Children</h2>
  <p>The service is for businesses and is not directed to children. We don't knowingly collect information from children under 13 (or under 16 where state law says so). If you think a child gave us information, write to us and we'll delete it.</p>

  <h2>Where your information is processed</h2>
  <p>We are based in Mexico, and our providers process information in the United States, Mexico and other countries where they operate. When we move information between countries, we protect it as this policy describes.</p>

  <h2>Changes to this policy</h2>
  <p>We'll post any change here, with its date, and if it's important we'll let you know by email or in your dashboard.</p>

  <h2>Contact</h2>
  <p>Questions or requests about privacy: <strong>${r.contact}</strong>.</p>`;
}

export function dataProtectionEn(r: ResponsibleEn): string {
  return `<h1>Data protection</h1>
  <p class="muted">How we take care of your business's customers' information. Last updated: ${esc(updated())}.</p>

  <h2>Who decides and who handles it</h2>
  <p>The people who write to your business are <strong>your customers</strong>: your business controls their information and decides what it is used for. ${r.company} is your <strong>service provider</strong>: it handles that information only on your behalf and to provide the service. We commit to:</p>
  <ul>
    <li>Using it only for what you set up: answering, quoting, booking, charging and notifying you.</li>
    <li>Not using it for our own purposes, not selling it and not sharing it except with the providers below or when the law requires it.</li>
    <li>Keeping it confidential and limiting access to those who need it to give you support.</li>
    <li>Helping you handle your customers' privacy requests.</li>
    <li>Deleting it when you ask or when your account ends, except what the law requires us to keep.</li>
  </ul>

  <h2>What you can do from your dashboard</h2>
  <ul>
    <li><strong>Give a customer their information:</strong> in their conversation, "This customer's privacy" downloads everything we store about them.</li>
    <li><strong>Delete a customer's information:</strong> right there, "Delete all their data" removes their conversations, messages and files (quotes stay without their details).</li>
    <li><strong>How long to keep information:</strong> in the privacy settings you choose after how many days messages and inactive contacts are deleted.</li>
    <li><strong>Unsubscribes:</strong> whoever replies STOP no longer gets campaigns or reminders.</li>
    <li><strong>Your whole account:</strong> in My plan and payments → Your details you download everything or delete your account.</li>
  </ul>

  <h2 id="providers">Providers that help us</h2>
  <p>These providers handle information on our behalf and only for what is listed. Some are in the United States and others outside it.</p>
  ${processorTable()}
  <p>WhatsApp, Facebook, Instagram, TikTok, email and the other channels are services of their own companies: messages go through them and they handle them under their own privacy policies.</p>

  <h2>How we protect it</h2>
  <ul>
    <li>Encrypted connections (HTTPS) and channel credentials stored encrypted.</li>
    <li>Each business sees only its own information; within the business, each person signs in with their own user, their role and, if they turn it on, two-step verification.</li>
    <li>Encrypted daily backups that renew themselves.</li>
    <li>A log of access and of sensitive actions (downloads, deletions, permission changes).</li>
    <li>We send the assistant only what it needs to reply, and its replies are checked so it doesn't make up prices, hours or links.</li>
  </ul>

  <h2>If something goes wrong</h2>
  <p>If a security breach affects your customers' information, we'll let you know without delay by email, with what happened, what information was affected and what we recommend, so you can notify your customers.</p>

  <h2>Your privacy notice for your customers</h2>
  <p>Your business should give its customers its own privacy notice. You can start from this text, change what's in brackets and publish it on your website or send it in the first message:</p>
  <blockquote>[Your business name], located at [your address], will use your name, your number or username and what you write to us to serve you, give you prices and quotes, book your appointments and charge you. To reply faster we use an automated assistant and technology providers that handle your information only on our behalf. We don't sell your information. To access, correct or delete your information, write to us at [your email]. Full notice: [link to your notice].</blockquote>
  <p>This text is a starting point, not legal advice: review it with your lawyer.</p>
  <p>Questions about privacy? Write to us at <strong>${r.contact}</strong> or read our <a href="/privacy">Privacy Policy</a>.</p>`;
}
