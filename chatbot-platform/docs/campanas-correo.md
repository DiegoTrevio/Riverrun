# Campañas por correo

Riverrun puede mandar campañas por correo a una base de clientes, contestar con el asistente lo que respondan y darles seguimiento. Todo usa el canal de correo por reenvío ([integraciones, sección 4](integraciones.md)) y las mismas campañas, segmentos, bajas y consentimiento que WhatsApp.

## 1. Cargar una base de correos

**Contactos → Importar contactos**, eligiendo el canal de correo:

- Un CSV con encabezados (coma o punto y coma). Obligatoria: `correo` (también se reconoce `email`). Opcionales: `nombre`, `telefono`, `etiquetas` (separadas por punto y coma, o por `|` si el archivo usa punto y coma) y una columna por cada dato de tus clientes.
- Hasta 5,000 filas por archivo. Los correos se guardan en minúsculas; uno inválido o repetido no se importa y el resumen dice en qué fila.
- **De dónde salió la base** (obligatorio): queda en cada contacto como «importación: …». Es tu constancia si alguien pregunta cómo obtuviste su correo.
- **«Estas personas aceptaron recibir correos de mi negocio»**: si la marcas, cada contacto nuevo queda con consentimiento (fecha de hoy y el origen). Si no, se importan sin él y, con **Ajustes → Consentimiento** activado (viene así), las campañas no les llegan hasta que acepten.
- Nunca se quita una baja ni se cambia un consentimiento que ya estaba. La **lista de bajas** es por negocio y por correo (tabla `email_suppressions`): quien se dio de baja, rebotó o se quejó de spam sigue fuera aunque venga en otro archivo o en otro canal de correo.
- Importar no dispara reglas ni manda correos.

No uses bases compradas o copiadas: los correos a gente que no te conoce terminan en spam, dañan la entrega del dominio y en México (LFPDPPP) y Estados Unidos (CAN-SPAM) puedes tener problemas.

## 2. Enviar una campaña

**Automatización → Campañas → Nueva campaña** y elige el canal de correo:

- **Asunto** y **mensaje** (los dos admiten variables como `{{nombre}}`). Por correo la campaña es un mensaje de texto: sin foto ni flujo.
- Los mismos segmentos que WhatsApp (etiquetas, actividad) y la misma revisión antes de enviar: cuántos destinatarios, cuántos quedan fuera por no haber aceptado y cuántos correos pueden salir hoy.
- Cada correo sale desde `<alias>@EMAIL_CAMPAIGN_DOMAIN` con el nombre del canal, y con **Reply-To** a la dirección de reenvío del canal (`<alias>@EMAIL_INBOUND_DOMAIN`).
- Al final lleva siempre el enlace de baja («Para dejar de recibir estos correos, date de baja aquí: …»), aunque en Ajustes se apague el pie de baja de WhatsApp. También lleva las cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post` (baja de un clic, que Gmail y Yahoo exigen a quien envía correos masivos).
- No sale a quien se dio de baja, rebotó o se quejó, ni (con consentimiento activado) a quien no aceptó.

### Baja

El enlace abre `/email/baja`: la página pide confirmar (los antivirus abren los enlaces y no deben dar de baja a nadie) y el botón da de baja. La baja de un clic del programa de correo (POST con `List-Unsubscribe=One-Click`) da de baja directo. La dirección queda en la lista de bajas del negocio. El enlace va firmado (SESSION_SECRET): no se puede armar uno para otra persona. La página sale en el idioma del negocio.

### Calentamiento y topes

Un dominio nuevo que manda miles de correos el primer día termina en spam. Por eso cada negocio tiene un tope diario que sube con los días en que ya envió: 50, 100, 200, 400, 700, 1,000, 1,500, 2,000, 3,000 y luego 5,000 (`EMAIL_CAMPAIGN_DAILY_MAX`). Lo que no cabe hoy sale al día siguiente, solo. Si en Ajustes hay un tope diario por número, se usa el menor. Las llamadas a Resend se espacian (`RESEND_API_PER_SECOND`, 2 por omisión) para no recibir errores por exceso.

### Rebotes y quejas

Resend avisa a `/email/resend` (el mismo webhook del canal de correo) con `email.bounced` y `email.complained`:

- **Rebote definitivo** (el buzón no existe) y **queja de spam**: la dirección pasa a la lista de bajas y el contacto queda dado de baja.
- **Rebote temporal** (buzón lleno, servidor caído): solo se anota; se intenta en la siguiente campaña.
- Se suman a las estadísticas de la campaña. Con 100 enviados o más, una campaña con más de 5 % de rebotes o más de 0.3 % de quejas **se detiene sola** y se avisa a los administradores. Son los límites que piden Gmail y Yahoo; pasarlos manda a spam los correos de todos.

## 3. Respuestas y seguimiento

- La respuesta del cliente llega a la dirección de reenvío del canal (y también si le contesta al remitente de la campaña): cae en **Conversaciones**, en la misma conversación donde está la campaña, y el asistente la contesta en el mismo hilo («Re: <asunto>») desde la dirección del canal, no desde el subdominio de campañas.
- Pasan por los mismos filtros que cualquier correo (remitente comprobado con DMARC, avisos automáticos, freno de bucles). Las respuestas a una campaña de los últimos 30 días tienen su propio tope por hora (600), aparte del tope normal del canal (60).
- **Seguimiento:** las reglas de Automatización con «El cliente no contesta» funcionan con las campañas: si el cliente no responde en el tiempo elegido, sale el seguimiento en el mismo hilo («Re: <asunto>»). A quien nunca ha escrito, el seguimiento le sale como correo de campaña: desde el subdominio de campañas y con su enlace de baja. Cuando exista la acción «Dar seguimiento con IA», úsala en esa misma regla para que el asistente escriba el seguimiento según la conversación.

## 4. Configuración del servidor (una vez, con el dominio)

1. Primero el correo por reenvío ([integraciones, sección 4](integraciones.md)): `EMAIL_INBOUND_DOMAIN`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`.
2. En resend.com → Domains, da de alta **otro** subdominio para envío, por ejemplo `envios.tudominio.com` (registros SPF y DKIM que te da Resend). Agrega también un registro DMARC al dominio (`_dmarc.tudominio.com`, por ejemplo `v=DMARC1; p=none; rua=mailto:dmarc@tudominio.com`). Si quieres que quien conteste al remitente de la campaña también llegue, activa la recepción (MX) en ese subdominio.
3. En resend.com → Webhooks, en el mismo webhook de `/email/resend`, marca además los eventos `email.bounced` y `email.complained`.
4. En el `.env`: `EMAIL_CAMPAIGN_DOMAIN=envios.tudominio.com` (y si quieres, `EMAIL_CAMPAIGN_DAILY_MAX` y `RESEND_API_PER_SECOND`). Luego `./riverrun update`.
5. `./riverrun preflight` avisa si falta algo o si el subdominio de campañas es el mismo que el de respuestas.

Mientras no exista el dominio todo está probado con simulaciones (`test/email-import.test.ts` y `test/email-campaigns.test.ts`); falta la prueba con Resend real.
