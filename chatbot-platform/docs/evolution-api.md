# Evolution API: versión fijada, actualización segura y recuperación

Evolution API conecta cada WhatsApp como "dispositivo vinculado". Guarda las **sesiones** en su base `evolution`
(tabla `Session` y demás) y en el volumen `evolution_instances`, y **migra su esquema en cada arranque**
(`prisma migrate deploy`). Por eso cambiar su imagen no es inocuo: puede migrar datos de forma irreversible.

## Qué usa RiverRun de Evolution

| Uso | Ruta (Evolution v2) | Dónde |
|---|---|---|
| Crear instancia con su webhook y primer QR | `POST /instance/create` | `whatsapp-session.ts` |
| QR / código de vinculación | `GET /instance/connect/{i}` | `whatsapp-session.ts` |
| Estado de la sesión | `GET /instance/connectionState/{i}` | sesión, estado del canal, monitoreo |
| Número y perfil vinculados | `GET /instance/fetchInstances?instanceName=` | al conectar; sonda de la llave |
| Webhook (configurar / leer) | `POST /webhook/set/{i}` · `GET /webhook/find/{i}` | configuración del canal · monitoreo |
| Enviar texto / archivo | `POST /message/sendText/{i}` · `POST /message/sendMedia/{i}` | respuestas del asistente |
| Descargar un medio recibido | `POST /chat/getBase64FromMediaMessage/{i}` | notas de voz, fotos y documentos |
| Cerrar sesión / borrar | `DELETE /instance/logout/{i}` · `DELETE /instance/delete/{i}` | solo al borrar un canal o una cuenta (acción explícita) |
| Versión | `GET /` (sin llave; v2 devuelve `version`) | monitoreo y `./riverrun update` |
| Eventos entrantes | webhook `MESSAGES_UPSERT`, `CONNECTION_UPDATE`, `QRCODE_UPDATED` | `evolution/parse.ts` |

Dependencias de versión: la API v2 (rutas de arriba) existe desde 2.0; los identificadores `@lid` y `remoteJidAlt`
llegan con 2.3. La versión 1.x tiene otra API: es **incompatible**.

## Versión fijada y por qué no `latest`

`docker-compose.yml` define la imagen una sola vez (ancla `x-evolution-image`) y la usan Evolution, el backend (para
comparar lo configurado con lo que responde) y los respaldos (para registrar con qué versión se hizo cada uno):

```
evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339
```

La etiqueta es legible; el **digest** la hace inmutable (aunque alguien vuelva a publicar `v2.3.7`, se descarga
exactamente esta). Sigue siendo configurable con `EVOLUTION_IMAGE` en `.env`.

Por qué no `latest` (revisado el 2026-10-10 en Docker Hub y en el repositorio oficial):

- `latest` se reconstruye sin aviso: su imagen actual es del 2026-05-06, construida desde un commit de documentación
  posterior a 2.3.7 en `main`. Cada instalación que lo descargó en otro momento corre otra versión.
- Ya existen candidatas 2.4.0 (`2.4.0-rc1`, `2.4.0-rc2`), publicadas desde un repositorio renombrado
  (`evolution-foundation/evolution-api`), con **dos migraciones nuevas** y, sobre todo, **exigen activar una licencia**:
  probada aquí con la imagen real, la 2.4.0-rc2 responde `503 LICENSE_REQUIRED` a toda la API (crear instancias,
  estados, webhooks, envíos) hasta registrar la instancia con Evolution Foundation, mientras `GET /` sigue diciendo
  "it is working!". Si `latest` pasa a la 2.4, **WhatsApp dejaría de funcionar en toda instalación sin versión fijada**.
- Una actualización de Evolution sin control puede desconectar sesiones, cambiar el formato de webhooks o romper el QR.

### Por qué 2.3.7

- Es la **última versión estable** publicada (2.4.0 solo existe como versión candidata).
- Su código es **el mismo** que el `latest` actual (entre la etiqueta 2.3.7 y la imagen `latest` solo hay cambios de
  documentación), así que fijarla no cambia el comportamiento de quien instaló recientemente.
