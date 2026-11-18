/**
 * Avisos de seguridad por correo: cuando cambia la contraseña o la verificación en dos pasos, o alguien entra desde un
 * dispositivo nuevo, la persona se entera aunque no haya sido ella. Texto sin enlaces (nada con token que reenviar) y
 * siempre con qué hacer si no fue ella. Nunca lanza: un correo que falla no debe romper el inicio de sesión.
 */
import { recordSecurity } from '../security-log.js';
import { mailBrand } from '../brands.js';
import { logEvent } from '../logs.js';
import { deliverMail } from '../mailer.js';
import { recipientLang } from '../mail-language.js';
import { queryOne } from '../db.js';

export type NoticeKind =
  | 'password_changed'
  | 'password_reset'
  | 'mfa_enabled'
  | 'mfa_changed'
  | 'mfa_reset'
  | 'recovery_used'
  | 'recovery_regenerated'
  | 'mfa_locked'
  | 'new_device'
  | 'ownership_transferred'
  | 'ownership_received'
  | 'email_changed'
  | 'role_changed'
  | 'retention_scheduled';

interface NoticeUser { id: string; email: string; name: string; account_id: string | null }
interface NoticeDetails { device?: string; ip?: string; remaining?: number; by?: string; account?: string; to?: string; from?: string; role?: string; detail?: string; on?: string }

const FOOTER = 'Si no fuiste tú: cambia tu contraseña y cierra todas las sesiones desde Mi perfil.';

/** Solo una parte de la IP: suficiente para reconocerla, sin mostrarla completa. */
export function partialIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:…`;
  return ip.includes('.') ? `${ip.split('.').slice(0, 2).join('.')}.…` : ip;
}

const SUBJECT: Record<NoticeKind, string> = {
  password_changed: 'Tu contraseña cambió',
  password_reset: 'Restableciste tu contraseña',
  mfa_enabled: 'Activaste la verificación en dos pasos',
  mfa_changed: 'Cambiaste tu app de verificación',
  mfa_reset: 'Se restableció tu verificación en dos pasos',
  recovery_used: 'Usaste un código de recuperación',
  recovery_regenerated: 'Generaste códigos de recuperación nuevos',
  mfa_locked: 'Bloqueamos tu verificación por intentos fallidos',
  new_device: 'Nuevo inicio de sesión en tu cuenta',
  ownership_transferred: 'Transferiste tu cuenta',
  ownership_received: 'Ahora eres dueño de la cuenta',
  email_changed: 'Cambiaste tu correo',
  role_changed: 'Tu rol cambió',
  retention_scheduled: 'Se programó el borrado automático de datos',
};

const FOOTER_EN = "If it wasn't you: change your password and sign out of all sessions from My profile.";

const SUBJECT_EN: Record<NoticeKind, string> = {
  password_changed: 'Your password changed',
  password_reset: 'You reset your password',
  mfa_enabled: 'You turned on two-step verification',
  mfa_changed: 'You changed your authenticator app',
  mfa_reset: 'Your two-step verification was reset',
  recovery_used: 'You used a recovery code',
  recovery_regenerated: 'You generated new recovery codes',
  mfa_locked: 'We locked your verification after failed attempts',
  new_device: 'New sign-in to your account',
  ownership_transferred: 'You transferred your account',
  ownership_received: 'You are now the account owner',
  email_changed: 'You changed your email',
  role_changed: 'Your role changed',
  retention_scheduled: 'Automatic data deletion was scheduled',
};

const ROLE_EN: Record<string, string> = { administrador: 'admin', agente: 'agent' };

function bodyEn(kind: NoticeKind, when: string, d: NoticeDetails): string {
  switch (kind) {
    case 'password_changed': return `The password of your account changed on ${when}. Your other sessions were signed out.`;
    case 'password_reset': return `You reset the password of your account on ${when} with the link we emailed you. All your sessions were signed out.`;
    case 'mfa_enabled': return `You turned on two-step verification on ${when}. From now on, signing in asks for the code from your app.`;
    case 'mfa_changed': return `You changed the authenticator app of your account on ${when}. The previous app no longer works for signing in.`;
    case 'mfa_reset': return `${d.by ? `${d.by} reset` : 'Someone reset'} the two-step verification of your account on ${when}. Your sessions were signed out; you'll set it up again the next time you sign in.`;
    case 'recovery_used': return `You signed in with a recovery code on ${when}. You have ${d.remaining ?? 0} codes left. If you lost your phone, set up your app again from My profile.`;
    case 'recovery_regenerated': return `You generated new recovery codes on ${when}. The previous ones no longer work.`;
    case 'mfa_locked': return `Someone typed your password correctly but got the code wrong many times (${when}). We locked verification for one hour. Change your password: someone knows it.`;
    case 'new_device': return `Someone signed in to your account on ${when} from a new device: ${d.device || 'a browser'}${d.ip ? ` (IP ${partialIp(d.ip)})` : ''}.`;
    case 'ownership_transferred': return `${d.by ? `${d.by} transferred` : 'You transferred'} the account “${d.account}” to ${d.to} on ${when}. You remain an admin.`;
    case 'ownership_received': return `${d.from} transferred the account “${d.account}” to you on ${when}. Check the billing details in My plan.`;
    case 'email_changed': return `The email of your account changed to ${d.to} on ${when} (requested with your password). From now on you sign in with that email; if it wasn't you, sign in with it and put yours back from My profile.`;
    case 'retention_scheduled': return `${d.by ? `${d.by} scheduled` : 'Someone scheduled'} automatic deletion of ${d.detail} from your account, starting ${d.on}. Deleted data can't be recovered. If it wasn't your decision, change it in Settings → Privacy before that date.`;
    case 'role_changed': return `${d.by ? `${d.by} changed` : 'Someone changed'} your role to ${ROLE_EN[d.role ?? ''] ?? d.role} on ${when}. You'll have the new permissions the next time you sign in.`;
  }
}

