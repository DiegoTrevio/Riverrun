# Campañas por correo

Riverrun puede mandar campañas por correo a una base de clientes, contestar con el asistente lo que respondan y darles seguimiento. Todo usa el canal de correo por reenvío ([integraciones, sección 4](integraciones.md)) y las mismas campañas, segmentos, bajas y consentimiento que WhatsApp.

## 1. Cargar una base de correos

**Contactos → Importar contactos**, eligiendo el canal de correo:

- Un CSV con encabezados (coma o punto y coma). Obligatoria: `correo` (también se reconoce `email`). Opcionales: `nombre`, `telefono`, `etiquetas` (separadas por punto y coma, o por `|` si el archivo usa punto y coma) y una columna por cada dato de tus clientes.
- Hasta 5,000 filas por archivo. Los correos se guardan en minúsculas; uno inválido o repetido no se importa y el resumen dice en qué fila.
- **De dónde salió la base** (obligatorio): queda en cada contacto como «importación: …». Es tu constancia si alguien pregunta cómo obtuviste su correo.
- **«Estas personas aceptaron recibir correos de mi negocio»**: si la marcas, cada contacto nuevo queda con consentimiento (fecha de hoy y el origen). Si no, se importan sin él y, con **Ajustes → Consentimiento** activado (viene así), las campañas no les llegan hasta que acepten.
- Nunca se quita una baja ni se cambia un consentimiento que ya estaba. La **lista de bajas** es por negocio y por correo (tabla `email_suppressions`): quien se dio de baja, rebotó o se quejó de spam sigue fuera aunque venga en otro archivo o en otro canal de correo.
- Importar no dispara reglas ni manda correos.

No uses bases compradas o copiadas: los correos a gente que no te conoce terminan en spam, dañan la entrega del dominio y en México (LFPDPPP) y Estados Unidos (CAN-SPAM) puedes tener problemas.
