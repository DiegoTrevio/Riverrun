# Ficha de contacto y presupuesto de IA

Esta continuación implementa los siguientes dos puntos de producto: encontrar y retomar a una persona desde una ficha unificada, y controlar el gasto de IA de cada perfil. Reutiliza la bandeja, el editor de datos, pendientes, agenda, notificaciones y proveedores existentes. No añade servicios ni dependencias de producción.

## Contactos dentro de Conversaciones

La pestaña **Contactos** reúne los canales con el mismo teléfono normalizado de 10–15 dígitos **dentro del mismo perfil**. La ficha muestra datos y notas con su canal de origen, etiquetas, pendientes, citas próximas, conversaciones, datos de cada conversación, solicitudes y resúmenes. Desde la lista se abre la ficha y se retoma la conversación en dos acciones. El enlace de una cita abre la semana correspondiente en la agenda.

No se fusionan filas ni se sobrescriben respuestas distintas. Registros sin teléfono permanecen separados, aunque compartan nombre o un teléfono escrito en sus respuestas. No se agrupa por similitud, por los últimos dígitos ni entre perfiles. Editar datos sigue abriendo el editor del canal, con su comprobación de versión actual. El formulario de pendientes es el mismo de las conversaciones.

Los filtros incluyen **con pendientes**, **sin asignar**, **con citas próximas**, nombre/teléfono y etiqueta. Cada usuario puede guardar sus vistas en PostgreSQL; pertenecen a su usuario y perfil, sin almacenar fichas de clientes en localStorage. El listado pagina grupos de 50 y el perfil enlaza el historial de sus últimas 100 conversaciones. Los permisos se aplican antes de agrupar: un operador solo cuenta y ve los registros/conversaciones que tiene asignados; los pendientes y citas asociados a conversaciones ajenas se excluyen. Un teléfono igual en otro perfil no aporta datos ni contadores.

## Presupuesto por perfil

En **Configuración → Consumo de IA**, selecciona el perfil y define un límite diario o mensual en USD; en las opciones adicionales puedes limitar modelos por día/mes. Los periodos comienzan en UTC. Vacío conserva el uso sin límite; cero bloquea nuevas llamadas con costo, aunque permite modelos explícitamente confirmados como gratuitos. Los perfiles existentes mantienen límites desactivados hasta configurarlos.

Antes de cada respuesta, revisión de afirmaciones, resumen, importación, prueba del agente, embedding o transcripción atribuida al perfil:

1. Se bloquea transaccionalmente el presupuesto del perfil en PostgreSQL, compartido entre procesos.
2. Se consulta una tarifa declarada y se reserva la estimación conservadora del pedido y de los posibles modelos de respaldo. Se consideran gastos y reservas del periodo; no basta comprobar el saldo después de llamar.
3. Si falta un precio, hay un importe sin determinar o no cabe la reserva en un límite aplicable, el proveedor no recibe la petición. Las respuestas del agente pasan inmediatamente al equipo con el mensaje de transferencia configurado. No se reintenta la IA para superar el límite ni se explica el presupuesto al cliente.
4. Tras la respuesta se concilia el costo informado por el proveedor o una estimación basada en uso y tarifas congeladas al iniciar. Las reservas de modelos de respaldo no usados dejan de consumir el límite de esos modelos.

Las tarifas se obtienen del catálogo del master o de precios declarados para el perfil. Un precio en cero **no** significa gratuito automáticamente: hay que confirmarlo como gratuito. Los alias `openai/` y versiones con fecha comparten el límite del modelo lógico. Una llamada bajo un límite usa el adaptador con un solo intento: un timeout no provoca reenvíos internos ocultos del proveedor.

El panel separa importes informados, estimados/confirmados, reservas e importes sin determinar. Los importes muy pequeños se conservan con 14 decimales y se muestran como menores que US$0.0001 cuando corresponde, en lugar de aparentar gratuidad. Se avisa al master y administradores al acercarse al 80 %, al bloquear nuevas llamadas o cuando un costo necesita revisión, con deduplicación diaria por motivo.

### Incertidumbre y revisión

Un rechazo definitivo anterior al procesamiento libera su reserva. Un error de red, timeout, HTTP 5xx o error incluido en un HTTP 200 conserva el importe reservado; no se asume que no cobró. Un modelo inesperado mantiene el costo informado si existe y marca la anomalía; sin un importe verificable bloquea nuevos gastos limitados. Las tarifas y la revisión del presupuesto quedan en el registro de cada operación sin texto del cliente ni teléfonos.

Al consultar el panel, una reserva que supera cinco minutos o tres tiempos máximos del proveedor más un minuto pasa a revisión, **sin liberar saldo**. Un administrador del perfil puede confirmar un importe después de comprobarlo con el proveedor, incluyendo cero si confirma un rechazo sin cobro; la acción exige un motivo y queda registrada. No puede confirmar entradas de otro perfil. Los cambios del presupuesto usan revisión optimista para evitar que otra sesión los sobrescriba.

