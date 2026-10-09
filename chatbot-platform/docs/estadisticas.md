# Estadísticas

Menú **Operación → Estadísticas** (solo administradores). Muestra conversaciones, mensajes, citas, costo de IA y el reparto de trabajo por persona del equipo.

## Periodos

- **Hoy**, **Esta semana** (desde el lunes hasta hoy), **Últimos 7, 15, 30, 60 o 90 días** (cuentan hoy) y **Rango de fechas** (con inicio y fin, hasta 366 días).
- Los días se cuentan en la **zona horaria de la cuenta** (Ajustes). Un mensaje de las 23:30 cuenta para su día local.
- Cada cifra se compara con el **periodo anterior** del mismo largo (las flechas ▲ ▼ muestran la variación).
- La pantalla se **actualiza sola cada 30 segundos**; el botón *Actualizar* la refresca al momento.

## Cifras

| Cifra | Qué cuenta |
|---|---|
| Conversaciones nuevas | Conversaciones creadas en el periodo. |
| Mensajes recibidos | Mensajes de clientes. |
| Respuestas del asistente / de personas | Mensajes enviados con estado correcto, por el asistente o por una persona del equipo. |
| Citas en el periodo | Citas cuya hora de inicio cae en el periodo, por estado (confirmadas, completadas, canceladas, no llegaron) y por origen (asistente o panel). |
| Primera respuesta | Promedio de minutos entre el primer mensaje del cliente en el periodo y la primera respuesta del asistente o de una persona. |
| Costo de IA | Suma del costo de las llamadas de IA del periodo. |
| Abiertas ahora / Esperan a una persona / Sin persona asignada | Fotografía del momento, no depende del periodo. |
| Mensajes fallidos | Respuestas que no se pudieron enviar (revisa *Registros*). |

Las conversaciones del simulador del panel no cuentan en ninguna cifra.

## Por persona

- **Conversaciones recibidas**: conversaciones que pasaron a esa persona en el periodo, ya sea por turnos, a mano o al tomarlas. Una conversación reasignada cuenta para quien la tuvo y para quien la recibió.
- **Por turnos** y **Manuales**: cómo llegó la conversación. *Por turnos* viene del reparto round robin; *Manuales* incluye las asignadas desde el panel, las tomadas por la persona y las asignadas por la API.
- **% por turnos**: la parte de las asignaciones por turnos que recibió cada persona. Sirve para comprobar que el reparto sea parejo.
- **Abiertas ahora**: conversaciones que tiene hoy, sin cerrar.
- **Mensajes**: respuestas que la persona envió desde el panel.
- **Citas**: citas asignadas a la persona en el periodo (sin canceladas).

## Historial

- Desde esta versión, cada asignación queda registrada en `conversation_assignments` (quién, cuándo y cómo).
- Las asignaciones que ya existían se importaron como origen **anterior**: solo se conserva la última persona de cada conversación, y no se pueden separar por turnos o manuales.
- Los mensajes enviados antes de esta versión no tienen registrado quién los envió; aparecen en las cifras del equipo solo desde el cambio.

## Límites

- El rango máximo es de 366 días.
- Las cifras se calculan al abrir la pantalla y cada 30 segundos; no hay actualización en tiempo real por conexión.
- Los operadores no ven estas estadísticas; el administrador de la cuenta sí, y el maestro las ve de cada cuenta eligiéndola.