- Pasó la **suite real** (abajo), incluida la actualización desde 2.3.6 con datos.
- Su única migración nueva (`20251122003044_add_chat_instance_remotejid_unique`) borra chats duplicados y crea un
  índice único en la tabla `Chat` de Evolution. RiverRun no usa esa tabla (`DATABASE_SAVE_DATA_CHATS=false`; guarda sus
  propias conversaciones). Consecuencia: **no se puede volver a 2.3.6 o anterior sin restaurar el respaldo**.

## Compatibilidad conocida (`src/evolution/compat.ts`)

| Versión | Estado | Última migración | Nota |
|---|---|---|---|
| 2.3.7 (fijada) | **Verificada** | `20251122003044_add_chat_instance_remotejid_unique` | Suite real completa. |
| 2.3.4 – 2.3.6 | No verificada | `20250918182355_add_kafka_integration` | Misma API según el código; 2.3.6 se usa como origen de la prueba de actualización. |
| 2.3.0 – 2.3.3 | No verificada | `20250613143000_add_lid_column_to_is_onwhatsapp` | Primeras con `@lid`. |
| 2.2.x | No verificada | `20250116001415_add_wavoip_token_to_settings_table` | Sin `@lid`: números incompletos. |
| 2.4.0-rc2 | **Incompatible** | `20260506184850_add_runtime_config` | Probada con la imagen real: exige licencia (`503 LICENSE_REQUIRED` en toda la API). `update` la bloquea aunque se acepte. |
| 2.4.0 final y demás 2.4.x | No verificada | `20260506184850_add_runtime_config` (según la RC) | Sin probar. `update` pide confirmación con el aviso de licencia; si Evolution responde `LICENSE_REQUIRED`, el monitoreo lo marca como fallo y `update` no da la actualización por buena. |
| < 2.2, 1.x, 3.x | **Incompatible** | — | Otra API o funciones faltantes. |

## Qué se registra y dónde se ve

Panel → **Sistema → WhatsApp (Evolution API)** (solo superadmin), `./riverrun status` y `npm run evolution:check -- status`:

- **Versión esperada** (la verificada) e **imagen configurada** (con "fijada" o "NO fijada").
- **Versión detectada**: la que informa Evolution en `GET /`. Si no la informa, se muestra **"No verificada"** (nunca se
  inventa).
- **Compatibilidad**: verificada · no verificada · incompatible.
- **Servicio**: responde, llave aceptada o rechazada.
- **Sesiones**: abiertas, conectando, cerradas, **perdidas** (instancias ya vinculadas que no existen en Evolution) y
  webhooks ausentes o distintos al esperado, con el canal afectado.
- **Cambio de versión** detectado (de → a, y cuándo) y **última verificación**.
- Cada respaldo guarda en su `manifest.json` la imagen de Evolution y la última migración de su base.

## Monitoreo preventivo

| Comprobación (cada minuto) | Falla (alerta) | Atención (sin alerta) |
|---|---|---|
| **Servicio de WhatsApp (Evolution)** | no responde · responde con error · exige licencia (2.4) · llave rechazada · versión incompatible | versión no verificada o desconocida · recién arrancado el servidor (3 min), Evolution aún iniciando |
| **WhatsApp: sesiones y entregas** | instancias vinculadas perdidas · tras un cambio de versión (24 h): la mitad o más de los canales vinculados desconectados, o ≥ 5 envíos fallidos en 15 min | canales desconectados · webhooks incorrectos · ≥ 5 envíos fallidos en 15 min |

- "Servicio" y "sesiones" están separados: que Evolution responda no significa que WhatsApp funcione, y una caída de
  Evolution no duplica la alerta en las sesiones.
- Las alertas siguen la regla existente: avisan al segundo minuto seguido, se repiten cada 6 h y avisan al recuperarse.
- Cada 15 minutos (y con "Comprobar ahora"), una revisión más profunda consulta el estado y el webhook de cada instancia.
- Los umbrales son heurísticas. Se ajustan sin tocar código con `WHATSAPP_ALERT_DOWN_RATIO` (fracción de canales vinculados
  caídos que cuenta como falla tras actualizar; 0.5), `WHATSAPP_ALERT_SEND_FAILURES` (envíos fallidos en 15 min que avisan;
  5) y `WHATSAPP_POST_UPDATE_HOURS` (horas de vigilancia tras cambiar de versión; 24).
