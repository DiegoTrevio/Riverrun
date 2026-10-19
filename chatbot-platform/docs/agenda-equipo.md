# Agenda del equipo

Varias personas pueden atender un mismo servicio de la agenda. El asistente solo ofrece horarios en los que alguien está
disponible y le asigna la cita a quien le toque.

## En cada servicio (Agenda → Servicios)

- **Quién atiende:** las personas del equipo que dan ese servicio.
- **Cómo se reparten las citas** (con dos o más personas):
  - **Por turnos (round robin):** le toca a quien hace más tiempo no recibe una cita de ese servicio.
  - **Por porcentajes:** cada persona tiene su parte (p. ej. Ana 70 %, Beto 30 %). La siguiente cita va a quien más
    se ha quedado atrás respecto a su porcentaje (cuenta las citas de los últimos 30 días, sin las canceladas), así que
    el reparto se acerca a lo pedido. No hace falta que sume 100; se reparte en proporción. Con **0 %** la persona solo
    recibe citas cuando nadie más está libre.
  - En los dos casos, si a quien le toca no está libre en ese horario, la cita va a otra persona disponible.
- **Citas al mismo tiempo:** con personas asignadas es **por persona**:
  - 1 = cada persona atiende a un cliente a la vez; dos personas pueden tener cita a la misma hora;
  - más de 1 = clases o grupos.
  - Sin personas asignadas, es el total de citas que caben a la misma hora.
- **Horario del servicio (opcional):** recorta el de las personas. Sin horario propio, se ofrecen los horarios en los
  que trabaja alguien del servicio.

## Disponibilidad de cada persona (Agenda → Equipo y disponibilidad)

- **Horario propio:** días y horas en que trabaja. Sin horario propio, sigue el del negocio.
- **Días libres:** vacaciones o permisos (de una fecha a otra). Esos días no se le asignan citas.
- Una persona también está ocupada si:
  - tiene una cita de **otro** servicio a esa hora;
  - tiene un evento ocupado en su calendario.
- Cada quien edita su propia disponibilidad (los agentes la ven como «Mi disponibilidad»); el administrador, la de todos.

## Calendario de cada persona

Cada persona conecta su **propio** Google Calendar u Outlook desde *Mi disponibilidad*. Lo autoriza con su cuenta, igual
que el calendario del negocio, con la misma configuración de Google o Microsoft (ver [integraciones](integraciones.md)).

- **Sus eventos ocupados bloquean solo sus horarios**, no los de los demás. Se puede apagar con «Mis eventos ocupados
  bloquean mis horarios».
- **Las citas que se le asignan aparecen en su calendario.** Si la cita se cambia de hora, se actualiza; si se reasigna,
  sale del calendario de la persona anterior y entra al de la nueva; si se cancela, se quita.
- Al conectarlo se copian sus citas futuras. Al desconectarlo, lo que ya se copió se queda en su calendario.
- El administrador ve qué calendario tiene conectado cada quien (y el último error, si lo hay) y puede desconectarlo,
  pero no puede conectarlo por otra persona.

El calendario del negocio (Ajustes → Integraciones) sigue funcionando igual: sus eventos ocupados bloquean el horario
para todos y recibe todas las citas.

## Llamadas con el equipo

Un servicio de tipo **Llamada** puede ser:

- **Telefónica:** la persona asignada le marca al cliente a la hora acordada. El agente pide el teléfono si el cliente no
  escribe por WhatsApp, y a la persona le llega con quién y a qué número.
- **Videollamada:** cada llamada tiene su enlace. Si la persona tiene su calendario conectado, se crea una sala propia
  (**Google Meet** con Google, **Teams** con Outlook); si no, se usa su **enlace fijo** (Zoom, Meet personal…) que pone en
  *Equipo y disponibilidad → Videollamadas*. Sin persona asignada, la sala sale del calendario del negocio o del «Lugar»
  del servicio si es un enlace. El enlace le llega al cliente al agendar (en el chat o por correo), está en los
  recordatorios y en el evento del calendario.

**Cómo se reparten** (en el servicio, si tiene personas):

1. **La persona que pide el cliente** — con «El cliente puede pedir con quién», el agente ve los horarios de cada persona
   y, si el cliente pide a alguien por su nombre, agenda con ella en sus horarios (si no está libre, le ofrece los suyos).
2. **Quien ya atiende al cliente** — con «Primero con quien ya atiende al cliente», si la conversación tiene una persona
   asignada y está libre a esa hora, la llamada es con ella.
3. **Por turnos o por porcentajes** — para todo lo demás (ver arriba).

Solo cuentan las personas **activas**: una desactivada no ofrece horarios ni recibe llamadas. Una persona sin horario
propio solo atiende en el horario del servicio o, si el servicio no tiene, en el del negocio.

**Avisos:** la persona asignada recibe un **correo** (además del aviso en el panel y por WhatsApp si lo tiene activado)
cuando le agendan o cancelan una cita o llamada, con el cliente, su teléfono o correo, y el enlace de la videollamada.

**Variables** para mensajes y recordatorios: `{{cita.persona}}` (quién atiende) y `{{cita.enlace}}` (enlace de la
videollamada). Si el recordatorio no usa `{{cita.enlace}}`, el enlace se agrega al final.

## Página para reservar (enlaces)

En **Agenda → Enlaces para reservar** el administrador crea enlaces públicos (`/reservar/<código>`) para compartir en
redes, la firma de correo o el sitio, como Calendly:

- **Del negocio:** el cliente elige el servicio (todos los activos o los que marques), la persona si el servicio permite
  elegir («El cliente puede pedir con quién»), el día y la hora. Si no elige persona, se reparte como dice el servicio.
- **De una persona** («Agenda con Ana»): solo sus servicios y siempre con ella.
- El cliente deja su nombre, su correo y su teléfono (obligatorio en llamadas telefónicas). No necesita cuenta.
- La reserva entra a la agenda (origen «página») con las mismas reglas: horarios realmente libres, la misma revisión
  dentro de la transacción, avisos al equipo, correo a la persona, evento en su calendario y sala de videollamada.
- Al cliente le llega la **confirmación por correo** (con el enlace de la videollamada si aplica), los
  **recordatorios** del servicio por correo y, si la cita se cancela desde el panel, el **aviso de cancelación**. Si el
  correo no se pudo enviar, la página se lo dice para que guarde los datos.
- Protecciones: límite de visitas y reservas por IP y por enlace, **máximo 3 reservas próximas por correo** en cada
  negocio (nadie acapara la agenda ni recibe correos sin fin), campo trampa para robots, enlaces que se pausan o borran,
  y la página no muestra correos ni datos del equipo (solo nombres).
- Al borrar a una persona del equipo, su enlace se borra con ella (no queda como enlace de todo el negocio).

## Al agendar a mano

En *Nueva cita* (y al agendar desde una conversación) se puede elegir quién atiende entre las personas libres en ese
horario, o dejar «Automático (según el servicio)». Si no hay conversación, se puede escribir el correo del cliente para
enviarle la confirmación.

## Al reprogramar

La cita se queda con la misma persona si está libre a la nueva hora; si no, se le asigna a otra según el reparto.
