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

## Al agendar a mano

En *Nueva cita* se puede elegir quién atiende entre las personas libres en ese horario, o dejar «A quien le toque».

## Al reprogramar

La cita se queda con la misma persona si está libre a la nueva hora; si no, se le asigna a otra según el reparto.
