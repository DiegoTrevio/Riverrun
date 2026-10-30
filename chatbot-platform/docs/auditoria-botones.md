# Auditoría de botones del panel

**Fecha:** octubre de 2026 · **Rama:** `claude/auditoria-botones` · **Cómo correrla:** `npm run test:buttons` (también en el CI, trabajo «Botones del panel»).

Objetivo: comprobar que **cada botón hace lo que dice su etiqueta**, en cada pantalla y con cada rol (superadmin, admin, agente y sin sesión), y corregir lo que no.

## Resumen

- **11 hallazgos** (BOTÓN-001 a 011): 1 alto, 6 medios y 4 bajos. **Todos corregidos**, cada uno con una prueba que lo reproducía antes de la corrección y ahora pasa.
- **Recorrido automático:** POR_COMPLETAR controles presionados en 4 roles y POR_COMPLETAR pantallas; cada diálogo se canceló (sin escribir nada) y después se aceptó.
- **Pase funcional por área:** POR_COMPLETAR comprobaciones que verifican en la base de datos o en el servicio simulado que el botón dejó lo que promete.
- **Cobertura del código:** POR_COMPLETAR de los POR_COMPLETAR sitios del panel con un manejador se presionaron aquí; el resto tiene su motivo anotado en `scripts/buttons/sin-presionar.json` (ver «Cobertura»).
- **Nada salió de la máquina:** el navegador y el servidor bloquean y anotan cualquier conexión externa. La única salida esperada es el catálogo público de modelos de OpenRouter (ver «Conexiones bloqueadas»).
- **Lo que solo se prueba con servicios reales** (QR real, pagos, correo, Google/Outlook, Facebook) está en la **lista manual** al final.

## Hallazgos

| ID | Severidad | Dónde | Qué pasaba | Corrección | Prueba |
|---|---|---|---|---|---|
| BOTÓN-001 | ALTO | Menú «Cobros» y «Ver sus cobros» / «Nuevo cobro» en la ficha del cliente (agente) | El menú y la ficha le ofrecen Cobros al agente y el servidor se lo permite, pero el router lo regresaba a Conversaciones: el botón parecía no hacer nada. | `main.js`: el agente puede abrir `cobros`. | `areas/cobros.mts` |
| BOTÓN-002 | MEDIO | Casilla «Hecho» de un pendiente (conversación) | Si el servidor fallaba, la casilla quedaba marcada aunque el pendiente seguía abierto. | `conversations.js`: vuelve a como estaba. | `areas/conversaciones.mts` |
| BOTÓN-003 | MEDIO | Selector de rol en «Mi equipo» | Si el servidor fallaba, decía «Administrador» aunque no se guardó. | `admin.js`: vuelve al rol que tiene (como el selector de perfil de al lado). | `areas/equipo.mts` |
| BOTÓN-004 | MEDIO | «Mis eventos ocupados bloquean mis horarios» (Agenda) | Si el servidor fallaba, la casilla cambiaba aunque no se guardó. | `agenda.js`: vuelve a como estaba. | `areas/equipo.mts` |
| BOTÓN-005 | MEDIO | Panel lateral de la conversación | El sondeo de 5 s volvía a dibujar el panel y cerraba lo que se había abierto (Privacidad, Resumen, Datos guardados). | `conversations.js`: conserva cada sección abierta o cerrada. | `areas/conversaciones.mts` |
| BOTÓN-006 | MEDIO | Superadmin con «Todos los perfiles»: Comentarios, Publicaciones, Cobros, Reportes, Integraciones, Redes, Datos de clientes | «No pudimos completar esta acción · Elige la cuenta» con un «Reintentar» que volvía a fallar. | `main.js` + `admin.js`: muestran «¿Qué perfil quieres gestionar?», como Agenda y Automatización. | `areas/superadmin.mts` |
| BOTÓN-007 | MEDIO | «Quitar asignación» (agente, en su conversación) | La conversación dejaba de ser suya, la pantalla la volvía a pedir: error de JavaScript «Conversación no encontrada» y se quedaba abierta. | `conversations.js`: vuelve a la bandeja con el aviso «Sin asignar». | `areas/conversaciones.mts` |
| BOTÓN-008 | BAJO | «Quitar archivo» (importar información) | Se veía sin archivo elegido y no hacía nada. | `importer.js`: aparece al elegir un archivo. | `areas/agentes.mts` |
| BOTÓN-009 | BAJO | iPhone / Android en el conector de WhatsApp | El elegido solo se notaba por el color; un lector de pantalla no lo decía. | `whatsapp.js`: `aria-pressed`, como las pestañas de arriba. | `areas/agentes.mts` |
| BOTÓN-010 | BAJO | «Guardar / Programar / Publicar» en Publicaciones | El error decía «Elige al menos una red: targets: Elige al menos una red». | `social-posts.js`: solo lo que falta. | `areas/redes.mts` |
| BOTÓN-011 | MEDIO | «Eliminar vista seleccionada» (Contactos) | Al abrir una vista guardada, el selector volvía a «Mis vistas guardadas»: el botón nunca tenía vista elegida y **ninguna vista se podía borrar**. | `contact-workspace.js`: la vista abierta queda elegida; el botón se deshabilita sin vista. | `areas/contactos.mts` |

