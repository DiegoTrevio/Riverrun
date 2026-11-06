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

## Cotizar directo desde las instrucciones del agente

Sin armar nada: si tus precios y reglas están en las **instrucciones** o en la **información** del agente, el agente puede cotizar en el chat. Escribe cada operación con sus números, un renglón por concepto, y luego el subtotal, el IVA y el total:

```
Paneles: 40 ÷ 2.50 = 16 paneles × $1,000 = $16,000
Postes: 16 + 1 = 17 postes × $400 = $6,800
Subtotal: $22,800
IVA (16%): $3,648
Total: $26,448
```

**El sistema rehace cada cuenta** antes de enviar (`src/engine/arithmetic.ts`). Si la IA se equivocó en una multiplicación, una suma, el IVA o el total, el sistema la corrige, y también todo lo que depende de ella. Una división puede redondearse a entero («hacia arriba»). Una cuenta solo vale si cada número sale de un lugar confiable:

- un precio del negocio;
- un porcentaje del negocio (el IVA);
- un resultado anterior de la misma respuesta;
- una cantidad que dijo el cliente, que solo puede multiplicar: el cliente no dicta precios ni descuentos.

Un precio inventado, o un importe sin la operación de la que sale, sigue sin enviarse. Para PDF, folios y aprobación usa el cotizador escrito o la lista de precios (abajo).

## Cotizador escrito: cotizar con tus reglas

Úsalo cuando el precio **depende de los datos del cliente**: medidas (metros, m²), opciones (modelo, altura, acabado), escalones por cantidad, extras que solo van si los pide o casos que debe ver un asesor. Con la lista simple de arriba la IA solo elige conceptos y cantidades; con el cotizador **el sistema hace todas las cuentas** con tus reglas.

### Cómo se arma

En **el agente → Cotizaciones → «Productos, precios y reglas»**:

1. **Escribe** tus productos, precios y reglas como se los explicarías a alguien nuevo. Si no sabes por dónde empezar, toca **«Empezar con un ejemplo»** y elige el de tu giro (cercas y mallas, pintura por m², salón y eventos, servicios por hora, productos con mayoreo, renta por días); luego cambia sus precios y reglas por los tuyos.
2. **«Armar cotizador»** (tarda uno o dos minutos). El sistema lo entiende **una sola vez** y te muestra, **sin guardar nada**:
   - lo que entendió: los datos que pedirá al cliente, los casos que atiende un asesor y la tabla de precios;
   - **cotizaciones de ejemplo calculadas por el sistema** con tus reglas;
   - lo que **no quedó claro** y las **combinaciones sin precio** (si un cliente las pide, pasa con un asesor);
   - **«Probar con otros datos»**: cotiza el borrador con los datos que escribas.
3. Si los ejemplos están bien, **«Activar en este agente»**. Desde ahí el agente cotiza con eso. Queda en el historial de versiones del agente.

**Qué escribir** (lista para revisar tu texto):

- **Qué datos pedir** y sus opciones: «pide metros lineales, modelo (Recta o Clásica), altura (1.50 o 2.00 m)».
- **Cómo salen las cantidades**: «paneles = metros ÷ 2.50, hacia arriba; postes = paneles + 1».
- **Precios de cada producto**, con sus variantes y escalones: «Panel Clásica 2.00 m: A $1,050, B $1,000».
- **Escalones**: «A menos de 15 m; B de 15 a menos de 50».
- **Extras que solo van si el cliente los pide**: «instalación solo si la pide: $598 por metro» (el agente no los pregunta).
- **Cuándo lo atiende un asesor**: «de 100 metros o más», «más de 50 m de instalación».
- **IVA** si es distinto al de tus ajustes («los precios ya incluyen IVA») y la **leyenda** («aproximado, sujeto a visita; vigencia 15 días»).

Ejemplo corto:

