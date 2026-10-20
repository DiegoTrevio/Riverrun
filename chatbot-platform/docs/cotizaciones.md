# Cotizaciones en PDF

El agente entrega cotizaciones formales en un archivo con el formato del negocio. El sistema solo llena ese formato con:

- lo que dio el cliente;
- los precios de la lista del negocio.

El cliente recibe un PDF. Tanto el archivo como el mensaje del chat dicen si es **APROXIMADA** o **FINAL**:

- **Aproximadas:** salen solas.
- **Finales:** alguien del equipo las aprueba antes de que lleguen al cliente.

## Cómo se usa

1. **Lista de precios** (menú *Cotizaciones → Lista de precios*). Cada concepto tiene:
   - nombre, unidad (servicio, pieza, persona, hora…) y clave;
   - uno de cuatro tipos de precio:

     | Tipo | Ejemplo | Cómo sale en la cotización |
     |---|---|---|
     | Exacto | $15,000.00 | Se suma tal cual. |
     | Desde | desde $1,200.00 | El total queda «desde». |
     | Rango | $3,000.00 a $5,000.00 | El total es un rango. |
     | Por confirmar | sin precio | «Por confirmar». |

   - el IVA: se suma, ya viene incluido o es exento.

   Cualquier concepto que no sea exacto hace que la cotización sea **aproximada**.
2. **Formato** (*Cotizaciones → Formatos*). Diseña tu documento en Word (logo, colores, condiciones) y escribe marcas donde va cada dato. Hay un formato de ejemplo para descargar y una vista previa en PDF. Si no subes ninguno, se usa el del sistema.
3. **Ajustes** (*Cotizaciones → Ajustes*):
   - IVA, moneda, vigencia y prefijo del folio;
   - las leyendas de aproximada y de final;
   - los datos del negocio que se imprimen.
4. **En el agente** (*Agente → Más ajustes → Cotizaciones*):
   - encender las cotizaciones;
   - elegir el formato;
   - permitir o no las finales;
   - elegir los datos que se piden antes de cotizar (por ejemplo, la fecha del evento).

## Marcas del formato

| Marca | Qué pone |
|---|---|
| `{{tipo}}` | COTIZACIÓN APROXIMADA o COTIZACIÓN FINAL (obligatoria) |
| `{{total}}` | Total con IVA: exacto, rango o «desde» (obligatoria) |
| `{{leyenda}}` | La leyenda de aproximada o de final (obligatoria) |
| `{{folio}}`, `{{fecha}}`, `{{vigencia}}`, `{{moneda}}`, `{{notas}}` | Datos de la cotización |
| `{{subtotal}}`, `{{iva}}`, `{{tasa_iva}}` | Desglose |
| `{{nombre}}`, `{{telefono}}`, `{{correo}}` | Datos del cliente |
| `{{cliente.clave}}` | Cualquier dato que pide el agente (p. ej. `{{cliente.fecha_evento}}`) |
| `{{negocio.nombre}}`, `{{negocio.telefono}}`, `{{negocio.correo}}`, `{{negocio.direccion}}` | Datos del negocio |
| `{{#conceptos}}` … `{{/conceptos}}` | Un renglón de tabla que se repite por concepto, con `{{concepto}}`, `{{descripcion}}`, `{{cantidad}}`, `{{unidad}}`, `{{precio_unitario}}` e `{{importe}}` |
| `{{#es_aproximada}}` … `{{/es_aproximada}}` | Texto que solo aparece en las aproximadas (igual con `es_final`) |

Al subir el formato el sistema lo revisa:

- marcas mal escritas;
- marcas desconocidas, que se muestran como aviso y quedarían vacías;
- marcas obligatorias que faltan.

Rechaza los archivos con macros, controles ActiveX, objetos incrustados o contenido que se carga de internet. Cada subida con el mismo nombre crea una versión nueva; las cotizaciones hechas conservan la suya.

## Qué hace el agente y qué hace el sistema

- **La IA solo elige** los conceptos (por su clave) y las cantidades. Cada cantidad debe venir de lo que escribió el cliente: se copian sus palabras («80 personas») y el validador revisa que estén en sus mensajes y que digan esa cantidad.
- **El sistema calcula** importes, IVA y totales, en centavos enteros. Si la IA escribe un total o una suma propia, el validador lo rechaza porque no está en la información del negocio, y le pide otra respuesta.
- **Antes de cotizar** se piden los datos que el negocio eligió. Si falta alguno, no hay cotización: el agente lo pide.
- **Una cotización abierta por solicitud.** Mientras una final está en revisión, el agente no prepara otra: le dice al cliente que el equipo la está revisando.
- **Aproximada:** en la misma respuesta salen tres mensajes:
  1. el texto de la IA;
  2. el mensaje del sistema con el total, que dice que es APROXIMADA y que el precio final puede cambiar;
  3. el PDF.
- **Final:** solo si el cliente la pide, todos los precios son exactos y el agente lo permite. Queda «Por aprobar»:
  - el equipo recibe un aviso;
  - el cliente recibe: «Tu cotización final la está revisando el equipo; te la enviamos en cuanto esté aprobada».
- **Canales que no envían archivos** (Telegram, Messenger, Instagram directo y el chat web): el cliente recibe un enlace firmado al PDF, que vence en 7 días.
- **Si el PDF no se puede generar:**
  - el cliente recibe «Estamos preparando tu cotización»;
  - la cotización queda «Con error»;
  - el equipo recibe un aviso y la reintenta desde la conversación.
- **Valor de la oportunidad:** al enviarse, la tarjeta del pipeline toma el total mínimo si todavía no tenía valor.

## Aprobación

En la conversación, la tarjeta **Cotizaciones** muestra las que están por aprobar o tienen error. El equipo puede:

- corregir cantidades, precios y conceptos (de la lista o libres), cambiar el tipo y las notas;
- **Aprobar y enviar**: recalcula, genera el PDF y lo envía una sola vez, aunque dos personas aprueben a la vez;
- **Rechazar**: con un motivo interno y, si quiere, un mensaje al cliente.

Una final necesita que todos los precios sean exactos. Solo los administradores aprueban, rechazan y editan.

Las cotizaciones se vencen solas cuando pasa su vigencia, con la fecha del negocio.

## Automatizaciones

Hay tres disparadores nuevos:

- **Se envía una cotización** (cualquiera, solo aproximadas o solo finales);
- **Una cotización final queda por aprobar**;
- **El equipo rechaza una cotización**.

## Privacidad

- **Exportar los datos de un contacto** incluye sus cotizaciones.
- **Borrar a un contacto**:
  - conserva el folio y los montos, porque son contabilidad;
  - borra sus datos y los archivos generados.
- **Exportación a CSV** en `/api/export/quotes.csv`.

## Servidor

- **Conversión a PDF:**
  - La imagen de Docker trae LibreOffice Writer y fuentes compatibles con Arial y Times (Liberation).
  - Fuera de Docker, instala LibreOffice (`soffice`) o usa un servicio Gotenberg con `QUOTE_PDF_URL`.
- **Cómo corre LibreOffice:**
  - Hace una conversión a la vez, con carpeta y perfil temporales.
  - Tiene un límite de tiempo (`QUOTE_PDF_TIMEOUT_MS`, 60 s por defecto) y reintenta una vez.
  - Si no está instalado, el servidor lo avisa al arrancar.
- **Archivos:** se guardan en `UPLOADS_DIR/<cuenta>/quotes/` y los formatos en `UPLOADS_DIR/<cuenta>/quote-templates/`.
