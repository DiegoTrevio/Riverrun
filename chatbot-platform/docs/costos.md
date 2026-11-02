# Costos de operar la plataforma

Todo lo que cuesta dinero al correr Riverrun: Zernio, la IA, WhatsApp oficial, el servidor y lo demás. Precios en USD
sin IVA, consultados el **2 de noviembre de 2026**. Cambian seguido: antes de fijar el precio de un plan, confirma los
marcados con *(verificar)* en la página del proveedor (al final, las fuentes).

Los números reales de tu instalación ya están en el panel:

- **Consumo de IA**: gasto por cuenta, por día, por tipo y **costo promedio por conversación** (lo que cobró OpenRouter).
- **Sistema → Zernio**: costo estimado de Zernio del mes (cuentas conectadas y mensajes salientes).

Lo de abajo sirve para planear antes de tener tráfico, y para lo que el panel no cuenta (WhatsApp oficial de Meta, X).

## Resumen

| Servicio | Para qué | Tipo de costo | Cuánto |
|---|---|---|---|
| **Zernio** | Redes sociales (mensajes, comentarios, publicaciones, estadísticas) y WhatsApp oficial | Por cuenta conectada | 2 gratis en toda la plataforma; luego 6, 3 o 1 USD al mes por cuenta |
| **Zernio (mensajes)** | Mensajes directos que salen por Zernio | Por mensaje | 10 000 al mes gratis; luego 1 USD por cada 10 000 |
| **OpenRouter (IA)** | Respuestas, resúmenes, notas de voz, fotos y PDF, Copiloto, búsqueda semántica | Por uso | ~0.002–0.004 USD por respuesta con `gpt-4.1-mini`; + 5.5 % al comprar créditos |
| **Meta (WhatsApp oficial)** | Números conectados por Zernio | Por mensaje entregado | Desde el 1 oct 2026: 1 000 respuestas gratis al mes por número; luego ~0.0085 USD c/u *(verificar)* |
| **X (por Zernio)** | Mensajes, comentarios y publicaciones en X | Por llamada a la API de X | ~0.005–0.015 USD por operación *(verificar)* |
| **Servidor (VPS)** | Todo lo demás corre ahí | Fijo | ~10–50 USD al mes |
| **Stripe / Mercado Pago** | Cobrar los planes | % de cada cobro | ~3.6 % + 3 MXN (Stripe) / ~3.49 % (Mercado Pago), + IVA *(verificar)* |
| Correo (Resend), dominio, respaldos | Avisos, HTTPS, copias | Fijo, bajo | 0–20 USD al mes en total |
| Facturapi (CFDI) | Facturas | Según su plan | No pude confirmar su precio *(verificar)* |

Gratis: Evolution API (WhatsApp con QR), PostgreSQL, Redis, Caddy y Let's Encrypt, LibreOffice (PDF de cotizaciones),
Telegram, Messenger e Instagram con la app de Meta propia, Google Calendar y Outlook, Cloudflare Turnstile y la consulta
de contraseñas filtradas (Have I Been Pwned).

## Zernio

Una sola llave para toda la plataforma (`docs/zernio.md`); **todo lo cobra Zernio a esa llave**, es decir, a ti.

**Cuentas conectadas** (cada red de cada negocio es una cuenta; se cobra por día, prorrateado):

| Cuenta número | Precio al mes por cuenta |
|---|---|
| 1–2 | Gratis |
| 3–10 | 6 USD |
| 11–100 | 3 USD |
| 101–2000 | 1 USD |
| Más de 2000 | A negociar |

Ejemplos del total al mes:

| Cuentas conectadas en la plataforma | Zernio al mes | Promedio por cuenta |
|---|---|---|
| 2 | 0 USD | 0 |
| 10 | 48 USD | 4.80 |
| 30 (10 negocios × 3 redes) | 108 USD | 3.60 |
| 60 (20 negocios × 3 redes) | 198 USD | 3.30 |
| 100 | 318 USD | 3.18 |
| 300 | 518 USD | 1.73 |

**Mensajes salientes:** desde el 1 de octubre de 2026 Zernio mide los mensajes directos que salen por cualquier red
(incluidas las difusiones de WhatsApp): 10 000 al mes gratis y luego 0.0001 USD por mensaje (50 000 = 4 USD;
250 000 = 24 USD). Los mensajes recibidos y las respuestas a comentarios y reseñas no cuentan. Es un costo menor.