```
Para cotizar pide: metros lineales, modelo (Recta o Clásica) y fijación (con placa o cimentado).
Paneles = metros ÷ 2.50 hacia arriba. Postes = paneles + 1. Una placa por poste solo si es con placa.
Escalones: A menos de 15 m; B de 15 a menos de 50. De 50 metros o más lo atiende un asesor.
Precios (más IVA): Panel Clásica: A $1,050, B $1,000. Poste: A $420, B $400. Placa: A $90, B $80.
Instalación solo si la piden: $598 por metro. Aclara que es aproximado y sujeto a visita.
```

### Qué recibe el cliente

- El agente **pide un dato a la vez**; si el cliente da varios juntos («40 m de la clásica, cimentada»), cotiza de inmediato.
- Si un dato no está entre las opciones («3 metros de alto»), le dice cuáles hay.
- Con los datos, el sistema calcula y envía, según elijas en *Cómo se envía*:
  - **el desglose en el chat**: cada concepto con cantidad × precio = importe, subtotal, IVA, total, que es APROXIMADA, la vigencia y tu leyenda;
  - **el PDF** con tu formato.
- Si una regla lo indica (p. ej. 150 metros cuando el límite es 100), **pasa con un asesor de inmediato**, sin pedir más datos. Si falta un precio en tu lista, también pasa con un asesor y **el equipo recibe qué precio falta**.
- Cada cotización guarda **la calculadora, su versión y los datos del cliente**: se puede reproducir.

### Cambiarlo después

- Edita el texto y **vuelve a armarlo** y activarlo. La versión sube; los precios que quitaste del texto **se apagan, no se borran**.
- Una calculadora armada a mano o importada **no se pisa**: el texto crea la suya.
- En **Cotizaciones → Calculadoras** ves cada calculadora: qué agente la usa, sus precios, lo que pide, sus reglas y el texto del que salió. Puedes **probarla con datos**, apagarla o encenderla, **exportarla** (con su texto y sus precios), **importar** una (llega apagada) o eliminarla.
- En **Cotizaciones → Lista de precios** puedes **subir o bajar la lista en CSV** (de Excel). Al subir, primero ves cuántos se crean y actualizan (o los errores por fila); nada se guarda hasta «Confirmar». Cada columna extra (producto, altura, escalón…) es un atributo.
- **Superadmin:** en el detalle de una calculadora, **«Copiar a otra cuenta»**, con o sin sus precios (llega apagada).

### Con el Copiloto

- «Arma mi cotizador con estos precios y reglas: …» → `armar_cotizador` prepara el borrador y te muestra en la tarjeta lo que entendió y los ejemplos; **solo se activa al confirmar**, y se activa exactamente lo que viste. «Deshacer» regresa el agente como estaba (los precios guardados se quedan).
- «Vuelve a armar el cotizador» usa el texto que ya tiene el agente.
- «¿Cuánto saldría 40 metros de clásica cimentada?» → `probar_cotizador` calcula con el cotizador del agente, sin guardar ni enviar nada.

### Costo y modelo

Armar usa IA una vez por armado (de US$0.01 a US$0.05 según el texto); se cobra del presupuesto de IA de la cuenta como «Cotizador escrito». Cotizar con el cotizador ya armado no usa IA para las cuentas. El modelo es `OPENROUTER_QUOTE_BUILDER_MODEL` (por omisión `google/gemini-3.8-flash`, que en las pruebas armó todos los giros a la primera).

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
- **Con cotizador** (arriba), la IA ni siquiera elige conceptos: solo junta los datos que pide la calculadora, cada uno con las palabras del cliente; el validador revisa que el cliente los dijo, que las opciones existen y que los números coinciden.
- **El sistema calcula** importes, IVA y totales, en centavos enteros. Si la IA escribe un total o una suma propia, el validador lo rechaza porque no está en la información del negocio, y le pide otra respuesta.
- **Montos tapados**: «$XX,XXX», «$###», «[precio]» o «{total}» nunca llegan al cliente, en ninguna cuenta: el validador los rechaza y, si insiste, quita esa frase.
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
