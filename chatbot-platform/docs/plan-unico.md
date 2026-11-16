# Plan único

Riverrun se vende con un solo plan mensual, **Riverrun**, con dos precios:

| Precio | Clave | Moneda | IVA | Se cobra con | Se publica |
|---|---|---|---|---|---|
| $5,000 MXN al mes | `riverrun` | MXN | + 16 % (total $5,800) | Stripe o Mercado Pago | Sí, en `/precios` y el registro |
| $270 USD al mes | `riverrun-usd` | USD | Sin IVA | Solo Stripe | No, hasta tener la versión en inglés (`--usd-publico`) |

Los dos incluyen lo mismo:

| Incluye | Límite |
|---|---|
| Mensajes del asistente al mes | 10,000 |
| Canales (WhatsApp, Instagram, chat web…) | 10 |
| Redes sociales conectadas (Zernio) | 10 |
| Personas del equipo | 10 |
| Asistentes | 5 |
| Archivos | 5 GB |
| Tope interno de IA (no se publica) | 50 USD al mes |

## Cómo se aplica

En el servidor:

```bash
./riverrun plan-unico                 # crea o actualiza los dos precios y apaga los demás planes
./riverrun plan-unico --usd-publico   # igual, y además publica el precio en dólares
```

Fuera de Docker: `npm run plans:single`. Se puede correr las veces que se quiera. Los planes que apaga no se borran:
quien ya pagaba uno lo conserva con sus límites; nadie nuevo lo puede contratar. Los precios y límites viven en
`src/billing/single-plan.ts`; también se pueden ajustar a mano en **Planes y cobro**, pero volver a correr el comando
los regresa a los de ese archivo.

## Por qué alcanza para Zernio y la IA

Zernio cobra a la plataforma por cada red conectada (gratis las 2 primeras de toda la plataforma, luego 6 USD al mes
hasta la 10.ª, 3 USD hasta la 100.ª y 1 USD después) y por cada mensaje enviado después de los primeros 10,000 al mes
(0.0001 USD). Los mensajes recibidos y los comentarios no cuestan.

El peor mes de un negocio, con todo al tope y la tarifa más alta de Zernio:

| Concepto | USD al mes |
|---|---|
| 10 redes × 6 USD | 60 |
| 10,000 mensajes × 0.0001 USD | 1 |
| IA (se corta en el tope) | 50 |
| **Total** | **111** de 270 que se cobran |

Un negocio típico usa 2 o 3 redes y mucho menos IA, así que el margen real es mayor. La prueba
`test/single-plan.test.ts` falla si un cambio de límites deja el peor mes por encima de la mitad del precio. No cuenta
el servidor, las comisiones de Stripe (alrededor de 4 %) ni los mensajes de plantilla de WhatsApp, que Meta cobra a la
cuenta de WhatsApp Business del negocio.

## Topar un límite

Como no hay un plan más grande, al topar un límite el negocio ve «Para ampliarlo, escríbenos» (con `SUPPORT_CONTACT`
si está configurado) en lugar de «cambia de plan». Para ampliarle algo, usa el botón **Límites** de esa cuenta en
**Cuentas** (excepción sobre su plan). Los avisos del 80 % y del 100 % de mensajes dicen lo mismo. Nunca se le sugiere
un precio en otra moneda ni un plan privado.

## IVA por moneda

El IVA (`BILLING_TAX_PERCENT`) se suma solo a los planes en las monedas de `BILLING_TAX_CURRENCIES` (`MXN` por omisión).
El precio en dólares se cobra tal cual. Confirma con tu contador cómo facturar las ventas a Estados Unidos (exportación
de servicios) antes de publicar ese precio.