/** La zona horaria del negocio (para la hora del aviso en inglés); sin cuenta, la de México. */
async function zoneOf(accountId: string | null) {
  if (!accountId) return 'America/Mexico_City';
  const row = await queryOne<{ tz: string | null }>(`SELECT settings->>'timezone' AS tz FROM accounts WHERE id = $1`, [accountId]).catch(() => null);
  return row?.tz || 'America/Mexico_City';
}

function body(kind: NoticeKind, when: string, d: NoticeDetails): string {
  switch (kind) {
    case 'password_changed': return `La contraseña de tu cuenta cambió el ${when}. Se cerraron tus otras sesiones.`;
    case 'password_reset': return `Restableciste la contraseña de tu cuenta el ${when} con el enlace que te mandamos por correo. Se cerraron todas tus sesiones.`;
    case 'mfa_enabled': return `Activaste la verificación en dos pasos el ${when}. Desde ahora, al entrar te pedimos el código de tu app.`;
    case 'mfa_changed': return `Cambiaste la app de verificación de tu cuenta el ${when}. La app anterior ya no sirve para entrar.`;
    case 'mfa_reset': return `${d.by ? `${d.by} restableció` : 'Se restableció'} la verificación en dos pasos de tu cuenta el ${when}. Se cerraron tus sesiones; la configuras otra vez la próxima vez que entres.`;
    case 'recovery_used': return `Entraste con un código de recuperación el ${when}. Te quedan ${d.remaining ?? 0} códigos. Si perdiste tu teléfono, configura tu app otra vez desde Mi perfil.`;
    case 'recovery_regenerated': return `Generaste códigos de recuperación nuevos el ${when}. Los anteriores ya no sirven.`;
    case 'mfa_locked': return `Alguien escribió bien tu contraseña pero se equivocó muchas veces con el código (${when}). Bloqueamos la verificación una hora. Cambia tu contraseña: alguien la conoce.`;
    case 'new_device': return `Alguien entró a tu cuenta el ${when} desde un dispositivo nuevo: ${d.device || 'un navegador'}${d.ip ? ` (IP ${partialIp(d.ip)})` : ''}.`;
    // `by`: cuando la reasigna el superadministrador y no el dueño.
    case 'ownership_transferred': return `${d.by ? `${d.by} transfirió` : 'Transferiste'} la cuenta «${d.account}» a ${d.to} el ${when}. Sigues como administrador.`;
    case 'ownership_received': return `${d.from} te transfirió la cuenta «${d.account}» el ${when}. Revisa los datos de facturación en Mi plan.`;
    // A la dirección anterior: `to` es la nueva.
    case 'email_changed': return `El correo de tu cuenta cambió a ${d.to} el ${when} (se pidió con tu contraseña). Desde ahora entras con ese correo; si no fuiste tú, entra con él y vuelve a poner el tuyo desde Mi perfil.`;
    case 'retention_scheduled': return `${d.by ? `${d.by} programó` : 'Se programó'} que se borren automáticamente ${d.detail} de tu cuenta, a partir del ${d.on}. Lo borrado no se recupera. Si no fue tu decisión, cámbialo en Ajustes → Privacidad antes de esa fecha.`;
    case 'role_changed': return `${d.by ? `${d.by} cambió` : 'Cambió'} tu rol a ${d.role} el ${when}. Al entrar otra vez tienes los permisos nuevos.`;
  }
}

export async function notifyUser(user: NoticeUser, kind: NoticeKind, details: NoticeDetails = {}): Promise<void> {
  // Etapa 7: cada aviso de seguridad también queda en la bitácora de seguridad (aunque el correo falle).
  const { device, ip, ...rest } = details;
  await recordSecurity({ kind: `notice.${kind}`, accountId: user.account_id, userId: user.id, email: user.email, ip, userAgent: device, details: rest });
  try {
    const en = (await recipientLang(user.email)) === 'en';
    const when = en
      ? new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: await zoneOf(user.account_id) }).format(new Date())
      : new Intl.DateTimeFormat('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' }).format(new Date());
    const { fromName } = await mailBrand(user.account_id);
    const result = await deliverMail({
      to: user.email,
      fromName,
      lang: 'as-is',
      subject: en ? SUBJECT_EN[kind] : SUBJECT[kind],
      text: en ? `Hi ${user.name || ''},\n\n${bodyEn(kind, when, details)}\n\n${FOOTER_EN}\n` : `Hola ${user.name || ''},\n\n${body(kind, when, details)}\n\n${FOOTER}\n`,
    });
    if (result === 'failed') await logEvent({ level: 'warn', source: 'system', message: `No se pudo mandar el aviso de seguridad «${SUBJECT[kind]}»`, accountId: user.account_id ?? undefined });
  } catch (e: any) {
    await logEvent({ level: 'warn', source: 'system', message: `Aviso de seguridad «${SUBJECT[kind]}»: ${e?.message ?? e}`, accountId: user.account_id ?? undefined }).catch(() => undefined);
  }
}
