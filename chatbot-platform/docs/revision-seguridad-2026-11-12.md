# Revisión de seguridad y carga del 12 de noviembre de 2026 (antes de abrir al público)

**Base revisada:** `main` en bcaa9eb. Se revisó solo lo nuevo desde la revisión del 4 de noviembre (base 9a9f14d) más la
postura «día de apertura» en el Droplet de DigitalOcean (4 GB, 2 vCPU). Revisores de ECC: cuatro de solo lectura
(`ecc:security-reviewer` en Copiloto e identidad, en cotizador y cobros, y en superficie pública y despliegue;
`ecc:performance-optimizer` en carga) y `ecc:typescript-reviewer` sobre las correcciones. Cada hallazgo se volvió a
comprobar en el código.

**Resultado:** ningún crítico. Un alto que es decisión del dueño (verificación en dos pasos apagada) y un alto de carga
(memoria sin colchón), corregido. Dependencias de producción: 0 vulnerabilidades (`npm audit --omit=dev`). Tipos sin
errores.

## Corregido en este cambio

| Hallazgo | Qué pasaba | Corrección y prueba |
|---|---|---|
| Memoria sin swap (alto, carga) | Los topes de los servicios suman ~5.7 GB en un servidor de 4 GB sin swap: un pico de PDF, respaldo y WhatsApp hace que el sistema mate un servicio, a veces PostgreSQL. | `./riverrun harden` crea 2 GB de swap (swappiness 10) si no hay y el servidor tiene 8 GB o menos; `preflight` avisa si falta swap o si los `*_MEM_LIMIT` no caben; la guía trae los valores para 4 GB. `scripts/test-cli.sh`. |
| Copiloto relaja el validador sin tarjeta (medio) | `ajustes_avanzados_del_agente` podía apagar la revisión de precios y datos o de afirmaciones sin confirmación, y `mensajes_guardados` fijar textos que salen tal cual. | Ambos piden confirmación siempre. `probar_agente` y `ver_resultado_pruebas` marcan el turno como contaminado (repiten información que puede venir de páginas importadas). `test/copilot-relax-guard.unit.test.ts`. |
| Aceptar cotizaciones agota la base (medio) | Cada aceptación retiene una conexión para su candado y pide otras: unas 10 a la vez, de cualquier cuenta, dejaban a toda la plataforma esperando a la base. | Máximo 2 a la vez por proceso; las demás reciben 429 al momento. `test/quote-accept-slots.unit.test.ts`. |
| Caddy sin tiempos ni tope de cuerpo (medio) | Conexiones lentas (slowloris) y cuerpos de cualquier tamaño llegaban al backend. | 15 s para encabezados, 2 min sin actividad, cuerpo de 64 MB como máximo (cabe una subida de varios archivos de hasta 16 MB). Lo valida Caddy real en `test-image-smoke.sh` del CI. |
| `/contacto` abierto sin captcha (medio) | En producción sin las claves de Turnstile el registro y las reservas se cierran, pero el contacto seguía mandando correos a soporte. | Cerrado en producción sin claves, y tope de 200 mensajes al día para toda la plataforma (solo cuenta lo que pasó el captcha). `test/owner-self-service.test.ts`. |
| Fórmulas con números infinitos (bajo) | `9` repetido 400 veces es `Infinity`; con `max(-…, 0)` un concepto se omitía sin avisar. | Se rechaza al escribir la fórmula. `test/quotes-formula.unit.test.ts`. |
| Calculadora ajena al crear agente (bajo) | Crear un agente no revisaba que la calculadora fuera de la cuenta y estuviera activa (editar sí). | Se revisa también al crear. `test/quotes-from-text-routes.test.ts`. |

## Pendiente, por prioridad

1. **Alto, decisión del dueño: verificación en dos pasos apagada** (`MFA_REQUIRED=false`, por defecto desde el 5 de
   noviembre). Con ella apagada, llaves de la API, webhooks, roles, exportar, borrar y transferir la cuenta no piden
   código: basta una contraseña o una sesión robada. La guía de publicación ya dice que el panel la pide al entrar.
   Recomendado: `MFA_REQUIRED=true` en el servidor público. **Decisión del 12 de noviembre: se deja apagada por ahora,
   como riesgo aceptado.** La guía de publicación ya no dice que el panel la pide al entrar.
2. **Medio: enrolar la app de códigos sin el enlace del correo.** Con la verificación encendida, quien tenga solo la
   contraseña de alguien que aún no configuró su app puede configurar la suya. Mitigado: restablecer la contraseña por
   correo borra esa app.
3. **Medio: `/health/ready` y las páginas públicas sin límite por conexión.** Cada petición usa una conexión de la base;
   un flood puede agotar el pool. Opción: caché de 2 s en `/health/ready` o límite en Caddy.
4. **Bajo: el Copiloto.** `maybeContinue` no aplica el tope de pedidos simultáneos por cuenta; `correr_pruebas` cuenta
   como lectura aunque gasta IA (tope 6 por hora); la cuota de archivos del Copiloto no es atómica. Todo acotado por los
   topes de IA de la cuenta.
5. **Bajo: cotizaciones enormes.** Un total por encima de 1e11 centavos falla al aceptarse con error 500 en vez de un
   mensaje claro.
6. **Bajo: chat web sin `allowed_origins`.** Acepta cualquier sitio; conviene llenarlo al crear el canal.

**Revisado y sin hallazgo:** roles y cuentas del Copiloto (todas las herramientas pasan por las rutas del panel con la
sesión de quien pide), permisos de un solo uso del Copiloto, archivos del Copiloto, intérprete de fórmulas (sin `eval`,
con topes), CSV de precios, enlace público de cotización (firmado y con vencimiento), cobros y webhooks, límites de tasa
de la superficie pública, `trustProxy` con Caddy, puertos, panel (sin `innerHTML` con datos). El tope de IA por cuenta
de pago existe por omisión (`PLAN_DEFAULT_AI_USD=20`).

## Carga: cuánto aguanta el Droplet de 4 GB

Estimado a partir del código, no medido. Supuestos: una respuesta ocupa su lugar 6 a 10 s (una llamada a
`gpt-4.1-mini`), un negocio chico tiene ~150 respuestas al día con 20 % en su hora pico, y se deja la mitad de margen.

| Configuración | Respuestas por minuto | Negocios chicos con pico al mismo tiempo | PDF por minuto |
|---|---|---|---|
| De fábrica (`QUEUE_CONCURRENCY=2`) | 12 a 20 | 15 a 20 | 10 a 20 |
| `QUEUE_CONCURRENCY=4` (y `worker_limits`) | 24 a 40 | 30 a 40 | 10 a 20 |

- **El primer límite real es WhatsApp:** cada número vinculado ocupa memoria en Evolution; con 1 GB caben unos 8 a 12.
- **Subir a 8 GB** con más de 10 a 15 números de WhatsApp o si los mensajes esperan varios minutos en hora pico.
- `QUEUE_CONCURRENCY` no cambia solo el límite global guardado en la base: hay que correr también
  `UPDATE worker_limits SET concurrency = N` (ver la guía).
- Node usa un solo núcleo; PostgreSQL corre con valores de fábrica (`shared_buffers` 128 MB). Bien para el arranque;
  ajustar si la base crece.
- `verify_claims='estricto'` en todos los agentes duplica las llamadas a la IA y baja la capacidad a la mitad.
