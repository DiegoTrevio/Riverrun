-- ID-18: una app de 2FA configurada al registrarse con el correo sin verificar se marcaba como configurada por correo
-- (totp_email_confirmed), así que restablecer la contraseña por correo no la quitaba. Desde ID-18 el registro sin verificar
-- ya no la marca; esto corrige las que quedaron: si el correo nunca se verificó, nadie probó que es de quien configuró la
-- app. La invitación, Google y el registro verificado ponen email_verified_at, así que esas no cambian. Restablecer la
-- contraseña por correo de una de estas cuentas quita la app y pide configurarla otra vez.
UPDATE users SET totp_email_confirmed = false
 WHERE totp_enabled_at IS NOT NULL AND email_verified_at IS NULL AND totp_email_confirmed;
