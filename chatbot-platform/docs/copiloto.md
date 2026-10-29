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
- No arranca si el gasto de IA ya pasó el 80 % de un límite: así no deja sin IA al agente que atiende a los clientes.

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
1. Dispara una regla activa que manda mensajes, inicia secuencias o llama webhooks: etiqueta agregada, dato
   capturado, etapa, cita agendada. La tarjeta nombra la regla.
2. El turno leyó texto escrito por clientes y el cambio toca un registro fuera de los permitidos: la página abierta,
   las acciones referidas o lo que se leyó. Esto protege contra instrucciones escondidas en mensajes.

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

Riesgo: R = leer, V = reversible, C = confirmar. «dyn» = pasa a C con las reglas de arriba.

**Consultar (R):**
- contexto de la cuenta;
- contactos;
- conteo de etiquetas;
- conversaciones y su lectura;
- citas y horarios libres;
- oportunidades;
- cobros;
- cotizaciones;
- estadísticas y consumo;
- automatizaciones;
- flujos con su revisión;
- agentes con versiones y conocimiento;
- probar reglas;
- probar al agente en el simulador.

**Agente (admin):**

| Herramienta | Riesgo |
|---|---|
| Cambiar instrucciones en palabras (`editPrompt` + `version-apply`) | V; C si hay un borrador sin publicar |
| Ajustar nombre, trato, activación, derivación y objetivo | V |
| Apagar el agente | V |
| Encender el agente | C |
| Agregar o editar conocimiento | V |
| Borrar conocimiento | C |
| Ajustes y conceptos de cotización | V |
| Horario del negocio y avisos (lista de claves permitidas) | V |

**Automatización (admin):**

| Herramienta | Riesgo |
|---|---|
| Crear flujo con IA (borrador) | V |
| Cambiar flujo con IA | V |
| Publicar flujo | C |
| Pausar flujo | V |
| Reanudar flujo | C |
| Reglas y secuencias | dyn |
| Campaña en borrador | V |
| Lanzar o cancelar campaña | C |
| Borrar automatizaciones | C |

**Día a día:**

| Herramienta | Riesgo |
|---|---|
| Editar contacto | dyn |
| Etiquetar hasta 20 contactos | dyn |
| Tareas | V |
| Asignar, tomar o devolver conversación | V |
| Cerrar conversación | C |
| Enviar mensaje, plantilla o foto | C |
| Inscribir o sacar de secuencia | C |
| Crear cita | C si avisa al cliente o hay anticipo; si no, V |
| Cambiar cita | V |
| Cancelar cita | C |
| Mover oportunidad o cambiar su valor | dyn |
| Crear, cerrar o recordar cobro | C |
| Editar cobro | V |
| Editar cotización | V |
| Aprobar y enviar, rechazar o aceptar cotización | C |

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
