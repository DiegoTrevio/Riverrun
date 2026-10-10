# Configuración: validación antes de arrancar

RiverRun se configura con variables de entorno (`.env`, que `docker-compose.yml` pasa a cada servicio). Antes de cargar
nada más, el servidor valida esa configuración (`src/config-check.ts`, con Zod) y clasifica cada problema en tres niveles:

| Nivel | Qué significa | Qué pasa al arrancar |
|---|---|---|
| **Crítico** | Arrancar sería inseguro o el servidor no podría funcionar (un formato roto, un secreto predecible en producción). | **No arranca** (modo estricto). Lista todos los problemas juntos y cómo corregir cada uno. |
| **Aviso** | Arranca, pero una función queda limitada, insegura o *aparentemente activa sin funcionar* (p. ej. Stripe con una sola de sus dos claves). | Arranca y lo informa en la consola. |
| **Opcional** | Un servicio opcional está apagado (correo, cobro, Google, búsqueda semántica, latido). | Arranca; se lista como "opcional apagado". |

Los requisitos dependen del **entorno** y de las **funciones activadas**: las credenciales de un servicio opcional solo se
exigen si ese servicio se configuró, y los problemas de seguridad solo bloquean en producción.

## Entornos

`RIVERRUN_ENV` (production · development · test) manda; si no está, se deduce de `NODE_ENV` (la imagen de Docker usa
`production`; `npm run dev` y las pruebas, desarrollo/pruebas).

- **Producción y desarrollo:** los secretos débiles o de ejemplo son **avisos** visibles en la consola;
  No bloquean el arranque, porque hay instalaciones ya en marcha con valores cortos que no deben dejar de funcionar al
  actualizar. Un formato roto (un puerto inválido, una URL de base de datos que no lo es) sigue siendo crítico en
  cualquier entorno, porque impediría operar.

## Qué se valida

| Área | Crítico | Aviso / opcional |
|---|---|---|
| Formatos | `PORT`, `SCHEDULER_INTERVAL_MS`, `EMAIL_POLL_SECONDS`, días de registros, límites de prueba, umbrales de supervisión, `TRUST_PROXY_HOPS`, tiempos de la IA… fuera de rango o no numéricos (un `NaN` acaba en bucles de 1 ms o consultas rotas). `DATABASE_URL`, `PUBLIC_BASE_URL`, `WEBHOOK_BASE_URL` y la URL de la IA mal formadas. `KNOWLEDGE_SEARCH_ACCOUNT_IDS` sin UUID. | Interruptores que no son exactamente `true`/`false` (p. ej. `SIGNUP_ENABLED=TRUE` apagaría el registro sin aviso). URLs de Telegram, Meta, Zernio, Stripe, Mercado Pago, Evolution, latido y alertas mal formadas. |
| Seguridad | — (ningún secreto bloquea el arranque) | `SESSION_SECRET` corto, repetitivo o de ejemplo; `SESSION_SECRET` ausente (se usa uno aleatorio por arranque: cierra sesiones y pierde datos cifrados al reiniciar); `ADMIN_PASSWORD` de menos de 8 caracteres o la de ejemplo (`auth.ts` ya no crea ni actualiza al superadministrador con la de ejemplo cuando hay HTTPS). HTTPS sin `SECURE_COOKIES=true`; `SECURE_COOKIES=true` sin HTTPS. `ALLOW_PRIVATE_WEBHOOKS=true`. Base de datos con contraseña vacía o de ejemplo. |
| IA | — | Falta la clave (el panel funciona, el asistente no responde). Clave que no es de OpenRouter con la dirección de OpenRouter. Modelos sin `proveedor/modelo`. Más de 2 modelos de respaldo. IA por http a un servidor externo. |
| WhatsApp (Evolution) | — | `EVOLUTION_API_KEY` vacía (Evolution rechaza toda petición sin clave), corta o de ejemplo. `WEBHOOK_BASE_URL` ausente o apuntando a `localhost` con Evolution en otro contenedor (no llegarían los mensajes). `EVOLUTION_IMAGE` con etiqueta móvil (`latest`), no verificada o incompatible. |
| Correo | — | `SMTP_URL` mal formada; sin SMTP pero `SIGNUP_REQUIRE_EMAIL=true` (nadie podría confirmar su correo); sin `MAIL_FROM`. Sin SMTP: opcional apagado. |
| Cobro | — | Stripe o Mercado Pago con una sola de sus dos claves (queda desactivado aunque parezca configurado), formatos que no corresponden, claves de prueba en producción, sin HTTPS. |
| Integraciones | — | Google con una sola credencial; sin HTTPS en producción. |
| Monitoreo | — | En producción, nadie recibe alertas (sin correo ni webhook). Sin latido externo: opcional. |

Los mensajes **nunca incluyen valores** de variables (ni siquiera los no secretos), solo su nombre, el problema y cómo
corregirlo.

## Modo estricto y salida de emergencia

`CONFIG_VALIDATION=strict` (por defecto): un problema crítico impide arrancar. `CONFIG_VALIDATION=warn` arranca igual,
lo dice en la consola: es solo para salir de un apuro (por ejemplo, si una regla nueva
marcara como crítico algo que en tu instalación es correcto). Algunos valores no se pueden interpretar en absoluto (una
URL de la IA rota, una lista de cuentas piloto inválida) y detienen el proceso aunque se use `warn`.

## Compatibilidad con instalaciones existentes

- Ninguna variable se renombró ni se eliminó. `assertProductionConfig()` se conserva (ahora usa el validador).
- Una instalación hecha con `./riverrun install`, con o sin dominio, arranca sin problemas críticos (hay prueba).
- Una instalación hecha a mano desde `.env.example` también arranca: `SESSION_SECRET` vacío y la contraseña de ejemplo con
  HTTPS siguen siendo avisos, como antes (hay prueba).

## Revisión sin arrancar

```bash
npm run config:check               # desarrollo (lee .env)
npm run config:check -- --all      # incluye los opcionales
npm run config:check -- --json     # para otras herramientas
docker compose run --rm --no-deps backend node dist/cli/config-check.js   # con Docker (no arranca nada más)
```

Código de salida: `0` puede arrancar · `2` hay problemas críticos.