Severidad: **ALTO**, un botón de un flujo principal no hace lo que dice; **MEDIO**, el estado engaña, se pierde lo abierto o falta un aviso; **BAJO**, detalles de texto, foco o accesibilidad.

## Cómo se hizo

Todo corre contra **PostgreSQL aislado** y los **servicios simulados** del arnés de pruebas (`test/harness.ts`): WhatsApp/Evolution, Zernio, Telegram, Meta, la IA, el correo en memoria y, en `test:billing:ux`, Stripe, Mercado Pago y Facturapi. Nada real se envía.

1. **Inventario del código** (`scripts/buttons/inventory.mts`): cada lugar del panel que crea un control con manejador de clic, cambio, envío o despliegue (`h('button', { onclick })`, `addEventListener`, `boton.onclick = …`), con su archivo:línea.
2. **Instrumentación** (`scripts/buttons/instrument.mts`): en el navegador, cada manejador queda ligado al archivo:línea que lo creó, y cada clic anota qué cambió (petición, página, foco, diálogo, navegación, descarga, portapapeles, aviso, error).
3. **Recorrido «presionar todo»** (`scripts/buttons/crawl.mts`): en cada pantalla de cada rol presiona cada control visible, uno por uno desde la pantalla recién abierta; lo que aparece al presionar otro (un editor, un menú, el contenido de un diálogo) también se presiona. Un control repetido en otra pantalla (el menú lateral) se prueba una vez por rol.
4. **Diálogos:** primero se cancelan, comprobando que **Cancelar no escribe nada**; al final, el **pase de aceptación** los vuelve a abrir y los acepta (escribiendo lo que piden: el nombre del agente, BORRAR…), de lo que menos borra a lo que más.
5. **Pase funcional por área** (`scripts/buttons/areas/*.mts`): para los botones que importan, comprueba **en la base de datos o en el servicio simulado** que se hizo lo que dice la etiqueta, que un fallo del servidor se ve y no deja el control mintiendo, y que cada rol ve lo que le toca. Ahí viven las pruebas de cada hallazgo.
6. **Guardias de red** (`scripts/buttons/network-guard.mts` y `context.route`): el servidor y el navegador no pueden conectarse fuera de la máquina; lo que lo intenta queda anotado.

### Veredictos del recorrido

| Veredicto | Qué significa |
|---|---|
| OK | Hizo algo visible: petición, cambio en la página, diálogo, navegación, descarga… |
| RECHAZADO | El servidor dijo que no (p. ej. un formulario vacío) **y la pantalla lo explicó**. |
| MISMA PÁGINA | Enlace a la página abierta, opción ya elegida, lista sin otra opción o no-operación esperada (p. ej. «Enviar» con el cuadro vacío). |
| DESHABILITADO / OMITIDO | No se puede presionar en ese estado (p. ej. subir el primero de la lista) / cierra la sesión de la auditoría (lo prueba `areas/global.mts`). |
| **SIN EFECTO, SIN MANEJADOR, ERROR JS, ERROR API, ERROR SILENCIOSO, REDIRIGIDO, PÁGINA NO ENCONTRADA, CANCELAR ESCRIBIÓ, ACEPTAR SIN EFECTO** | **Problema.** En modo estricto (`npm run test:buttons`, el del CI) cualquiera de estos hace fallar la prueba. |