La migración importa el histórico existente: los costos positivos se identifican como estimaciones históricas y los ceros sin evidencia se dejan pendientes. Las importaciones de texto sin modelo ni tokens no se convierten en gastos pendientes ficticios. No se recalcula el histórico al editar una tarifa.

### Límites prácticos

- La reserva utiliza bytes UTF-8, el esquema, margen de protocolo y límite de salida. Las peticiones con imagen/archivo reservan al menos un millón de tokens de entrada por parte multimodal, de forma deliberadamente conservadora. Puede requerirse más saldo disponible que el costo final.
- Las notas de voz de OpenRouter se presupuestan con el tamaño del audio y un margen de salida. Audio cobrado por minuto sin duración verificable se bloquea si hay un límite aplicable; la conversación conserva su atención manual. No se inventa una duración a partir de bytes para autorizar gasto limitado.
- Cambiar un límite no cancela una llamada ya enviada. Un importe informado superior a la reserva se conserva y genera aviso; los gastos nuevos se comprueban con ese importe. Esto controla autorizaciones de la app, no garantiza una factura externa frente a tarifas declaradas incorrectas o cambios de precio del proveedor.
- Encendido/pausa, atención manual, envíos programados y las citas existentes conservan sus controles actuales. Las comprobaciones sintéticas globales del proveedor desde CLI, sin un perfil asociado, siguen siendo operaciones de diagnóstico del administrador, fuera de los presupuestos de perfiles.
- Cambiar la configuración del presupuesto invalida la aprobación de pruebas del agente porque afecta su comportamiento y límite de salida. Una transferencia causada por falta de presupuesto no certifica una prueba de prompt como aprobada.

## Migración y operación

Aplicar `048_contacts_ai_budgets.sql` con el proceso habitual antes de servir el código nuevo. Añade vistas personales, configuración y registros monetarios, índices por cuenta/fecha y teléfono, y confirmación explícita de tarifas gratuitas. Conserva contactos, agenda, canales, prompts y roles actuales. No cambia límites de perfiles por su cuenta ni necesita Redis, otro worker o otro proveedor.

Al retirar la interfaz nueva conserva los registros monetarios e historial; no elimines reservas inciertas para recuperar saldo sin revisar cargos. Volver a un servidor anterior elimina la comprobación previa de gasto, por lo que no es un mecanismo para mantener presupuestos activos. Las tarifas y cambios manuales se revisan en los registros de administración.

## Aceptación verificable

- Dos canales del mismo teléfono/perfil aparecen en una ficha sin cambiar filas de contacto ni perder respuestas distintas.
- Un operador no ve datos, resúmenes, citas, pendientes ni contadores de canales ajenos; otro perfil con el mismo teléfono permanece separado.
- Los filtros y vistas guardadas funcionan en otro dispositivo con el mismo usuario y perfil.
- Al agotar el presupuesto no se envía una solicitud a IA; se preserva la atención manual y se avisa al equipo.
- Veinticinco peticiones simultáneas respetan las reservas, sin exceder el cupo ni bloquear el pool.
- Un error incierto conserva el saldo; un rechazo confirmado lo libera; una revisión no modifica gastos de otro perfil.
- Modelos de respaldo y alias no eluden el límite; cargos pequeños o desconocidos no se consideran gratuitos por redondeo o falta de tarifa.
- Los formularios son utilizables con teclado, sin errores graves de accesibilidad ni desbordamiento en 1.366, 768 y 390 píxeles.

`test/contact-budget.test.ts` valida los casos anteriores con PostgreSQL real y proveedor sintético. `npm run test:contact:ux` crea una base temporal local y recorre lista, ficha, pendientes, vista guardada y presupuesto en Chromium. CI ejecuta esta prueba y las regresiones generales, de agentes y activación semántica. Ninguna de estas pruebas genera facturación ni envíos de producción.

## Evidencia de verificación (2026-10-13)

| Comprobación | Resultado |
|---|---|
| Suite general PostgreSQL/pgvector | 821 casos: 808 aprobados, 0 fallidos, 13 omitidos que requieren Evolution real |
| Rutas modificadas, migraciones, permisos, versiones, límites e importaciones | 74/74 aprobados |
| Última regresión de presupuestos, embeddings y permisos | 46/46 aprobados; incluye la comprobación de orden entre presupuesto monetario y cuota de tokens añadida después de la suite general |
| Promptfoo de contexto y del motor | 6/6 y 24/24 aprobados |
| Contactos y presupuesto en Chromium | 8 comprobaciones y 9 combinaciones de pantalla/ancho aprobadas |
| Interfaz general | 15 comprobaciones, 44 pantallas y 60 escenarios adaptables aprobados |
| Versiones/pruebas de agentes | 8 comprobaciones aprobadas y caso exportado 1/1 en Promptfoo |
| Activación semántica | 5 comprobaciones aprobadas |
| Build, revisión del panel y diff | Aprobados |

Las pruebas usaron bases locales sintéticas independientes y proveedores simulados. No se cambiaron límites de perfiles desplegados, no se generó gasto real ni se entregaron mensajes a teléfonos reales. La migración y activación de límites quedan para el despliegue normal y configuración del perfil.