- Todo es de **solo lectura** con tiempo límite: el monitoreo nunca crea, borra, desconecta ni reconfigura instancias
  (hay prueba que lo comprueba). La versión se pide como máximo cada 10 minutos.

## Actualización segura: `./riverrun update`

1. **Versión actual**: imagen y digest del contenedor de Evolution, última migración de su base y qué sesiones están abiertas.
2. **Versión destino**: la de `docker-compose.yml` (o `EVOLUTION_IMAGE` en `.env`). Si solo cambió `.env`, `update` la aplica igual.
3. **Compatibilidad y esquema** (`evolution-check plan`): versión destino conocida/verificada, si está fijada, y si
   aplicará migraciones (hacia adelante), no cambia el esquema, o **bajaría** el esquema.
4. **Estado de los servicios**: la versión nueva del backend se construye y se valida la configuración con ella, sin arrancarla.
5. **Respaldo recuperable**: obligatorio si cambia Evolution (no acepta `--no-backup`); se verifica **restaurando** en
   bases temporales también la de Evolution (`BACKUP_VERIFY_ALL=true`).
6. **Advertencias**: el plan explica migraciones irreversibles y versiones no verificadas.
7. **Confirmación explícita**: si hay migraciones o la versión no está verificada, hay que escribir `ACTUALIZAR EVOLUTION`
   (o `--accept-evolution-change` sin terminal). Las versiones **incompatibles** y las **bajadas de esquema** se bloquean
   aunque se acepten. Sin riesgo de esquema y con la versión verificada, no se pregunta.
8. **Aplicación controlada**: primero se descarga la imagen (si falla, no se aplica nada); después `docker compose up -d`
   recrea el contenedor con **los mismos volúmenes y la misma base**.
9. **Verificación** (`evolution-check verify`, hasta 2 min): responde y **atiende la API**, acepta la llave, la versión es
   la configurada y compatible, las sesiones que estaban abiertas vuelven a conectarse y ninguna instancia vinculada
   desapareció. Después, la salud funcional (`/health/functional` con `HEALTH_TOKEN`; sin token, `/health/ready`): falla
   si una comprobación que se pudo medir antes de actualizar y estaba bien queda en falla. Lo que ya fallaba (como una
   clave de IA pendiente) no bloquea, y lo que no se midió antes no se atribuye a la actualización. WhatsApp cuenta aquí.
   `/health/ready` ya no incluye WhatsApp: una caída de Evolution no reinicia ni saca al backend del balanceador.
10. **Vuelta atrás** si algo falla:
    - El backend siempre vuelve al código y la imagen anteriores (sus migraciones son aditivas).
    - Evolution vuelve a su imagen anterior **solo si su esquema no cambió** (es seguro).
    - Si Evolution **ya migró su base**, **no se baja** (una versión vieja con un esquema nuevo puede dañar las sesiones):
      se queda en la nueva, se fija `EVOLUTION_IMAGE` en `.env` para que ningún reinicio la cambie y se imprime el
      procedimiento de recuperación con el nombre del respaldo previo.

Cualquier fallo en los pasos 1–7 deja **todo como estaba** (código, imágenes y contenedores). `./riverrun restart` y
`./riverrun semantic` se niegan a aplicar una imagen de Evolution distinta de la que corre: eso solo lo hace `update`.
Si `git pull` trae un `riverrun` distinto, `update` continúa con el nuevo: el procedimiento también se actualiza.

### Esta actualización (de `latest` a la versión fijada)

La primera actualización a esta versión la ejecuta el `riverrun` **anterior** (se lee completo antes del `git pull`), que
no tiene estos pasos: aplicará la imagen fijada sin plan ni confirmación (con su respaldo previo de siempre). Se probó
con Docker real desde `main` con Evolution 2.3.6 como `latest`: la instancia, su identificador, su webhook y el canal se
conservaron y el esquema avanzó a 2.3.7. También se comprobó que, si esa actualización fallara, la vuelta atrás del
script anterior recrearía Evolution con la imagen vieja, y que **2.3.6 arranca sobre la base ya migrada por 2.3.7**
conservando instancia y webhook (para versiones más viejas no se puede asegurar). Para que el procedimiento nuevo
gestione el cambio desde el principio (plan, confirmación, respaldo verificado de ambas bases y vuelta atrás sin bajar
Evolution), ejecuta esta vez:

```bash
git pull --ff-only && ./riverrun update
```

(`update` ve que no hay código nuevo pero que la imagen de Evolution configurada cambió y aplica el cambio con cuidado.)

## Protección de las sesiones de WhatsApp

- Ninguna actualización borra volúmenes, ejecuta `down`, cierra sesiones ni borra o recrea instancias (las pruebas lo
  comprueban). Se conservan los identificadores de instancia, las sesiones, los webhooks, las referencias de los canales
  (`channels.config.instance`), las relaciones empresa–agente–teléfono y las conversaciones (todo vive en volúmenes y en
  la base de RiverRun, que no se tocan).
- La vinculación desde el panel recrea una instancia "trabada" (45 s sin QR) como recuperación. **Durante las 24 h
  siguientes a un cambio de versión, o con una versión incompatible, ya no lo hace con instancias que ya estuvieron
  vinculadas**: avisa ("no la reiniciamos automáticamente") y lo deja en Registros, para no borrar una sesión que quizá
  se recupera corrigiendo la versión.
- Borrar un canal o una cuenta sigue cerrando y eliminando su instancia: es una acción explícita del usuario.

## Recuperación

| Situación | Qué hacer |
|---|---|
| `update` se detuvo antes de aplicar | Nada se cambió. Lee el motivo (configuración crítica, versión incompatible, falta de confirmación o de respaldo), corrígelo y repite. |
| Falló y el esquema no cambió | `update` ya volvió a la imagen anterior de Evolution. Revisa `./riverrun logs evolution`. |
| Falló y Evolution ya migró su base | Evolution quedó fijado en la versión nueva. 1) Revisa `./riverrun logs evolution` y el panel. 2) Si Evolution funciona y falló el backend, corrige y repite `update`. 3) Si Evolution no funciona: fija `EVOLUTION_IMAGE=<imagen anterior>` (la imprime `update`) y `./riverrun restore <respaldo previo>`, que restaura su base y las sesiones juntas. Probado con Docker real (2.3.7 → 2.4.0-rc2 → restauración a 2.3.7: misma instancia, mismo webhook, mismo canal). |
| El panel marca instancias **perdidas** | No las vuelvas a vincular todavía (crearía una sesión nueva y perdería la anterior). Revisa `./riverrun logs evolution` y, si la sesión estaba en el respaldo, restáuralo. |
| Webhook incorrecto | En el canal, "Reconfigurar webhook" (solo lo actualiza; no toca la sesión). |
| Restaurar un respaldo de otra versión | La restauración muestra con qué Evolution se hizo; si la configurada es **más vieja**, fija `EVOLUTION_IMAGE` a la del respaldo antes de arrancar. Una más nueva lo migra hacia adelante al arrancar. |

## Pruebas

**Reales** (contra Evolution real; `scripts/evolution-compat.sh`, entorno aislado y desechable con el mismo
`docker-compose.yml`, sin el `.env` de la instalación, sin teléfonos). Ejecutadas el 2026-10-10 con la imagen fijada:

- Actualización **2.3.6 → 2.3.7** con datos: la instancia conserva su identificador y su webhook; el esquema avanzó de
  `20250918182355_add_kafka_integration` a `20251122003044_add_chat_instance_remotejid_unique` (por eso no hay vuelta atrás automática).
- Reinicio del contenedor: instancia y webhook se conservan. (Evolution 2.3.7 reconecta solo las instancias que estaban abiertas.)
- Llave correcta aceptada; equivocada o ausente, rechazada (401). La sonda de RiverRun lo distingue (404 = aceptada).
- `GET /` informa `2.3.7` y el monitoreo de RiverRun la reconoce como verificada.
- Crear instancia con el cuerpo exacto de RiverRun; webhook guardado con los eventos necesarios; reconfigurarlo.
- Estado de conexión; perfil sin vincular; instancia inexistente → 404 → `not_found` en RiverRun.
- **Webhooks entrantes**: Evolution entregó eventos a un receptor y RiverRun los interpretó.
- Envío de texto e imagen sin teléfono vinculado: falla de forma manejable (`EvolutionError` con estado HTTP, o tiempo agotado) y acotada (2 intentos de 30 s). El tiempo real depende de la red hacia WhatsApp.
- Descarga de un medio inexistente: error manejable.
- Borrar y recrear con el mismo nombre (Evolution libera el nombre de forma asíncrona; RiverRun ya reintenta).
- **QR: omitida** con motivo: este entorno no llega a los servidores de WhatsApp. `EVOLUTION_LIVE_REQUIRE_QR=true` la vuelve obligatoria.

