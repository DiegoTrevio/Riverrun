# Auditoría de la plataforma — octubre 2026

## Alcance

| Área | Cómo se revisó | Resultado |
|---|---|---|
| Compilación y dependencias | `tsc`, build, `npm audit`, `docker compose config` (con y sin perfil https) | Sin errores, 0 vulnerabilidades |
| Pruebas automáticas | Suite completo 3 veces seguidas | 128/128 en las 3 corridas |
| Migraciones | Base nueva (001→006), actualización desde 001 con datos, aplicar dos veces | Correctas e idempotentes |
| Docker | `docker build` y arranque de la imagen con PostgreSQL | Construye, migra, sirve el panel, corre como usuario `node`, queda *healthy* |
| Evolution API real (v2.3.7) | Contenedor oficial: crear instancia, webhook, estado, perfil, logout, borrar, recrear | Formatos confirmados; 2 fallos encontrados (abajo) |
| Aislamiento entre cuentas | **Todas** las rutas autenticadas (leídas del código) con admin y agente de otra cuenta | 114 intentos: 68 → 404, 46 → 403, ningún dato ajeno |
| Fugas de secretos | Todas las respuestas GET del panel (cuenta y superadmin) | Sin hash de contraseñas, tokens, QR, códigos ni llaves |
| Autenticación | Cookie `HttpOnly`/`SameSite=Strict`, sesión falsificada, límite de intentos, enlaces de un solo uso | Correcto |
| Webhooks entrantes | Token inválido, JSON roto, cuerpo de 11 MB, firma/secretos | 404 / 400 / 413 / rechazos correctos |
| XSS | Datos maliciosos en nombre, etiquetas, notas, mensajes, conocimiento y avisos, vistos en el navegador | Nada se ejecuta (todo es texto) |
| Inyección de instrucciones | El cliente "dicta" un precio y la IA obedece | Encontró un fallo (abajo) |
| Resiliencia | Backend matado con `kill -9` a mitad de conversación; PostgreSQL detenido y reiniciado; IA caída | 1 fallo grave encontrado (abajo) |
| Volumen | 1,000 contactos, campaña de 1,000, 20,000 registros de consumo | Listados ~13 ms, campaña programada en 1.5 s, consumo 38 ms |
| Horario de verano | Horarios y citas en Nueva York alrededor del cambio de hora | Correcto |
| Panel | 75 páginas en escritorio (3 roles) y 36 en celular (390 px), dos veces | Sin errores |

## Hallazgos

| # | Gravedad | Hallazgo | Estado |
|---|---|---|---|
| 1 | **Alta** | Si PostgreSQL se reiniciaba, una conexión inactiva lanzaba un error sin manejar y **el backend se caía**. | Corregido: el pool descarta la conexión rota y se reconecta solo; las transacciones liberan conexiones rotas. Verificado reiniciando PostgreSQL con el servidor arriba. |
| 2 | **Alta** | Conexión de WhatsApp: si Evolution no devolvía QR al instante (lento o sin salida a internet), la sesión **borraba y recreaba la instancia cada 3 s**, así el QR nunca alcanzaba a salir. | Corregido: máximo una solicitud cada 15 s; recreación solo tras 45 s sin código y máximo una cada 2 min; el QR que llega por webhook se muestra al instante. |
| 3 | Media | Al recrear una instancia, Evolution real tarda en liberar el nombre: la creación fallaba ("already in use") y la persona veía un error. | Corregido: espera a que se libere; si no, muestra "preparando" y reintenta. Verificado contra Evolution real. |
| 4 | Media | Un precio de **un dígito** dictado por el cliente ("cuesta $1") pasaba la verificación de datos. | Corregido: los montos de dinero siempre se verifican contra la información del negocio. |
| 5 | Media | Webhooks salientes: la IP se revisaba antes de conectar; un dominio con DNS cambiante (*DNS rebinding*) podía llegar a la red interna. | Corregido: la IP se valida en el momento de conectar; sin redirecciones; 10 s máximo. |
| 6 | Media | Si la IA (OpenAI) fallaba también en el reintento, el mensaje quedaba sin respuesta y **nadie se enteraba**. | Corregido: aviso al equipo ("⚠️ Un cliente espera respuesta") en el panel y por WhatsApp. |
| 7 | Media | "Horario y ajustes" aceptaba zonas horarias inexistentes y franjas invertidas (18:00–09:00), que rompen agenda, secuencias y campañas. | Corregido: se validan; el editor acepta "9-18". |
| 8 | Baja | El detector de tú/usted confundía nombres propios ("soporte de TI", "paquete Tus Uñas", "salón Te Consiento") y gastaba reintentos. | Corregido: ignora mayúsculas y nombres a mitad de oración. |
| 9 | Baja | Cada intento de reconexión de Evolution ("connecting", varios por minuto) se registraba como advertencia y llenaba Registros. | Corregido: solo se registran conexión y desconexión. |
| 10 | Baja | El `HEALTHCHECK` de Docker usaba siempre el puerto 3000. | Corregido: usa `PORT`. |
| 11 | Baja | Dos pruebas automáticas tenían carreras de tiempo (causa de una falla intermitente). | Corregido. |

