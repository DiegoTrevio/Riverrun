# Copiloto (diseño)

Objetivo: un ayudante con IA dentro del panel. Le dices qué quieres, lo hace en toda la aplicación, tú lo revisas y le
pides cambios, también sobre una acción específica. «Asistente» y «agente» ya son el bot que atiende a los clientes;
por eso se llama **Copiloto**.

## Decisiones

- **Sin preguntar, solo lo reversible.** Lo que se puede deshacer se aplica de una vez y queda con «Deshacer».
- **Con tu «Sí» antes:** lo que no se puede deshacer o llega a otras personas queda pendiente de confirmación:
  - mensajes a clientes;
  - borrar;
  - cobrar;
  - publicar o reanudar;
  - cancelar.
- **Quién lo usa:** administradores y agentes, cada uno con los permisos que ya tiene en el panel. El superadmin lo usa
  sobre la cuenta que tenga elegida.
- **Qué cubre:** configurar el agente, automatizar, operar el día a día y responder preguntas sobre los datos.
- **Dónde:** un panel lateral disponible en todo el panel. Sabe qué página y qué registro estás viendo.
- **Modelo:** uno capaz de encadenar pasos (`OPENROUTER_COPILOT_MODEL`). Se cobra del presupuesto de IA de la cuenta
  (`kind = 'copilot'`).
- **Activación:**
  - Se enciende cuenta por cuenta (`accounts.copilot_enabled`) desde Cuentas, sin volver a desplegar.
  - `COPILOT_ENABLED=false` lo apaga para todas.

## Un turno

1. El panel manda `POST /api/copilot/threads/:id/messages` con:
   - el texto;
   - la página (`#/contact/…`);
   - las acciones anteriores a las que se refiere («Cambiar esto»).
2. El servidor guarda el turno como `running` y responde 202 de inmediato.
3. El ciclo corre en el mismo proceso. El modelo pide herramientas, cada una se ejecuta y su resultado vuelve al modelo,
   hasta que responde con texto.
   - Cada paso queda guardado: mensajes, acciones y la etiqueta del paso en curso.
4. Mientras el turno corre, el panel pide `GET /api/copilot/threads/:id/updates?after_rev=` cada segundo y muestra los
   pasos («Buscando a Ana…», «Etiqueté a Ana como VIP»).

Límites por turno:

| Límite | Valor |
|---|---|
| Pasos del modelo | 8 |
| Herramientas | 20 |
| Cambios | 15 |
| Propuestas | 5 |
| Duración | 180 s |
| Costo | 0.50 USD |

Turnos en curso:
- Un solo turno en curso por hilo y por usuario.
- «Detener» marca el turno en la base de datos, así que funciona con varios procesos. El ciclo lo revisa entre paso y
  paso.
- Un turno cuyo latido (`heartbeat_at`) tiene más de 45 s pasa a `interrupted`. Una acción que quedó a medias pasa a
  `unknown` («no sabemos si se aplicó; revísalo»).

Límites de uso:
- 30 turnos por hora por usuario y 300 al día por cuenta, contados en la base de datos.
- Tope de gasto por cuenta: 3 USD en 24 horas (`COPILOT_ACCOUNT_USD_PER_DAY`; 0 = sin tope). Al llegar, no arranca otro
  pedido, y un pedido en curso no gasta más de lo que le queda a la cuenta. Usa el costo que reporta OpenRouter.
- No arranca si el gasto de IA ya pasó el 80 % de un límite: así no deja sin IA al agente que atiende a los clientes.

Lo que se le manda al modelo, para gastar poco:
- Las herramientas y la parte fija de las instrucciones van primero y en orden fijo: se guardan en caché y se comparten
  entre todas las cuentas (con modelos de Anthropic).
- Cada paso de un pedido lee de la caché lo que mandó el paso anterior (`cache_control` de OpenRouter); solo se cobra
  completo lo nuevo.
- El JSON Schema de las herramientas va sin valores por omisión ni datos que zod ya revisa. `cambiar_regla` no repite el
  esquema de `crear_regla`.
- La lista de la conversación lleva solo los cambios y las propuestas (las últimas 12), no las consultas.
- Los resultados de herramientas de turnos más viejos que los últimos 2 se recortan.