La suite real encontró un error que las pruebas simuladas no veían (la sonda de la llave trataba el 404 de Evolution
real como error); se corrigió y el simulador ahora imita ese comportamiento.

**De extremo a extremo con Docker real** (2026-10-10; instalación de prueba con `./riverrun install`, imágenes del backend
construidas con los artefactos de cada commit porque este entorno no tiene red dentro de `docker build`; el respaldo usa el
`backup.sh` real):

- Transición desde `main` (`riverrun` anterior, Evolution 2.3.6 como `latest`) con una cuenta, un canal y su instancia
  creados por RiverRun: se conservaron identificador, webhook y canal; esquema 2.3.6 → 2.3.7.
- Procedimiento nuevo: se relanzó solo con el `riverrun` descargado; revisión de configuración con la imagen nueva; una
  falla previa (`ai` sin clave) no bloqueó; respaldo y aplicación correctos.
- `restart` se negó a aplicar otra imagen de Evolution; `update` **bloqueó la bajada** a 2.3.6 sobre el esquema de 2.3.7
  aunque se aceptara, sin tocar nada.
- Actualización con migraciones a 2.4.0-rc2 (aceptada): respaldo verificado restaurando **ambas** bases; la sesión que
  estaba abierta no volvió → vuelta atrás del backend, **Evolution no se bajó**, quedó fijado en `.env` y se imprimió la
  recuperación; ejecutándola (`restore`), todo volvió a 2.3.7 con la misma instancia, webhook y canal.

Esa prueba encontró y se corrigieron: la salud posterior a actualizar nunca detectaba fallos (`wget` no imprime el cuerpo
de un 503); `verify` no fallaba si Evolution respondía 503 a toda la API; `restore` con la confirmación por tubería
consumía la entrada; y dos avisos falsos (versión RC sin sufijo, misma imagen escrita con otro formato).

**Simuladas** (`npm test`): compatibilidad por versión, plan de actualización, monitoreo de servicio y sesiones,
ventana posterior a la actualización, protección de sesiones al vincular, diagnóstico sin secretos, y el flujo completo
de `./riverrun update` con un docker simulado (`scripts/test-cli.sh`).

**Manual, con un teléfono de pruebas** (no se puede automatizar sin uno; nunca con teléfonos de clientes):

1. En un servidor de pruebas, vincular un número de pruebas por QR y por código.
2. Enviarle un mensaje: el asistente responde (recepción por webhook y envío de texto).
3. Pedir una foto y un documento: llegan (envío de medios). Enviar una nota de voz: se transcribe (descarga de medios).
4. Actualizar Evolution con `./riverrun update`: la sesión vuelve sola y los pasos 2–3 siguen funcionando.

## Evaluar una versión nueva (p. ej. 2.4.0 final)

0. Para la 2.4: decidir primero si se acepta el licenciamiento de Evolution Foundation (el código de la RC activa la
   licencia con la llave global o con `EVOLUTION_OPERATOR_EMAIL`; no se ha probado) y cómo automatizarlo. Hasta
   verificarla, la RC 2.4.0-rc2 queda bloqueada y una 2.4 final se trata como no verificada.
1. `scripts/evolution-compat.sh evoapicloud/evolution-api:<versión>@sha256:<digest>` con
   `EVOLUTION_FROM_IMAGE=<imagen fijada actual>` (prueba también la actualización con datos).
2. La verificación manual con teléfono de pruebas.
3. Agregar la versión a `src/evolution/compat.ts` (digest, última migración, notas) y cambiar el ancla de
   `docker-compose.yml` (la prueba `docker-compose.yml fija Evolution…` exige que coincidan).
4. Las instalaciones la recibirán con `./riverrun update`, que mostrará el plan, pedirá confirmación si hay migraciones y
   hará el respaldo verificado antes de aplicarla.