### Aceptados (riesgo bajo, sin cambio)
- **Teléfonos dictados por el cliente:** el bot puede repetir un teléfono que el propio cliente escribió en la conversación. Los precios sí se bloquean siempre (#4).
- **Hora inexistente:** la hora que no existe el día que se adelanta el reloj (2:30 a.m. en EUA) se toma como 1:30. Solo afecta horarios en esa hora exacta.
- **Lista de conversaciones:** muestra las 100 más recientes; las anteriores se encuentran con el buscador.
- **Límites por IP con el backend expuesto sin Caddy:** con `PANEL_BIND=0.0.0.0` sin proxy, hay que poner `TRUST_PROXY_HOPS=0` o la IP se puede falsear con `X-Forwarded-For`. La configuración por defecto (Caddy delante) es segura.

## Lo que no se pudo probar aquí (requiere el servidor real)
El entorno de la auditoría no tiene salida directa a WhatsApp, Meta ni OpenAI. Con Evolution real se confirmaron los formatos de la API, pero no la vinculación con un teléfono.

**Lista de verificación en tu VPS (15 minutos):**
1. `docker compose --profile https up -d --build` y entrar al panel por HTTPS.
2. Registrar una empresa de prueba y confirmar el correo (SMTP configurado).
3. Paso 5 de Primeros pasos desde la **computadora**: el QR aparece solo; escanearlo. Debe decir "Conectado como …".
4. Desconectar, y repetir desde el **celular** con "Con mi número": recibir el código y vincular. Si WhatsApp rechaza el código con un número de México, probar con y sin el `1` después del `52`.
5. Desde otro teléfono escribir al número: el asistente responde con datos reales; pedir un precio inexistente: dice que no lo tiene confirmado.
6. Escribir "asesor": pasa a una persona y llega el aviso al WhatsApp de avisos.
7. Apagar el internet del teléfono del negocio unos minutos: llega el correo "Tu WhatsApp se desconectó" con el enlace para volver a vincular.
8. **Consumo de IA:** revisar que el gasto registrado coincida, aproximadamente, con el panel de OpenAI.
9. `docker compose restart postgres`: el panel y el bot siguen funcionando sin reiniciar el backend.

## Pruebas nuevas que quedan en el repositorio
- `test/isolation.test.ts`: recorre todas las rutas del panel con usuarios de otra cuenta. Las rutas nuevas quedan cubiertas solas, porque se leen del código.
- En las pruebas existentes se agregaron casos para:
  - la recreación de instancias (incluido el nombre ocupado);
  - el límite de solicitudes de QR;
  - los precios dictados por el cliente;
  - el DNS que apunta a la red interna;
  - la IA caída;
  - la validación de ajustes;
  - los nombres propios en el trato.

---

# Auditoría de Conexiones (WhatsApp por QR o por número) — octubre 2026

## Alcance y cómo se revisó

| Área | Cómo se revisó |
|---|---|
| Comportamiento real de Evolution 2.3.7 | Código fuente de la etiqueta `2.3.7` (controlador de instancias, servicio de Baileys, monitor, estado de autenticación) y Baileys `7.0.0-rc.9` de la imagen fijada |
| Evolution real en Docker | `scripts/evolution-compat.sh` antes y después de los cambios: 12/12 verificaciones reales (el QR se omite: este entorno no llega a WhatsApp) |
| Sesión de vinculación, webhooks y desconexión | Pruebas con PostgreSQL real y Evolution simulada, ahora con la semántica de 2.3.7 |
| Panel | Regresión UX y accesibilidad en navegador (68 pantallas, 176 escenarios), más dos recorridos nuevos |
| Respaldo y restauración de sesiones | `scripts/test-backup.sh` con Redis real; la carga con AOF probada con la imagen `redis:7-alpine` |

## Hallazgos

| # | Gravedad | Hallazgo | Estado |
|---|---|---|---|
| 1 | **Alta** | **"Con mi número" fallaba** si antes se había mostrado el QR (lo normal): con la instancia esperando escaneo, Evolution devuelve el QR vigente e **ignora el número**, así que nunca llegaba un código ("WhatsApp no generó el código…") hasta que la instancia se trababa. | Corregido: si la instancia espera un QR y aún no tiene sesión, la vinculación se reinicia con el número y el código sale en la misma consulta. |
| 2 | **Alta** | El código por número se mostraba hasta 2 min, pero **Evolution pide uno nuevo con cada QR (cada 45 s) y solo el último sirve**: la persona tecleaba un código ya inválido. | Corregido: el código que llega por webhook reemplaza al anterior, se reutiliza como máximo 40 s y el panel avisa que use siempre el que ve. |
| 3 | **Alta** | **Abrir la conexión de un WhatsApp que se estaba reconectando solo** (justo lo que pide el correo de "se desconectó") **borraba la sesión a los 45 s** (logout + borrar + crear) y obligaba a escanear de nuevo, aunque se hubiera recuperado sola. | Corregido: una sesión vinculada que se cayó sin cerrarse nunca se recrea sola. El panel dice "se está reconectando solo" (sin QR) y ofrece **Vincular de nuevo** a propósito. |
| 4 | **Alta** | **El respaldo no incluía las claves de cifrado de las sesiones.** Con caché en Redis, Evolution guarda en Redis las pre-keys, las sesiones Signal y las claves de sincronización (en su base solo va `creds`). Al restaurar en un servidor nuevo, las sesiones no descifrarían los mensajes. Además, con AOF activo, dejar un `dump.rdb` en el volumen no sirve: Redis arranca vacío (comprobado). | Corregido: cada respaldo incluye una instantánea de Redis (`redis.rdb`), verificada. `./riverrun restore` la carga con la propia imagen de Redis (sin AOF → AOF en caliente). Si Redis no responde al respaldar, el respaldo se marca como fallido y se avisa. |
| 5 | Media | **"Desconectar" desde el panel podía mandar "Hay que volver a vincular tu WhatsApp"**: Evolution envía el webhook de cierre (401) casi al mismo tiempo que responde, y el panel marcaba la desconexión a propósito después. | Corregido: se marca antes de cerrar. Si no se puede cerrar, el estado vuelve a como estaba y el mensaje es claro. |
| 6 | Media | Desconectar una sesión que ya estaba cerrada daba un error técnico ("HTTP 400 … is not connected"). | Corregido: cuenta como desconectada (verificado contra Evolution real). |
| 7 | Baja | Al agotarse los QR (`QRCODE_LIMIT`), Evolution manda el estado `refused`: se guardaba tal cual (el panel mostraba "Sin información") y podía borrar el motivo de una caída anterior. | Corregido: se guarda como `close` y conserva el motivo. |
| 8 | Baja | En un celular el conector abría en "Escanear QR", que no se puede escanear con el mismo teléfono. | Corregido: en celulares abre en **Con mi número** (con el número del perfil ya escrito): un toque y aparece el código. |
| 9 | Baja | La Evolution simulada de las pruebas daba códigos por número que la real no da, por eso el fallo #1 no se detectaba. | Corregido: simula 2.3.7 (número solo al crear o con la instancia cerrada; 400 al cerrar una sesión cerrada; webhook de cierre antes de responder). |
| 10 | Baja | La guía del cliente remitía a un menú "📱 Conectar WhatsApp" que ya no existe, y el panel tenía una pantalla de conexión sin ruta (código muerto). | Corregido: la guía describe lo que ve la persona y se quitó la pantalla duplicada. |

Las 6 pruebas nuevas de la sesión de vinculación **fallan con el código anterior** y pasan con el nuevo.

## Lo que no se pudo probar aquí (requiere un teléfono)

Este entorno no llega a los servidores de WhatsApp: no se pudo escanear un QR ni teclear un código reales. En el VPS:
1. Desde la computadora: el QR aparece solo; escanearlo → "Conectado como …".
2. Desconectar y repetir desde el **celular**: la pantalla abre en "Con mi número"; tocar *Obtener código* y escribirlo en
   WhatsApp → *Dispositivos vinculados* → *Vincular con el número de teléfono*. Si WhatsApp dice "código incorrecto", usar
   el que muestre el panel en ese momento.
3. Con el teléfono conectado, cortar el internet del **servidor** 2–3 minutos y abrir la conexión en el panel: debe decir
   "Tu WhatsApp se está reconectando solo" (sin QR) y volver a "Conectado" sin escanear.
4. `./riverrun backup` y luego, en un servidor de prueba, `./riverrun restore <archivo>`: el WhatsApp debe recibir y
   contestar mensajes sin volver a vincularlo.
