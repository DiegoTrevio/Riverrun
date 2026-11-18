# Idiomas del panel: español e inglés

El panel funciona en español y en inglés (para vender en Estados Unidos).

## Cómo elige el idioma cada persona

- Si la persona ya eligió uno, se usa ese (se guarda en su navegador).
- Si no, se usa el idioma de su navegador: inglés si lo tiene antes que el español; si no tiene ninguno de los dos, español.
- Se cambia en la pantalla de entrada (Español · English, abajo), en el menú de su cuenta (arriba a la derecha) y en **Mi perfil → Idioma**.
- En inglés las fechas, horas y números usan el formato de Estados Unidos (11/16/2026, 4:30 PM, 1,234.50).

## Cómo funciona por dentro

El código del panel sigue escrito en español. En inglés, `public/js/i18n.js` cambia cada texto que aparece en la pantalla por su traducción de `public/i18n/en.json`, antes de que el navegador lo pinte. La llave es el texto en español tal cual; `{0}`, `{1}`… son las partes que cambian (un nombre, un número):

```json
{
  "Guardar": "Save",
  "{0} días": "{0} days",
  "Te invitaron como {0}.": "You were invited as {0}."
}
```

- Lo que escribe la gente (mensajes de clientes, respuestas del asistente) va dentro de `translate="no"` y nunca se traduce.
- Los errores y avisos que manda el servidor también se traducen al mostrarse, con el mismo diccionario.
- Si el diccionario no carga, el panel sigue en español (nunca queda en blanco).

## Al agregar o cambiar un texto

`npm run check:frontend` y `npm test` fallan si un texto del panel (o un mensaje del servidor que el panel muestra) no tiene su traducción:

```bash
node scripts/i18n-strings.mjs            # dice qué falta
node scripts/i18n-strings.mjs --missing  # la lista completa en JSON, con dónde aparece cada texto
```

Agrega la traducción en `public/i18n/en.json` con las mismas partes `{0}`. Si un texto no se ve en la pantalla (un nombre interno, un selector), va en `scripts/i18n-ignore.json`.

`npm run test:english:ux` abre cada pantalla de cada rol en inglés en un navegador real y falla si quedó texto del panel en español, si algo no cabe en un teléfono o si hay fallas graves de accesibilidad.

## El asistente cuando contesta en inglés

El asistente contesta en el idioma de su personalidad (Agente → Personalidad → Idioma) y en el del cliente si le escribe en otro. La revisión que impide inventar (`src/engine/text.ts` y `src/engine/claims.ts`) entiende también las respuestas en inglés:

- Precios en dólares escritos de cualquier forma: `$165`, `165 dollars`, `15 bucks`, `1,200 USD`, `15 thousand dollars`. Los montos escritos con palabras (`one thousand five hundred dollars`) se piden con cifras.
- Fechas (`October 20, 2026`, `20th of October`) y cantidades con unidad (`3 nights`, `6 people`, `2 hours`) no cuentan como precio.
- Descuentos (`20% off`, `twenty percent`, `half price`), promociones (`buy one get one free`, `BOGO`, `2 for 1`, `three for the price of two`) y regalos (`free`, `complimentary`, `on the house`, `at no cost`, `we don't charge`) solo si están en la información del negocio.
- Lo que la respuesta niega (`we don't offer 3x2`, `parking isn't free`) no es una oferta; `don't miss our 30% off` o `20% off since we are not busy` sí lo son.
- Horas: `at 8`, `from 9 to 6`, `9 to 6`, `open at 9 and close at 6`, con las mismas reglas que en español.
- Afirmaciones como `we have a pool`, `we offer delivery` o `it includes breakfast` se revisan contra la información (si el agente tiene activada la verificación de afirmaciones).

Las pruebas están en `test/anti-invention-en.test.ts` y al final de `test/claims.test.ts`.

## Idioma con tus clientes (mensajes automáticos)

Cada negocio elige en **Ajustes → Idioma con tus clientes** si atiende en español (México) o en inglés (Estados Unidos). Es aparte del idioma del panel: una persona puede usar el panel en español y tener un negocio que atiende en inglés.

- **Lo que sale en ese idioma:** confirmación, recordatorios y cancelación de citas (también por correo, con el anticipo, y el correo para confirmar una reserva de la página), cancelación por anticipo no pagado, recordatorios de pago y sus textos «Paga aquí» y «Cómo pagar», los conceptos del plan de pagos de una cotización aceptada, la respuesta a la baja (en inglés solo STOP, UNSUBSCRIBE y STOP ALL, y START para volver: «cancel» o «yes» siguen siendo respuestas normales) y el consentimiento para promociones (I AGREE).
- **Formato:** en inglés, «Tuesday, November 17», «9:30 AM» y montos como `$1,650.00`; también en las variables `{{cita.fecha}}`, `{{cita.hora}}`, `{{cita.tipo}}`, `{{pago.monto}}`, `{{pago.vencimiento}}`, `{{saldo}}`, `{{proxima_cita.*}}` y `{{cotizacion.vigencia}}` de las reglas, flujos y plantillas.
- **Al cambiarlo:** los textos que siguen como venían de fábrica (en Ajustes y en cada asistente: idioma, mensajes de respaldo, de pase a persona, palabras para pedir a una persona, frases prohibidas) pasan al otro idioma. Lo que el negocio escribió a mano se queda igual. Los asistentes nuevos nacen en el idioma del negocio.
- **Cotizaciones:** el mensaje que acompaña la cotización y el desglose en el chat salen en el idioma del asistente (Agente → Personalidad → Idioma): «Here is your FINAL quote… including tax». La moneda la pone la lista de precios o la calculadora.