**Bandeja (Inbox), estadísticas y anuncios:** Zernio dice que ya vienen incluidos en cada cuenta, sin complementos
aparte. `docs/zernio.md` y los mensajes del panel todavía los llaman «complemento de pago»: eso era el modelo anterior.
Si tu cuenta de Zernio es de un plan viejo (o de AppSumo), revisa en su panel si los tiene.

**Qué controla el gasto en la plataforma:**

- Cada plan limita cuántas redes conecta un negocio (`social_accounts`; en la prueba, `TRIAL_MAX_SOCIAL_ACCOUNTS=2`). Una
  red que no cabe se quita de Zernio en el momento.
- Al desconectar o borrar un negocio, sus redes se quitan de Zernio (`zernio_cleanup`), para no seguir pagando.
- **Perfiles sin dueño** (Sistema → Zernio): revisa que no haya cuentas conectadas a perfiles de negocios borrados.

## IA (OpenRouter)

Todas las llamadas a la IA pasan por OpenRouter. Cada una se reserva y se cobra del presupuesto de la cuenta que la
generó (`src/ai/budget.ts`); el costo es el que informa OpenRouter.

**Precios de los modelos configurados** (USD por millón de tokens, catálogo de OpenRouter):

| Uso | Variable | Modelo por omisión | Entrada | Salida |
|---|---|---|---|---|
| Respuestas del agente | `OPENROUTER_MODEL` | `openai/gpt-4.1-mini` | 0.40 (0.10 en caché) | 1.60 |
| Resúmenes y juez del modo estricto | `OPENROUTER_SUMMARY_MODEL` | `openai/gpt-4.1-mini` | 0.40 | 1.60 |
| Notas de voz, fotos y PDF | `OPENROUTER_TRANSCRIPTION_MODEL`, `OPENROUTER_MEDIA_MODEL` | `google/gemini-2.5-flash` | 0.30 (texto e imagen), 1.00 (audio) | 2.50 |
| Respaldo si falla el principal | `OPENROUTER_FALLBACK_MODELS` | `google/gemini-2.5-flash` | 0.30 | 2.50 |
| Copiloto del panel | `OPENROUTER_COPILOT_MODEL` | `deepseek/deepseek-v4.1-flash-1017` | 0.044 | 0.383 |
| Búsqueda semántica (si se activa) | `OPENROUTER_EMBEDDING_MODEL` | `openai/text-embedding-3-small` | 0.02 | — |

**Cuánto cuesta una respuesta** (estimado, no medido en producción):

- Entrada: instrucciones del agente (~2 000 tokens) + conocimiento (hasta `knowledge_char_budget`, 24 000 caracteres ≈
  6 000 tokens) + historial reciente (~1 000) → de ~3 000 tokens (negocio con poca información) a ~9 000.
- Salida: ~300 tokens.
- Con `gpt-4.1-mini`: de **~0.002 a ~0.004 USD por respuesta**. La parte fija (instrucciones y conocimiento) suele ir en
  caché a la cuarta parte del precio, así que lo normal está más cerca de lo bajo.
- Se suma cuando el validador pide corregir una respuesta (otra llamada) y, en el modo estricto, el juez de cada
  respuesta.
- Una conversación de ~5 respuestas: **~0.01–0.02 USD**. 1 000 conversaciones al mes: **~10–20 USD**.

**Otros usos:** una nota de voz cuesta ~0.002 USD por minuto; una foto o un PDF, ~0.001 USD; un pedido al Copiloto,
~0.003 USD (`docs/copiloto.md`); los embeddings, casi nada.

**OpenRouter cobra 5.5 % al comprar créditos** con tarjeta (mínimo 0.80 USD por compra): 100 USD de créditos cuestan
105.50. Compra montos grandes para que el mínimo no pese.

**Topes que ya protegen el gasto** (`.env`):

