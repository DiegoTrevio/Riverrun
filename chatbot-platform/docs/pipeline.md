# Pipeline: columnas por las que avanza cada cliente

Un pipeline muestra en columnas en qué va cada solicitud de un cliente, por ejemplo
**Nuevo → Interesado → Cotizado → Ganado / Perdido**. Las tarjetas se mueven solas según lo que pasa en la conversación
y también se pueden mover a mano. Está en **Conversaciones → Pipeline**.

## Configurarlo

- Una cuenta puede tener **varios pipelines** (p. ej. «Ventas» y «Soporte»). **Cada agente usa uno**: al asignarle un
  pipeline nuevo, deja el anterior.
- Cada columna tiene nombre, color y tipo: **en curso**, **ganada** (cierra bien) o **perdida** (cierra mal). La primera
  es donde entra cada solicitud nueva y siempre es «en curso».
- **¿Cuándo pasa a esta columna?** Se describe con palabras del negocio («Ya se le dio al cliente un precio»). La IA lo
  detecta en cada intercambio, contando lo que dice el cliente y lo que ella responde.
- **También pasa aquí cuando…** Eventos que no dependen de la IA:
  - se cumple el objetivo del agente;
  - agenda o cancela una cita;
  - pasa con una persona;
  - se captura un dato (una clave concreta o `*` para cualquiera);
  - se agrega una etiqueta.
- **Permitir regresar sola**: por omisión una tarjeta solo avanza; con esta opción, la IA o un evento pueden regresarla a
  una columna anterior.

Al crear un pipeline se parte de una plantilla de ventas (Nuevo, Interesado, Cotizado, Ganado, Perdido) que se puede
cambiar por completo. Renombrar una columna conserva sus tarjetas. Si se borra una columna, sus tarjetas pasan a la
primera.

## Cómo se mueven

1. La tarjeta se crea en la primera columna con el primer mensaje de la solicitud. Solo las conversaciones reales entran
   al pipeline; las del simulador no.
2. Cuando la situación de una columna se cumple o pasa uno de sus eventos, la tarjeta pasa ahí:
   - si varias columnas aplican a la vez, va a la que está más adelante;
   - hacia atrás solo se mueve sola si el pipeline lo permite;
   - las columnas de ganadas y perdidas se alcanzan desde cualquier columna.
3. En una columna de **ganadas o perdidas**, la tarjeta ya no se mueve sola.
4. Si la respuesta de la IA no pasa la validación (por ejemplo, inventó un precio) y sale el mensaje de respaldo, la
   tarjeta no cambia de columna.
5. **A mano** (arrastrando la tarjeta o con «Mover a…») se puede llevar a cualquier columna.

Cada movimiento queda en el historial de la tarjeta: de dónde a dónde, por qué y quién la movió (la IA, un evento o una
persona). Ese historial se ve en la conversación, dentro de «Pipeline».

## Solicitudes nuevas

La tarjeta es de la **solicitud**, no del cliente (ver [solicitudes](solicitudes.md)). Cuando el cliente vuelve por otra
(después del tiempo configurado, porque la IA detecta que pide lo mismo otra vez, porque se reabre o por una campaña):

- la tarjeta anterior se cierra. Si estaba en una columna intermedia pasa a **ganada** si cumplió el objetivo o a
  **perdida** si no (cuando el pipeline tiene esas columnas);
- empieza una tarjeta nueva en la primera columna.

Reiniciar las conversaciones por un cambio en el agente **no** cierra la tarjeta: lo que pidió el cliente no cambió.

El tablero muestra:

- las tarjetas abiertas;
- las ganadas y perdidas de los últimos 30 días (o el periodo que se elija).

Quien atiende conversaciones (rol agente) ve solo las tarjetas de las conversaciones que tiene asignadas.

## Avisos e integraciones

- **Avisos y reglas**: en Automatización hay un disparador **«Una solicitud cambia de columna en el pipeline»** (filtra
  por pipeline y columna). Sirve, por ejemplo, para avisar al equipo cuando una venta llega a «Ganado».
- **Webhooks**: el evento `pipeline.stage_changed` envía el contacto y la conversación, con:

```json
"pipeline": { "id": "…", "name": "Ventas", "stage_id": "ganado", "stage_name": "Ganado", "stage_kind": "won",
              "from_stage_id": "cotizado", "from_stage_name": "Cotizado", "reason": "Se cumplió el objetivo" }
```

## Para la IA

En la configuración del agente se agrega la sección «Pipeline «nombre»» con las columnas que se detectan por contexto,
cada una con su identificador (`etapa_<columna>`). La IA lo devuelve en `intents` cuando la situación se cumple. En el
estado de la conversación va la columna actual, para que la IA sepa en qué columna va la solicitud y si ya terminó. El
backend decide si el movimiento procede; la IA solo lo propone.