## Resultados de la última corrida

POR_COMPLETAR

## Falsas alarmas descartadas

Lo que el recorrido marcó y, al revisarlo, **no era una falla**:

- **«Ocultar» un comentario de Instagram** respondía «Esta red no permite esa acción»: los datos de prueba insertan la cuenta directo en la base y el Zernio simulado no la conoce. La pantalla sí explica el error.
- **«Reenviar correo»** recién registrada responde «Espera un minuto antes de pedir otro correo»: es intencional (`onboarding.ts`, un correo por minuto). `test:billing:ux` ahora prueba las dos cosas: la espera y que después sí llega.
- **«Publicar» en el lienzo** con un flujo incompleto abre el panel «Pendientes» con lo que falta: ese es su aviso.
- **«Límites»** de un perfil con un texto que no es `mensajes=1000` responde «No entendí…»: es su validación.
- **Un admin que escribe a mano** `#/sistema`, `#/marcas`, `#/negocio`, `#/accounts` o `#/planes`: el servidor responde 403 y la pantalla muestra el aviso; no ve datos de la plataforma (`areas/superadmin.mts` lo comprueba).
- **«Publicar» del lienzo con un conflicto** no muestra un aviso nuevo, pero el lienzo ya muestra la franja «Este flujo cambió en otra pestaña… Recargar».

## Observaciones que no se corrigieron

- **La barra «Guardar cambios» de un agente** (`bot.js`, `saveBar`) muestra el error del servidor tal cual. Con un valor fuera de rango diría, por ejemplo, «Datos inválidos: ai.temperature: …». Es la misma clase de detalle que BOTÓN-010, pero solo aparece con valores que los campos ya impiden, y arreglarlo bien (cada error junto a su campo) es un cambio más amplio en todas las pestañas del agente.
- **Publicaciones se vuelve a dibujar completa cada 10 s** mientras algo se está enviando (`social-posts.js`). En la lista no hay nada que se pierda; no se pudo reproducir una pérdida.

## Mapa del estado: qué puede deshacer un clic

Para juzgar un botón hay que saber qué más reinicia la pantalla (método *click-path-audit*):

- **Router** (`main.js`): cada navegación vuelve a dibujar la pantalla desde cero; descarta lo de navegaciones viejas. La puerta del agente está ahí (BOTÓN-001) y ahora también la del superadmin sin perfil (BOTÓN-006).
- **Volver a dibujar todo con `render()`** después de una acción (admin.js 31 veces, bot.js 19, copilot.js 11…): se pierde lo escrito en otras tarjetas de la misma pantalla que no usan borrador (`editing.js`). Las pantallas largas del agente sí usan borrador.
- **Caché de lecturas** (`core.js`): `/api/meta` 5 min y `/api/channels` 1 s; cualquier escritura la vacía.
- **Sondeos que vuelven a dibujar:** el panel de la conversación cada 5 s (BOTÓN-005), la bandeja cada 10 s (conserva foco y desplazamiento), Publicaciones cada 10 s mientras algo se envía, el conector de WhatsApp cada 3 s y su cuenta regresiva cada 1 s, la campana cada 20 s.
- **Errores:** `run()` muestra el error en la tarjeta con foco o en un aviso; `h()` descarta el error de un control que ya no está en la página.

## Cobertura

POR_COMPLETAR

## Conexiones bloqueadas

POR_COMPLETAR

## Lista manual (con servicios reales, en tu servidor)

Esto **no se puede probar con servicios simulados**. Hazlo en tu servidor de pruebas (o en producción con datos de prueba) y marca cada casilla:

