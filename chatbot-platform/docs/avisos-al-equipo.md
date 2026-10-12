# Avisos al equipo

En **Agente → Configurar → Avisos al equipo** se elige en qué momentos avisarle al equipo de lo que pasa en las conversaciones de ese agente.

## Cuándo avisar
- **Se cumple el objetivo** (si el agente tiene objetivo).
- **Llega a una etapa del recorrido** (si tiene etapas).
- **En un contexto que describes**, por ejemplo «El cliente quiere cotizar un evento para más de 50 personas». La IA revisa cada mensaje del cliente y avisa cuando se cumple, aunque no use esas palabras. Se guarda como una intención con identificador `aviso_…`.
- **El cliente da un dato** (uno en particular o cualquiera).
- **La conversación pasa a una persona.**
- **El cliente escribe ciertas palabras.**

## Qué recibe el equipo y a quién
- **Un aviso corto** con el mensaje que escribas (admite `{{cliente}}`, `{{mensaje}}`, `{{dato.CAMPO}}`, etc.), o **el reporte de la conversación** (resumen, análisis y datos).
- Lo reciben administradores y/o agentes en el panel y, quien lo tenga activado en su perfil, por WhatsApp. También se pueden agregar teléfonos sueltos. Un agente solo recibe avisos de las conversaciones que tiene asignadas.

## Solo una vez por conversación
Viene marcado por omisión. El mismo aviso no se repite en la conversación aunque el contexto vuelva a salir en otros mensajes. Se cuenta **por recorrido**: si la conversación se reinicia o se cierra y se reabre, puede volver a avisar. Si dos mensajes llegan al mismo tiempo, solo uno dispara el aviso. La opción también está en el editor de cualquier regla de Automatización.

## Cómo funciona por dentro
Cada aviso es una regla de **Automatización** limitada a ese agente, con la acción «Alertar al equipo» o «Enviar reporte». Por eso también aparece en Automatización → Reglas, donde se le pueden agregar condiciones (horario, canal, etiquetas, valor de un dato) u otras acciones. Desde el agente se puede activar, desactivar, editar o quitar.

Pruebas: `test/notices.test.ts` (objetivo, etapa, contexto, una vez por conversación y reinicio).