Las pruebas están en `test/business-language.test.ts`.

## Correos al equipo

Cada persona recibe sus correos en el idioma en que ve el panel (el que eligió o, si no eligió, el de su navegador): el panel lo guarda en la cookie `lang` y el servidor lo copia a la persona (`users.lang`) cuando abre el panel. Si dos personas comparten un navegador, gana el idioma de ese navegador. Quien se registra con el panel (o el navegador) en inglés queda en inglés desde el primer correo, y su negocio atiende en inglés.

- **Escritos en los dos idiomas:** confirmar el correo, restablecer la contraseña, cambio de correo, invitaciones (en el idioma de quien invita, porque quien recibe todavía no tiene cuenta), avisos de seguridad (con la hora del negocio), fin de la prueba, recordatorios para empezar y borrado de la cuenta.
- **Traducidos con el diccionario del panel** (`src/mail-language.ts`): los avisos que también salen en el panel (cobros, límites del plan, canales desconectados, integraciones, alertas de conversaciones). Se traducen renglón por renglón con `public/i18n/en.json` y las fechas pasan a «November 30, 2026». Un renglón que no está en el diccionario sale en español, así que todo aviso nuevo lleva su traducción (`node scripts/i18n-strings.mjs` también revisa los títulos y textos que se pasan a `tell(…)`).
- Los correos a clientes (citas, reservas) no se traducen así: ya salen en el idioma del negocio con sus clientes.

Las pruebas están en `test/mail-language.test.ts`.

## Precios y planes en dólares

La página de precios (`/precios`), el registro y Mi plan muestran los planes de cada idioma (`plansForLanguage` en `src/locale.ts`):

- **Quien entra en inglés** (cookie `lang` del panel o, si no eligió, su navegador) ve `/precios` en inglés y solo los planes en dólares, sin IVA y pagados con Stripe. En español ve los demás (en pesos, más IVA).
- **Mi plan** usa el idioma con el que el negocio atiende a sus clientes: un negocio en inglés ve los planes en dólares. El plan que ya tiene siempre aparece, aunque sea de la otra moneda.
- Si un idioma no tiene ningún plan de su moneda que se pueda pagar (por ejemplo, solo con Mercado Pago, que cobra en pesos), ve todos. Por eso, mientras el precio en dólares siga privado (`./riverrun plan-unico` sin `--usd-publico`, ver [plan único](plan-unico.md)), quien entra en inglés ve el plan en pesos con sus textos en inglés.
- La descripción del plan se escribe en español y en inglés sale con el diccionario del panel: si cambias la descripción, agrega su traducción a `public/i18n/en.json`.

Las pruebas están en `test/pricing.test.ts`.

## Chat web, página para reservar y páginas públicas

- **Chat web (`widget.js`) y página para reservar (`/reservar/…`):** las ven los clientes del negocio, así que van en el idioma con el que el negocio atiende a sus clientes (Ajustes → Idioma con tus clientes), no en el de quien visita. El servidor lo manda como `lang` (en `/webchat/:token/config` y en `/api/public/booking/:token`), y los días y horas de la página para reservar salen en ese idioma («Tuesday, November 17», «9:30 AM»). Los avisos del servidor (topes, captcha, enlace vencido) siguen escritos en español y cada página los cambia por su traducción: `ERRORS_EN` en `widget.js` y en `reservar.js`. Si agregas un aviso en `src/routes/booking.ts`, agrega también su traducción (`test/booking-page.test.ts` revisa que estén todos).
- **Estado del servicio (`/estado`), contacto (`/contacto`) y la confirmación para borrar la cuenta (`/borrar-cuenta`):** las ve el negocio, así que siguen el idioma de quien visita (el que eligió en el panel o el de su navegador), igual que `/precios`.

Las pruebas están en `test/channels.test.ts`, `test/booking-page.test.ts`, `test/owner-self-service.test.ts` y en `npm run test:public:ux` (el chat web en inglés en un navegador real).

## Lo que todavía está solo en español

- El PDF de la cotización, el correo a la persona que atiende una cita, el reporte de conversación por correo, las facturas (CFDI, solo México) y lo que ve el superadministrador.
- Las plantillas por giro de un asistente nuevo (saludo, preguntas, mensajes guardados): en inglés solo cambia lo de fábrica general.
- La ayuda (`ayuda.html`) y los avisos legales (siguiente fase, con Privacy Policy y Terms para Estados Unidos). Los enlaces del pie de las páginas públicas ya están en inglés, pero llevan a esas páginas en español.