## Herramientas: las mismas rutas del panel

Cada herramienta llama a una ruta del panel que ya existe, dentro del mismo proceso (`app.inject`), con la cookie de
sesión de quien escribió. Así:

- los permisos son idénticos a los del panel: el agente solo ve lo que tiene asignado y lo de administrador le da 403;
- la validación, los límites del plan, los registros y los efectos (reglas, webhooks) son los mismos;
- no hay que mover lógica de las rutas a servicios.

Condiciones del ejecutor:
- La cookie vive solo en memoria mientras dura el turno; nunca se guarda ni se registra.
- El modelo nunca elige URL ni método: cada herramienta arma su ruta con ids validados.
- **Superadmin:** cada hilo queda fijo en la cuenta elegida.
  - Cada llamada lleva `account_id`.
  - Se descarta cualquier registro que regrese de otra cuenta.

Cada herramienta declara:
- esquema zod (de ahí sale el JSON Schema para el modelo);
- roles;
- etiqueta del paso;
- riesgo, calculado según los argumentos;
- vista previa armada por código;
- registros que toca;
- enlaces;
- receta para deshacer.

Resultados que ve el modelo:
- Son cortos: campos elegidos y unos 3 000 caracteres por resultado.
- Lo que escribieron los clientes va dentro de `datos_del_cliente`. El prompt dice que eso es dato, nunca instrucción.

## Riesgo

| Nivel | Qué pasa |
|---|---|
| `read` | Se ejecuta. |
| `reversible` | Se ejecuta. Guarda la foto de antes, la de después y la receta para deshacer. |
| `confirm` | No se ejecuta: crea una propuesta con vista previa (texto exacto, destinatario, cuántos). |

**Propuestas (`confirm`):**
- Solo el clic de quien la pidió la ejecuta, con los **argumentos guardados**. El cuerpo de la petición nunca trae
  argumentos.
- Es de un solo uso (el estado se reclama de forma atómica) y caduca a los 30 minutos.
- El hash de lo que se mostró (`seen_hash`) debe coincidir.

**Un cambio reversible pasa a `confirm` si:**
1. Dispara una regla activa que manda mensajes, inicia secuencias o llama webhooks: etiqueta agregada (sin importar
   mayúsculas ni acentos, como el motor de reglas), dato capturado, etapa, cita agendada, conversación tomada por una
   persona. Se siguen las reglas encadenadas por etiqueta (hasta tres saltos). La tarjeta nombra la regla.
2. El turno leyó texto escrito por clientes y el cambio es de configuración (agente, automatizaciones, horario), no
   dice qué registros toca, o toca un registro fuera de los permitidos: la página abierta, las acciones referidas o lo
   que se leyó **antes** de ese texto (lo que se lee después no amplía el alcance). El alcance es por cliente: la
   conversación y las citas de un contacto permitido también lo están. Esto protege contra instrucciones escondidas en
   mensajes.

**Texto de clientes.** Cuenta como tal todo lo que escriben los clientes o cualquiera desde afuera: mensajes, datos y
notas, y también sus nombres (el perfil de WhatsApp o la página pública de reservas), así que las búsquedas de
contactos, conversaciones, citas, oportunidades, cobros y cotizaciones marcan el turno. Lo leído en los 6 turnos que el
modelo vuelve a ver completos sigue contando en el turno nuevo. Los nombres que entran al prompt (equipo, agentes,
página abierta, títulos de acciones y avisos) van en una línea corta sin signos de formato y el prompt los trata como
datos.

**La tarjeta muestra lo que se va a hacer.** Cada herramienta que puede pasar a `confirm` arma su vista previa (sin
vista previa propia, la tarjeta lista lo pedido campo por campo). Un cambio de instrucciones que hay que confirmar
muestra su antes y después, y al confirmar se aplica exactamente ese texto (no se vuelve a pedir a la IA).

## Deshacer

Cómo funciona:
- Antes de deshacer, se lee el registro y se compara con la foto de después. Si cambió, se rechaza con 409 y no se pisa
  nada.
- Se deshace con la sesión de quien da el clic.
- Hay «Deshacer todo» por turno, en orden inverso, y se puede deshacer durante 7 días.

