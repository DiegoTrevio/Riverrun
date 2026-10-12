# Solicitudes: cuando el cliente vuelve por lo mismo

Una conversación puede tener varias **solicitudes**: la misma persona vuelve a reservar, el problema regresó, o pide otra vez el mismo servicio o la misma información. Cada solicitud se atiende de nuevo, completa.

## Cuándo empieza una solicitud nueva
- **Por tiempo:** el cliente escribe después de cierto tiempo sin actividad. Se configura por agente en **Instrucciones**, debajo del Objetivo («Si el cliente vuelve por lo mismo…») (por omisión **24 horas**; con 0, el tiempo no abre solicitudes). Solo aplica cuando el asistente atiende; si una persona del equipo atiende, no.
- **Por contenido:** en una conversación activa, la IA detecta que el cliente pide otra vez algo que ya se le resolvió («quiero reservar otra vez», «se volvió a descomponer»). El motor abre la solicitud y vuelve a pensar la respuesta con ella.
- **Seguro contra repetir:** por contenido solo se abre si la solicitud actual ya cumplió su objetivo o empezó hace al menos **30 minutos**. Antes de eso, repetir la pregunta es seguir la misma solicitud: el asistente recuerda brevemente lo que ya dijo y agrega algo útil, sin copiar su respuesta.
- También empiezan una solicitud: reabrir una conversación cerrada, una campaña con «Etapa del recorrido al enviarla» y «Reiniciar conversación(es)».

## Qué vuelve a contar en cada solicitud
- El objetivo (y lo que hace al cumplirse: transferir, avisar, reporte), las etapas, las fotos de etapa y de objetivo, las fotos y avisos «una vez», y «terminó las preguntas».
- **Preguntas:** cada una tiene «Se vuelve a preguntar en cada solicitud nueva». Por omisión, todas menos nombre, correo y teléfono. Las respuestas de la solicitud anterior se archivan en su historial y se quitan de los datos del cliente, así que se vuelven a preguntar. Una respuesta que el cliente dio en una solicitud anterior no contesta la pregunta de nuevo, aunque la IA la repita.

## Qué ve la IA
En «Qué toca ahora»: qué solicitud es (por ejemplo, la 3.ª), cuándo empezó y las dos anteriores, con si cumplieron el objetivo y sus respuestas. Se le indica que atienda de nuevo con normalidad y que, si ayuda, mencione lo de la vez anterior para confirmarlo, sin darlo por hecho. Con el objetivo ya cumplido, se le indica que marque `new_request` si el cliente pide otra vez lo mismo.

## Qué ves en el panel
En la conversación, «Solicitudes»: cada una con su fecha, por qué empezó (volvió después de un tiempo, pidió otra vez lo mismo, se reabrió, una campaña, se reinició), si cumplió el objetivo y sus respuestas.

## Detalles
- Las solicitudes se guardan en `conversation_requests` (migración 042). La primera se registra cuando empieza la segunda.
- Si llegan dos mensajes seguidos después del tiempo sin actividad, solo el primero abre la solicitud (el segundo ya tiene actividad reciente).

Pruebas: `test/requests.test.ts` (tiempo, contenido, seguro, reapertura, preguntas que se repiten o no, respuestas anteriores, objetivo y avisos que vuelven a contar).