- [ ] **WhatsApp con QR:** Agente → Conexiones → WhatsApp → escanea el QR con un teléfono real → «¡WhatsApp conectado!»; manda un mensaje desde otro teléfono y el agente responde.
- [ ] **WhatsApp con número:** «Con mi número» → escribe el número → «Obtener código» → en el teléfono, *Vincular con el número de teléfono* con ese código → conectado.
- [ ] **«Vincular de nuevo» / «Cambiar número»** con un teléfono real: pide un QR nuevo y el anterior deja de recibir.
- [ ] **Pago con Stripe en modo de prueba:** registro con un plan → «Crear mi cuenta y pagar» → pagar con `4242 4242 4242 4242` → vuelve al panel con el plan activo; «Mi plan» muestra el pago.
- [ ] **Portal de Stripe:** «Administrar pago y facturas», «Cambiar tarjeta», «Cancelar plan» y «Mantener mi plan» abren el portal y el cambio se refleja en «Mi plan».
- [ ] **Mercado Pago** (si lo usas): el mismo pago con su tarjeta de prueba.
- [ ] **Factura (CFDI) real** con Facturapi en modo de prueba: con datos fiscales, el pago genera su factura descargable.
- [ ] **Correos (SMTP real):** registro (confirmar correo), «Olvidé mi contraseña», «Reenviar correo», «Enviar invitación» / «Reenviar invitación», «Borrar mi cuenta» (correo de confirmación), aviso «WhatsApp desconectado». Cada uno llega y su enlace funciona.
- [ ] **Google Calendar y Outlook:** Agenda → Equipo → «Conectar mi Google» / «Conectar mi Outlook» → autorizar → «Conectado»; una cita nueva aparece en el calendario; «Desconectar». Lo mismo en Integraciones.
- [ ] **Facebook / Instagram (Meta):** Conexiones → «Conectar con Facebook» → autorizar → elegir las páginas → «Conectar lo elegido»; un mensaje de Messenger llega al agente; «Desconectar».
- [ ] **Redes con Zernio:** «Conectar Instagram» (y otra red) con la cuenta real; responder, ocultar y eliminar un comentario real; publicar algo de prueba.
- [ ] **Canal de correo (IMAP/SMTP):** configurar un buzón real → «Verificar» → un correo al buzón llega como conversación.
- [ ] **Avisos al equipo por WhatsApp:** Automatización → Ajustes → «Enviar alerta de prueba» llega al WhatsApp de la persona; «Reintentar» un aviso que no llegó.
- [ ] **Webhook real:** Integraciones → crear un webhook a Zapier o Make → «Enviar prueba» llega con `"test": true`.
- [ ] **Importar desde una página web o Google Sheets real:** Crear agente → «Mi página web» → «Leer mi información» trae los datos del sitio.
- [ ] **Sistema → «Comprobar ahora»** consulta el catálogo de OpenRouter y dice si algún modelo configurado ya no existe.
- [ ] **La IA real:** en «Probar», el agente responde con tu información; el Copiloto hace un pedido sencillo («¿cuántas citas tengo esta semana?»).

## Cómo correrla y mantenerla

```bash
cd chatbot-platform
TEST_DATABASE_URL=postgres://chatbot:chatbot@localhost:5432/chatbot_test npm run test:buttons   # todo (≈ 20 min)
BUTTONS_ONLY=areas npm run test:buttons                  # solo el pase funcional por área (≈ 1 min)
BUTTONS_AREA=agenda,global BUTTONS_ONLY=areas npm run test:buttons   # solo esas áreas
BUTTONS_ONLY=recorrido BUTTONS_ROUTES=agenda,cobros npm run test:buttons   # recorrer solo esas pantallas
BUTTONS_REPORT_ONLY=1 npm run test:buttons               # escribe el informe sin fallar
BUTTONS_WRITE_PENDING=1 npm run test:buttons             # regenera sin-presionar.json (conserva los motivos)
```

La evidencia queda en `data/button-audit/results.json` (en el CI, el artefacto `button-audit`): el veredicto de cada control, su archivo:línea, sus efectos y la cobertura de cada sitio.

**Si agregas un botón** y nadie lo presiona, el CI falla y te pide una de dos: una prueba (en el recorrido o en `scripts/buttons/areas/`) o su motivo en `scripts/buttons/sin-presionar.json`.