| Variable | Por omisión | Qué hace |
|---|---|---|
| `PLAN_DEFAULT_AI_USD` | 20 | Gasto de IA al mes de un plan que no trae el suyo. Al llegar, el agente deja de usar la IA. |
| `TRIAL_AI_USD` | 5 | Lo mismo para una cuenta en prueba. |
| `COPILOT_ACCOUNT_USD_PER_DAY` | 3 | Tope del Copiloto por cuenta en 24 h. |
| `AI_ALERT_USD_PER_ACCOUNT` | 20 | Te avisa (sin bloquear) cuando una cuenta lo pasa en el mes. |
| `KNOWLEDGE_ALERT_HOURLY_USD` | 5 | Aviso de gasto alto de la búsqueda semántica. |

Así, **lo máximo que una cuenta te puede costar en IA al mes es el tope de su plan**. Con 20 USD alcanzan ~1 000–2 000
conversaciones.

**Pruebas en GitHub:** el flujo semanal *Chatbot live quality* llama a OpenRouter con tope de 1 USD por corrida (si
`RIVERRUN_LIVE_EVAL_ENABLED` está encendido): hasta ~4 USD al mes.

## WhatsApp

Hay dos caminos, con costos muy distintos:

| | WhatsApp con QR (Evolution) | WhatsApp oficial (por Zernio) |
|---|---|---|
| Costo por mensaje | 0 | Lo cobra Meta (abajo) |
| Costo en Zernio | 0 | Cuenta conectada + mensajes salientes |
| Riesgo | Meta puede bloquear el número (no es oficial) | Ninguno de ese tipo |

**Meta, desde el 1 de octubre de 2026** *(verificar en la tabla de Meta)*: las respuestas dentro de la ventana de 24 h
**dejaron de ser gratis**. Cada número tiene **1 000 mensajes de servicio gratis al mes** (no se acumulan); después,
cada mensaje cuesta lo mismo que uno de utilidad. Precios para México:

| Mensaje | USD por mensaje entregado |
|---|---|
| Servicio (respuesta dentro de 24 h), después de los 1 000 gratis | ~0.0085 |
| Plantilla de utilidad (avisos, recordatorios de cobro, seguimiento) | ~0.0085 |
| Plantilla de autenticación | ~0.0085 |
| Plantilla de marketing (promociones, campañas) | ~0.0397 (subió ~30 % el 1 oct 2026) |

Utilidad y autenticación bajan con volumen alto; marketing no.

Ejemplo: un negocio con 1 000 conversaciones de ~5 respuestas manda 5 000 mensajes; 4 000 pasan los gratis → **~34 USD
al mes de Meta**, más que su IA. Sus recordatorios de **Cobros** y las campañas fuera de 24 h son plantillas y se suman.

**Quién lo paga:** Meta lo cobra a la cuenta de WhatsApp Business (WABA) de cada número, con el método de pago que tenga
esa cuenta; Zernio no lo cobra ni le pone margen. En el alta por Zernio la WABA queda a nombre del negocio, así que lo
normal es que lo pague el negocio con su tarjeta en Meta *(verificar en una alta real)*. Si la WABA no tiene método de
pago, Meta puede dejar de entregar los mensajes. Este costo **no aparece** en el estimado de Sistema → Zernio.

## X (Twitter) por Zernio

Zernio no cobra margen por X, pero pasa el precio de la API de X por cada operación: ~0.010 USD por mensaje directo,
~0.015 USD por publicación creada, ~0.005 USD por lectura *(verificar en docs.x.com)*. En la plataforma eso incluye
los mensajes, las respuestas a comentarios, la revisión diaria de comentarios y las estadísticas de cada cuenta de X.
Solo cuesta si hay cuentas de X conectadas. **Pon un tope de gasto de X en el panel de Zernio.** Tampoco aparece en el
estimado de Sistema → Zernio.

## Servidor y lo fijo

