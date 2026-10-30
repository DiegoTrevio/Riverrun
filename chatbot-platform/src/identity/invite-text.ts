/**
 * El texto del correo de invitación es fijo: lo único que pone quien invita son nombres (el suyo, el de la persona y el
 * de la cuenta), y van limpios y entre comillas «». Así nadie puede usar la invitación para mandar a otro correo un
 * mensaje o un enlace suyo con la marca de la plataforma.
 */

const MAX_NAME = 60;

/** Sin saltos ni caracteres de control, sin enlaces ni dominios, con los espacios juntos y a lo más 60 caracteres. */
export function cleanInviteName(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

export function inviteMail(o: { inviter: string; invitee: string; account: string; role: string; link: string; google: boolean }): { subject: string; text: string } {
  const inviter = cleanInviteName(o.inviter);
  const invitee = cleanInviteName(o.invitee);
  const account = cleanInviteName(o.account);
  const who = inviter ? `«${inviter}»` : 'Tu equipo';
  return {
    subject: account ? `${who} te invitó a «${account}»` : `${who} te invitó a su equipo`,
    text:
      `Hola${invitee ? ` «${invitee}»` : ''},\n\n` +
      `${who} te invitó a unirte${account ? ` a «${account}»` : ''} como ${o.role}. Para aceptar, abre este enlace y elige tu contraseña:\n\n` +
      `${o.link}\n\n` +
      `El enlace vence en 7 días.${o.google ? ' Si tu correo es de Google, también puedes entrar con Google.' : ''}\n\n` +
      'Si no esperabas esta invitación, ignora este mensaje.',
  };
}