| Registro | Comprobación antes de deshacer |
|---|---|
| Datos del contacto | Se mandan solo las claves cambiadas, con la versión de después (`base_data_version`); el servidor rechaza con `StaleDataError` si cambió. |
| Etiquetas | Inversa por contacto: quita las agregadas que sigan y repone las quitadas. |
| Flujos | Candado de revisión. |
| Instrucciones del agente | Parche inverso con `version-apply`; se comprueba que el texto vigente sea el que se aplicó. |

## Revisar y pedir cambios

- Cada acción hecha es una tarjeta con:
  - qué hizo;
  - **Ver**, que lleva al registro real y deja el Copiloto abierto;
  - **Deshacer**;
  - **Cambiar esto**, que agrega al cuadro de texto una referencia a esa acción. El servidor la expande en un bloque
    «[Referencias]» con la herramienta, el registro y el estado.
- La página abierta es contexto: «este contacto» se entiende sin decir cuál. El nombre del registro lo busca el
  servidor con permisos; no se confía en lo que manda el panel.

## Catálogo

54 herramientas (`src/copilot/tools/`): 28 para agentes del equipo y todas para administradores. Riesgo: R = leer,
V = reversible (con «Deshacer»), C = confirmar. «dyn» = pasa a C con las reglas de [Riesgo](#riesgo). Después de leer
texto de clientes, todo cambio de configuración (agente, automatizaciones, horario) pasa a C.

**Cuenta, contactos y conversaciones** (`cuenta.ts`, `contactos.ts`, `conversaciones.ts`; admin y agente):

| Herramienta | Riesgo |
|---|---|
| `contexto_cuenta`, `contar_etiquetas`, `buscar_contactos`, `ver_contacto`, `buscar_conversaciones`, `leer_conversacion` | R |
| `editar_contacto` (combina con lo que hay; versión de datos), `etiquetar` (hasta 20) | dyn |
| `crear_tarea`, `actualizar_tarea` | V |
| `gestionar_conversacion` (asignar, tomar, devolver) | V |
| `cerrar_conversacion`, `dar_de_baja`, `enviar_mensaje`, `enviar_foto`, `secuencia_de_conversacion` (inscribir o sacar) | C |

**Día a día** (`operacion.ts`):

| Herramienta | Quién | Riesgo |
|---|---|---|
| `horarios_libres`, `buscar_citas` | ambos | R |
| `crear_cita` | ambos | C si avisa al cliente o el servicio pide anticipo; si no, V (deshacer = cancelar sin avisar) |
| `cambiar_cita` (reagendar, notas, estado, quién atiende) | ambos | V |
| `cancelar_cita` | ambos | C |
| `ver_oportunidades` | ambos | R |
| `actualizar_oportunidad` (columna y valor) | ambos | dyn |
| `ver_cobros` | ambos | R |
| `crear_cobro` (deshacer = cancelarlo), `cerrar_cobro` (pagado o cancelado), `recordar_cobro` | ambos | C |
| `editar_cobro` | ambos | V |
| `ver_cotizaciones` | admin | R |
| `editar_cotizacion` (renglones y notas, antes de enviarla), `editar_lista_de_precios` | admin | V |
| `decidir_cotizacion` (aprobar y enviar, rechazar, marcar aceptada) | admin | C |
| `estadisticas` (periodo y el anterior, equipo, canales, gasto de IA) | admin | R |

Las herramientas de cobros solo existen si `RECEIVABLES_ENABLED` está encendido.

**Agente** (`agente.ts`, admin):

| Herramienta | Riesgo |
|---|---|
| `ver_agente` | R |
| `cambiar_instrucciones` (`prompt-edit` + `version-apply`; la tarjeta muestra el antes y el después) | V |
| `ajustar_agente` (nombre, trato, largo, emojis, tono, si no sabe, reglas, temas prohibidos, cuándo pasa a una persona) | V |
| `encender_o_apagar_agente` | apagar V; encender C |
| `agregar_conocimiento`, `editar_conocimiento` | V |
| `borrar_conocimiento` (deshacer = volverlo a agregar) | C |
| `cambiar_horario` (horario por día y días cerrados) | V |

Si el agente tiene cambios sin aplicar en su página, el Copiloto no aplica nada de paso: pide aplicarlos o
descartarlos primero. Deshacer compara lo publicado con lo que dejó el Copiloto y no pisa cambios posteriores.

**Automatización** (`automatizacion.ts`, admin):

| Herramienta | Riesgo |
|---|---|
| `listar_automatizaciones`, `ver_flujo` | R |
| `crear_flujo`, `cambiar_flujo` (con IA; en borrador; con candado de revisión) | V |
| `publicar_flujo` (sobre la revisión que se vio) | C |
| `pausar_o_reanudar_flujo` | pausar V; reanudar C |
| `crear_regla`, `cambiar_regla` | C si queda activa y envía mensajes o calla al asistente; si no, V |
| `editar_secuencia` (nombre, activa, texto o espera de sus pasos) | C si hay personas en ella; si no, V |
| `crear_campana` (borrador, con su audiencia) | V |
| `lanzar_campana`, `cancelar_campana`, `borrar_automatizacion` | C |

Las reglas del Copiloto no llevan acciones que mandan datos a otros sistemas (`webhook`, `send_conversation`,
`send_report`). Las reglas y secuencias que vienen de un lienzo se cambian con `cambiar_flujo`.

**Una propuesta no se ejecuta sobre otra versión.** La vista previa guarda cómo estaba el registro (`meta`, que no
sale al panel: la revisión del flujo, la campaña, la cotización). Si cambió antes de confirmar, la acción falla y pide
volver a proponerla.

**No incluido en esta versión:** plantillas de WhatsApp, probar reglas o al agente en el simulador, ajustes de
cotización, avisos al equipo y activación del agente.

**Fuera del Copiloto** (dice dónde hacerlo):
- canales;
- planes;
- presupuesto y modelo de IA;
- usuarios e invitaciones;
- llaves de API, webhooks y secretos;
- borrar o exportar la cuenta o los datos de un contacto;
- consentimiento, baja y retención;
- crear, duplicar o borrar agentes;
- subir archivos;
- redes sociales;
- funciones de superadmin.

## Datos (migración 092)

- `copilot_threads`, `copilot_turns`, `copilot_messages` y `copilot_actions`. Las cuatro tablas llevan `rev`, que toma
  el siguiente número de una secuencia en cada alta o cambio y sirve de cursor para las novedades.
- Un índice único parcial garantiza un turno `running` por hilo y otro por usuario.
- `accounts.copilot_enabled boolean not null default false`.
- Precio del modelo en `ai_prices`.
- **Retención:** los hilos se borran a los 90 días (`COPILOT_RETENTION_DAYS`), o antes si la cuenta guarda los mensajes
  menos tiempo.
- **Borrado de un contacto (`eraseContact`):** se vacía el texto de los turnos que lo tocaron (`contact_ids`).
- **Auditoría:** cada acción ejecutada, confirmada o deshecha escribe `logEvent` con `source: 'copilot'`, quién la hizo y
  el id de la acción.

## Rutas

| Ruta | Para qué |
|---|---|
| `GET /api/copilot/threads` | Hilos propios de la cuenta. |
| `POST /api/copilot/threads` | Crear un hilo. |
| `PATCH /api/copilot/threads/:id` | Cambiar el título. |
| `DELETE /api/copilot/threads/:id` | Borrar el hilo. |
| `GET /api/copilot/threads/:id` | Mensajes, acciones y turno actual. |
| `POST /api/copilot/threads/:id/messages` | Enviar un mensaje (202 `{turn_id}`). 409 si ya hay un turno, 429 por límite de uso, 409 sin margen de presupuesto. |
| `GET /api/copilot/threads/:id/updates?after_rev=` | Novedades desde el último `rev`. |
| `POST /api/copilot/turns/:id/stop` | Detener el turno. |
| `POST /api/copilot/turns/:id/undo-all` | Deshacer todo el turno. |
| `POST /api/copilot/actions/:id/confirm` (`{seen_hash}`) | Confirmar una propuesta. |
| `POST /api/copilot/actions/:id/decline` | Descartar una propuesta. |
| `POST /api/copilot/actions/:id/undo` | Deshacer una acción. |
| `GET /api/copilot/data/tags` | Conteo de etiquetas. |

`GET /api/me` agrega `copilot: { enabled }`.

## Panel

- **Archivos:** `public/js/copilot.js` y `public/js/copilot-cards.js`, y `public/copilot.css`.
- **Montaje:**
  - Se monta una vez fuera de `#app`, así no se borra al navegar.
  - Tiene sus propios temporizadores.
  - El estado abierto o cerrado y el hilo viven en `sessionStorage`.
- **Botones:** «Copiloto» en el pie del menú y en la barra superior. Atajo Ctrl/⌘ + punto.
- **Ancho:**
  - desde 1280 px, acoplado a la derecha;
  - de 769 a 1279 px, cajón encima;
  - en teléfono, pantalla completa como diálogo, y Escape devuelve el foco al botón.
- **Contenido:**
  - chip de contexto de la página;
  - registro de pasos con `role=log`;
  - consultas agrupadas;
  - tarjetas de acción y de confirmación;
  - historial de hilos;
  - Detener;
  - ejemplos según la página.
- Si cambió algo de la página abierta, ofrece «Actualizar vista». No vuelve a pintar la página solo, para no perder un
  borrador.
- **Seguridad del navegador (CSP):** el texto del modelo se arma como nodos, nunca con `innerHTML`, y los enlaces solo
  van a rutas `#/` permitidas.

## Seguridad

- **Inyección:**
  - Todo lo que sale hacia afuera o no se deshace es propuesta, con vista previa armada por código.
  - Lo escrito por clientes va marcado como dato.
  - Hay contexto obligatorio para cambiar registros después de leer texto de clientes.
  - Hay topes por turno.
- **Permisos:** iguales a los del panel, porque cada herramienta pasa por la misma ruta con la misma sesión.
- **Propuestas:**
  - argumentos guardados;
  - hash de lo que se mostró;
  - caducidad y un solo uso;
  - solo el dueño del hilo confirma;
  - no existe una herramienta que confirme.
- **Presupuesto:** todo pasa por `accountAi` y se registra en `ai_runs` y en `ai_spend` (`kind = 'copilot'`).

## Probar con la IA real

Las pruebas (`npm test`) usan un modelo simulado por guion. Para saber si el modelo real hace bien los cambios, y cuánto
cuestan, `scripts/eval-copilot.mts` corre unos 20 pedidos sobre una cuenta de prueba y revisa en la base de datos que
cada cambio quedó bien:

```bash
# Con la IA real (necesita OPENROUTER_API_KEY y la base local de pruebas; la borra y la vuelve a crear):
RIVERRUN_EVAL_MAX_USD=3 npm run eval:copilot:live -- --models anthropic/claude-sonnet-4.5,anthropic/claude-haiku-4.5
# Solo algunos casos (y los que necesitan antes):
npm run eval:copilot:live -- --only agendar,cancelar
# Sin IA, con el modelo de guion (revisa que los casos y sus comprobaciones funcionan):
npm run eval:copilot
```

- **Casos:**
  - etiquetar y «Cambiar esto»;
  - datos, pendientes, asignar;
  - agendar y cancelar «esa cita» (queda como propuesta y se confirma);
  - mover una oportunidad;
  - un mensaje al cliente (propuesta);
  - instrucciones del agente y deshacer;
  - conocimiento, horario;
  - una regla interna y cambiar «esa regla» (la misma, no otra);
  - una regla que manda mensajes y una etiqueta que dispara otra (propuestas);
  - un pedido ambiguo (pregunta);
  - instrucciones escondidas en un mensaje de cliente (no hace nada);
  - algo fuera de alcance;
  - una pregunta sobre los datos;
  - un agente del equipo (no cambia la configuración, sí etiqueta lo suyo).
- **Pasa** cuando el pedido termina bien y la comprobación del caso se cumple en la base de datos.
- **Por cada modelo**, el script:
  - revisa en el catálogo de OpenRouter que existe y acepta herramientas, y muestra su precio;
  - dice qué casos pasaron, con sus pasos y su costo;
  - da el costo por pedido y qué parte de la entrada salió de la caché;
  - al final, dice el más barato que pasó todos.
- **Tope de gasto:** `RIVERRUN_EVAL_MAX_USD` (por omisión 2, máximo 10) y hasta 0.30 USD por pedido. Conviene una clave de
  OpenRouter dedicada, con tope de crédito.