| Concepto | Costo al mes | Nota |
|---|---|---|
| VPS | ~10–50 USD | Para empezar alcanzan 2 GB; para producción el README recomienda 4 vCPU / 8 GB (cada WhatsApp con QR vive en Evolution y usa memoria). Hetzner subió precios en 2026: CX33 (4 vCPU / 8 GB) ~8.49 EUR, CPX22 ~19.49 EUR, con poca disponibilidad; DigitalOcean 2 vCPU / 4 GB ~24 USD. |
| Dominio | ~1–2 USD | ~10–20 USD al año. HTTPS (Caddy + Let's Encrypt) es gratis. |
| Respaldos en la nube (`BACKUP_S3_*`) | < 1 USD | Backblaze B2 ~6.95 USD por TB al mes; los respaldos pesan poco. |
| Correo (Resend) | 0–20 USD | Gratis hasta 3 000 correos al mes (100 al día); Pro 20 USD por 50 000. |
| Monitoreo (`HEARTBEAT_URL`, `ALERT_WEBHOOK_URL`) | 0 | healthchecks.io y ntfy tienen planes gratis. |
| GitHub (CI) | 0 | Dentro de los minutos gratis mientras no se pasen. |

## Cobrar a tus clientes

| Concepto | Costo |
|---|---|
| Stripe (tarjeta mexicana) | ~3.6 % + 3 MXN por cobro, + IVA sobre la comisión; +0.5 % tarjeta extranjera; +2 % si hay cambio de moneda *(verificar)* |
| Mercado Pago | ~3.49 % + IVA por cobro; varía con el plazo en que liberas el dinero *(verificar)* |
| Facturapi (CFDI 4.0) | Según tu plan en facturapi.io; no pude confirmar el precio vigente *(verificar)* |

El IVA que cobras (`BILLING_TAX_PERCENT`) no es costo: se entera al SAT.

## Ejemplo: 20 negocios

Supuestos: cada negocio con 3 redes en Zernio, 1 000 conversaciones al mes y WhatsApp con QR.

| Concepto | Al mes |
|---|---|
| Zernio: 60 cuentas | 198 USD |
| Zernio: ~20 000 mensajes salientes | ~1 USD |
| IA: 20 × 10–20 USD, + 5.5 % de OpenRouter | ~211–422 USD |
| VPS (8 GB) | ~25 USD |
| Dominio, respaldos, correo | ~2 USD |
| **Total** | **~437–648 USD (~22–32 USD por negocio)** |

Si esos 20 negocios usaran WhatsApp oficial en lugar del QR: + ~34 USD por negocio de Meta (normalmente lo paga cada
negocio en su WABA) y + 20 cuentas en Zernio (+60 USD).

**Piso de costo por negocio** (para fijar precios): ~3–6 USD de Zernio por red conectada + el tope de IA de su plan
(20 USD por omisión) + la comisión del cobro. Un plan por debajo de ~30 USD al mes + IVA con 3 redes y 20 USD de IA
pierde dinero con un negocio que lo use todo.

## Escenario: todo con Evolution (sin Zernio)

WhatsApp con QR (Evolution), Messenger e Instagram con la app de Meta propia (`META_APP_ID`), Telegram, chat web y
correo. Ninguno pasa por Zernio, así que **Zernio cuesta 0** y Meta no cobra nada por mensaje. Zernio solo hace falta
para X, Bluesky, Reddit, LinkedIn, TikTok, YouTube, Threads, Pinterest y Google, o para comentarios, publicaciones y
estadísticas de redes.

| Concepto | Al mes | Nota |
|---|---|---|
| IA (OpenRouter) | ~0.01–0.02 USD por conversación, + 5.5 % | Lo único que crece con el uso. Con tope por plan (`PLAN_DEFAULT_AI_USD`, 20 USD). |
| VPS | ~6–100 USD | Según cuántos números de WhatsApp (tabla abajo). |
| Dominio, respaldos, monitoreo | ~2 USD | |
| Correo (Resend) | 0–20 USD | Gratis hasta 3 000 correos al mes. |
| Zernio | 0 | Sin redes conectadas por Zernio. |
| Meta (por mensaje) | 0 | Campañas, recordatorios, cobros y respuestas de varias burbujas no cuestan, a cualquier hora. |
| Stripe / Mercado Pago | ~3.6 % + 3 MXN / ~3.49 %, + IVA | Por cada cobro a tus clientes. |
| Facturapi | Según su plan | *(verificar)* |

**Servidor según los números conectados.** Cada número es una sesión dentro de Evolution y ocupa memoria. No está medido
en Riverrun (`docs/produccion.md`); guías de terceros hablan de ~200–500 MB por número con la versión de Node. Calcula
~2 GB para lo demás (PostgreSQL, Redis, backend, respaldos) y mide con `docker stats` en cuanto tengas clientes.

| Números de WhatsApp | RAM | Ejemplos de precio |
|---|---|---|
| Hasta ~5 | 4 GB | Hetzner CX23 ~5.49 EUR (poca disponibilidad); DigitalOcean ~24 USD |
| ~10–20 | 8 GB | Hetzner CX33 ~8.49 EUR; DigitalOcean ~48 USD |
| ~25–50 | 16 GB | DigitalOcean ~96 USD *(verificar)* |

**Ejemplo con 20 negocios** (1 000 conversaciones al mes cada uno, un número por negocio):

| Concepto | Al mes |
|---|---|
| IA: 20 × 10–20 USD, + 5.5 % | ~211–422 USD |
| VPS de 8–16 GB | ~25–50 USD |
| Dominio, respaldos, correo | ~2 USD |
| **Total** | **~238–474 USD (~12–24 USD por negocio)** |

Contra el mismo ejemplo con redes en Zernio (~437–648 USD) y sin contar lo que Meta cobraría con WhatsApp oficial. Con
Evolution, la IA es ~90 % del costo: el precio de un plan se fija casi solo con su tope de IA.

**Lo que no llega en una factura pero cuesta:**

- **Bloqueo del número.** Evolution no es oficial: si WhatsApp lo bloquea, el negocio pierde ese número y sus chats.
  Pasa sobre todo con envíos masivos a quien no escribió primero.
- **Licencia de Evolution.** Riverrun fija la versión 2.3.7, que no pide licencia. Desde la 2.4 hay que activar una
  licencia (`LICENSE_REQUIRED`, `docs/evolution-api.md`); su precio no está publicado. Si un día hace falta actualizar
  por seguridad, puede empezar a costar.
- **Mantenimiento.** Sesiones que se caen (por ejemplo, si el teléfono pasa unos 14 días sin conectarse, WhatsApp
  desvincula los dispositivos), actualizaciones de Evolution y la memoria del servidor corren por tu cuenta.

## Fuentes

Consultadas el 2 nov 2026. Desde esta sesión no se pudieron abrir `docs.zernio.com` ni `developers.facebook.com`; los
datos de esas páginas vienen de resúmenes de búsqueda y de sitios de terceros, por eso van marcados *(verificar)*.

- Zernio: [precios](https://docs.zernio.com/pricing), [mensajes](https://docs.zernio.com/pricing/messages),
  [WhatsApp](https://docs.zernio.com/pricing/whatsapp), [adiós a los planes](https://zernio.com/blog/pay-per-account-pricing),
  [precios de X](https://my.zernio.com/blog/twitter-api-pricing)
- Meta WhatsApp: [precios oficiales](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing),
  [cobro de mensajes de servicio desde oct 2026 (360dialog)](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/),
  [tarifas por país desde oct 2026 (ChatMaxima)](https://chatmaxima.com/blog/whatsapp-service-message-pricing-october-2026/),
  [precios por país (Kanal)](https://getkanal.com/blog/whatsapp-business-pricing-guide)
- OpenRouter: [modelos](https://openrouter.ai/models), [comisión por créditos](https://www.truefoundry.com/blog/openrouter-pricing),
  [gpt-4.1-mini](https://www.llmreference.com/model/gpt-4.1-mini/openrouter),
  [gemini-2.5-flash](https://www.llmreference.com/model/gemini-2.5-flash/openrouter)
- X: [precios de la API por uso (bundle.social)](https://bundle.social/blog/x-api-pricing-2026-costs-limits)
- Servidor: [Hetzner 2026 (Bitdoze)](https://www.bitdoze.com/es/hetzner-cloud-precios-2026/),
  [Hetzner junio 2026 (WZ-IT)](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/),
  [DigitalOcean](https://betterstack.com/community/guides/web-servers/digitalocean-review/),
  [Backblaze B2](https://costbench.com/software/cloud-infrastructure/backblaze-b2/)
- Correo: [Resend](https://www.usecarly.com/blog/resend-pricing/)
- Evolution: [memoria por número (Hostinger)](https://www.hostinger.com/vps/docker/evolution-go),
  [despliegue y memoria (Railway)](https://railway.com/deploy/evolution-whatsapp-api),
  [licencia desde la 2.4](https://github.com/evolution-foundation/evolution-api/releases)
- Cobros: [Stripe vs Mercado Pago (Guía de Software)](https://www.guiadesoftware.com/blog/stripe-vs-mercado-pago),
  [comisiones en México (Ecom Calc Tools)](https://ecomcalctools.com/es/blog/stripe-vs-paypal-latam/)
