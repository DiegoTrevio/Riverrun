# Auditoría de UX/UI de Riverrun y plan de optimización

Fecha de referencia: 10 de octubre de 2026, UTC.

Este documento conserva la auditoría anterior a los cambios. Consulta [implementación y validación](implementation.md) para conocer la cobertura actual y las comprobaciones posteriores; los defectos descritos aquí no son una afirmación sobre la versión modificada.

## Resultado principal

La prioridad es hacer fiables la edición, la navegación y la información de estado. Hay problemas reproducidos que pueden hacer perder trabajo, duplicar solicitudes o mostrar una pantalla que no corresponde a la URL. Una renovación visual por sí sola no los resuelve.

La base actual permite evolucionar sin reescribir la aplicación: módulos ES pequeños, utilidades comunes de formularios, variables de diseño, menú simple, creación guiada, conectores, simulador, calendarios y automatizaciones existentes. Recomiendo conservar esa base y concentrar las mejoras en esos componentes.

La auditoría identifica **52 oportunidades**, ordenadas en cuatro fases. Cada una incluye evidencia, efecto sobre el usuario, solución, beneficio, complejidad y prioridad. Los impactos y beneficios esperados son hipótesis que deben medirse; los defectos marcados como reproducidos sí se comprobaron.

## Alcance y método

- Código examinado: los 27 módulos de `public/js`, entrada y estilos del panel, ayuda, widget de chat y las rutas/API que determinan permisos, guardado, límites, fechas, importación y lectura de conversaciones.
- Versión del código: `b51afbeaaac4b2bd3707a7df6ac46535fea41b50`, rama `codex/unified-agents`. Incluye la unificación del PR #12; al comprobar GitHub ese PR estaba abierto. `origin/main` seguía en `e877e39`. Los resultados describen esta versión del proyecto, no un despliegue confirmado.
- Navegador: Chromium con Playwright, aplicación servida por Fastify y PostgreSQL con pgvector en una base de pruebas aislada. Sesiones y permisos reales de maestro, administrador y operador. Evolution y la IA se simularon mediante el arnés del repositorio.
- **44 pantallas/variantes de rol** examinadas con axe-core 4.11.0, además de comprobaciones de contenido y solicitudes.
- **60 escenarios adaptables**: seis pantallas representativas, anchos de 320, 390, 768, 1024 y 1440 px, en claro y oscuro.
- Pruebas dirigidas: navegación rápida, fallos de carga y borrado, cambios sin guardar, actualización automática, envíos concurrentes, importación parcial, estado del agente y contraste de marca.
- `npm run check:frontend` y `npm run build` terminaron correctamente. La auditoría no cambió el código de la aplicación ni volvió a ejecutar toda la suite del motor.

No se midieron usuarios reales, tráfico de producción, lectores de pantalla ni el teclado virtual de Safari/Android. No se atribuyen porcentajes de abandono ni latencias reales de producción a la muestra local. Los conectores externos, la facturación y el correo no se probaron con credenciales reales.

## Inventario de recorridos revisados

| Área | Recorrido actual y observaciones |
|---|---|
| Acceso | Login, registro, recuperación y confirmación. El registro y la confirmación todavía llevan a `#/inicio`, el recorrido anterior de primeros pasos. Los formularios públicos se revisaron en código; el registro completo por correo no se ejecutó. |
| Navegación | Menú simple: Agentes, Conversaciones, Agenda, Ajustes y Notificaciones. Menú completo con grupos adicionales; maestro con selector de perfiles. Operadores limitados a conversaciones, agenda, avisos y perfil. |
| Agentes | Listado, asistente de cuatro pasos, edición, duplicación y eliminación. Siete pestañas: Instrucciones, Preguntas, Activación, Conocimiento, Fotos, Conexiones y Probar. |
| Conexiones | Crear y asignar canal desde el agente, QR/código por número, estado, configuración por plataforma, conexiones sin agente y reasignación. Límite de cuatro WhatsApp por cuenta y enlaces para repartir clientes. |
| Conocimiento | Importación por archivo/web/texto, revisión, edición, sincronización e información de preparación del índice. La preparación semántica se examinó en código; no se generaron embeddings reales durante esta auditoría. |
| Fotos y mensajes | Catálogo, descripción, pie, envío por contexto o reglas, mensajes guardados, máximos y restricciones. |
| Probar | Simulador, historial, datos capturados, resultados de reglas, reinicio y herramientas de prueba sin enviar mensajes. |
| Conversaciones | Filtros, búsqueda, exportaciones, chat, catálogo, atención humana, asignación, contacto, consentimiento, notas, tareas, citas, secuencias, resumen y privacidad. |
| Agenda | Semana, servicios, horarios, disponibilidad, citas/llamadas, reprogramación, cancelación y asistencia. |
| Automatización | Reglas, plantillas, condiciones, acciones, secuencias, campañas, audiencia, horarios, límites de envío, bajas, consentimiento y reparto. |
| Negocio y equipo | Ajustes, usuarios/permisos, perfil personal, integraciones, Google Calendar, webhooks y llaves de API. |
| Resultados y operación | Estadísticas, consumo, registros, supervisión, notificaciones, plan/pagos, perfiles de negocio, planes, marcas y sistema. |
| Chat del sitio | Widget con Shadow DOM, sesión, envío, lectura incremental, errores y accesibilidad de controles. Inspección de código; no incluido en las 44 pantallas de axe. |

### Elementos que conviene conservar

1. La relación perfil → agentes → conexiones y el aislamiento validado por el servidor.
2. Un agente para varios teléfonos, cuatro WhatsApp por cuenta y la conservación de contactos/historial al reasignar.
3. La creación transaccional del agente y los servicios; el guardado automático de respuestas y los controles de versión de datos del contacto.
4. El QR renovable, el código por teléfono y las instrucciones específicas de Android/iPhone. Ya hay indicadores de carga y reintento en ese conector.
5. Las opciones avanzadas plegadas, las fotos con carga diferida y los límites de tamaño/formato verificados por el servidor.
6. Las reglas, condiciones, secuencias, campañas, citas, consentimientos, bajas y límites de envío. Simplificar su presentación no debe cambiar su ejecución.
7. Las estadísticas existentes: ya conservan el cuadro anterior durante la actualización, descartan respuestas antiguas y tienen controles de teclado en gráficas. Son patrones reutilizables.
8. El bloqueo de envío del widget, los controles de espera del importador/asistente/reporte y el `dialog` nativo del envío de reportes. No todo requiere componentes nuevos.

## Evidencia de los problemas reproducidos

Los JSON contienen los detalles de las comprobaciones. Las cifras de axe describen pantallas que presentan cada regla, no defectos independientes ni una certificación WCAG.

| Prueba | Resultado observado | Consecuencia |
|---|---|---|
| Editar Instrucciones → Preguntas → Instrucciones, sin guardar | La edición desaparece. | Trabajo perdido al explorar la configuración. |
| Editar nombre del contacto, enfocar el redactor y esperar 5,6 s | El nombre vuelve al valor guardado. | La actualización automática elimina un borrador local. No se borró el dato de la base. |
| Enviar por Enter dos veces mientras la respuesta tarda | Dos POST en el simulador y dos en el chat manual. | El botón deshabilitado del simulador no protege el atajo de teclado. |
| Fallar un envío del simulador | El redactor queda vacío. | La persona debe volver a escribir o recuperar el texto del chat. El chat manual sí retuvo el texto en la prueba de fallo. |
| Fallar DELETE del agente con HTTP 503 | Se navega fuera de la ficha igualmente. | La navegación sugiere una acción terminada que el servidor rechazó. |
| Retrasar la primera carga de sesión durante dos navegaciones | URL `#/agentes`, encabezado de un agente individual. | Una respuesta vieja reemplaza el contenido de la ruta nueva. |
| Fallar `/api/me` con HTTP 503 al navegar | URL de Conversaciones, listado Agentes anterior y ningún error visible. | El usuario no entiende que la navegación falló. |
| Guardar cinco secciones importadas y fallar la tercera | Las dos primeras quedan guardadas. | Se produce una actualización parcial pese al único botón Guardar. |
| Conectar WhatsApp con el agente apagado | Aparece «Desde ahora tu asistente responde…». | Confunde conexión técnica con atención habilitada. |
| Aplicar marca blanca `#ffffff` en tema claro | Texto blanco sobre fondo blanco, contraste 1:1. | Una personalización válida puede hacer invisible la acción principal. |
| Abrir una secuencia a 390 × 900 px | La barra Guardar cubre el campo de hora: campo y=829,875–853,875; barra y=829,75–900. | Un formulario sin desbordamiento puede tener controles ocultos. |
| axe, tema claro, variantes examinadas | Contraste en 33/44; selectores sin nombre en 16/44; jerarquía de encabezados en 30/44. | Corregir reglas compartidas resuelve varios casos a la vez. Jerarquía es una recomendación de buenas prácticas, no por sí sola una infracción WCAG. |
| Contraste del texto secundario de Agentes | `#6b7280` sobre `#f5f6f8`: 4,47:1 para 15 px. | No alcanza 4,5:1 para texto normal. |
| Opciones `maxlength` en `text()` y `area()` | Ambos atributos resultan `null`. | Los límites declarados por varios consumidores no llegan al control. |
| Adaptabilidad de seis pantallas | 0 desbordamientos horizontales en 60 escenarios. | Conviene mantener la base adaptable; hace falta mejorar densidad, lectura y controles superpuestos. |
| Inicio Agentes, retraso artificial de 200 ms por API | Encabezado visible a los 1.487 ms en una ejecución. | Referencia reproducible de laboratorio, no p95 ni medición de producción. |

## Catálogo priorizado

**Tipo de evidencia:** **V** = reproducido en navegador/API; **C** = comprobado en código; **R** = recomendación de diseño sobre un comportamiento existente, pendiente de validar con usuarios. Una fila puede combinar tipos.

**Prioridad:** **P1** = antes del rediseño o antes de exponer un flujo irreversible; **P2** = simplificación de uso frecuente; **P3** = mejora posterior condicionada a métricas.

**Complejidad:** **Baja** = cambio localizado con componentes existentes; **Media** = varios componentes o contrato API; **Alta** = coordinación entre UI/API y persistencia o estados complejos. No equivale a un compromiso de fechas.

### Fase 1 — Corregir problemas críticos de usabilidad

| ID · Evidencia | Problema y efecto sobre el usuario | Solución concreta y reutilización | Beneficio esperado | Complejidad | Prioridad |
|---|---|---|---|---|---|
| 01 · V/C | Instrucciones, preguntas, reglas y asistente de creación usan borradores en memoria; navegar o recargar pierde trabajo. | Estado de edición por perfil/agente/sección; indicador Sin guardar; proteger salida y restaurar borradores de configuración. Reutilizar `saveBar`, `run` y el router. No autoguardar consentimientos ni cambios que activan atención. | Menos trabajo repetido y errores de publicación. | Media | P1 |
| 02 · V/C | El chat reconstruye Datos del cliente si el foco sale de la columna; borra cambios pendientes cada cinco segundos. | Mantener borrador hasta guardar/cancelar aunque cambie el foco. Actualizar únicamente datos no editados; conservar `base_data_version` y explicar conflictos. No persistir información personal en almacenamiento local para resolverlo. | Editar contactos sin carreras ni sobrescritura accidental. | Media | P1 |
| 03 · V/C | El router admite respuestas antiguas y oculta fallos de sesión; URL y pantalla pueden discrepar. | Usar un identificador de navegación/perfil y comprobarlo después de cada espera, antes de pintar o registrar temporizadores. Adoptar el patrón `seq` de Estadísticas. Estado de carga/error con Reintentar. Cancelar también redirecciones diferidas del QR al salir. | Navegación fiable incluso con red lenta y cambios de perfil. | Media | P1 |
| 04 · V/C | Enter permite dos envíos simultáneos; el simulador vacía el mensaje antes de conocer el resultado. | Guardar `sending` dentro de la función de envío, como en `widget.js`; cubrir botones, Enter y sugerencias. Conservar texto y estado fallido. Borrar solo el borrador que realmente se envió, no el siguiente texto escrito. No reintentar POST automáticamente sin idempotencia. | Menos duplicados y recuperación sencilla de fallos. | Media | P1 |
| 05 · V/C | Borrados y algunos cambios continúan con navegación/render aunque `run()` devuelve `undefined`. | Navegar/cambiar estado solo al confirmar éxito. Mostrar error junto a la acción; conservar el formulario y ofrecer reintento. Aplicar el patrón correcto ya usado en otros guardados. | El resultado visible corresponde al resultado del servidor. | Baja | P1 |
| 06 · V/C | Guardar la importación revisada hace hasta cinco escrituras independientes; un fallo deja información parcial. | Una transacción para las secciones revisadas. Reutilizar `withTransaction`, candado por agente y `upsertKnowledge` de `src/routes/import.ts`, aceptando las secciones editadas sin volver a consultar a la IA. Preservar revisión y mostrar diferencias antes de reemplazar. | Actualización completa o ninguna; sin perder correcciones. | Media | P1 |
| 07 · V/C | «Conectado», «Activo» y «Encendido» describen cosas diferentes; el QR promete respuestas con el agente apagado. | Distinguir conexión física, atención habilitada y estado por conversación. Éxito QR: «Teléfono conectado» y siguiente paso según estado real. Mostrar causas de pausa, activación por palabra y estado del perfil. Reutilizar `connectionBadge`, estados existentes y comprobaciones del motor. | El usuario sabe qué falta para recibir atención. | Media | P1 |
| 08 · C | Bandeja limitada a 100 filas por defecto y chat a los últimos 500 mensajes; no hay paginación ni Cargar anteriores. | Extender rutas actuales con cursor estable y metadatos `has_more`; Cargar más en bandeja y anteriores en chat. Mantener filtros, permisos y exportaciones. No descargar todo de golpe. | Encontrar clientes e historial antiguo sin perder capacidad ni velocidad. | Media | P1 |
| 09 · C | Filas de conversaciones, servicios, reglas y avisos se abren solo con `onclick` en `tr`; no se alcanzan con Tab. | Poner un enlace real en la celda principal de cada fila y mantener opcional el clic de fila. Botones separados para acciones; nombres de controles contextualizados. | Tareas centrales utilizables por teclado y lector de pantalla. | Baja | P1 |
| 10 · V/C | Los filtros de bandeja/registros y varios selectores del maestro carecen de nombre accesible. | Etiquetas visibles mediante `field()` o `label` asociado; `aria-label` cuando el diseño lo justifique. Añadir `aria-describedby` para ayudas y errores. «Perfil» debe estar asociado al selector, no ser un `label` suelto. | Filtros comprensibles y operables con tecnologías de asistencia. | Baja | P1 |
| 11 · V/C | La barra sticky cubre un control en móvil; los campos de hora/fecha no comparten el alto de los demás. | Reservar el espacio de la barra y ajustar `scroll-padding`/`scroll-margin`; no superponer varias barras. Estilizar fecha/hora/teléfono. Verificar controles enfocados y teclado virtual, no solo ancho total. | Completar formularios sin campos escondidos. | Media | P1 |
| 12 · V/C | El texto secundario no alcanza contraste AA en varias superficies; la marca admite acciones 1:1. | Ajustar tokens y calcular/validar el color de texto al aplicar una marca, con variante para enlaces y fondos. Conservar personalización y ofrecer alternativa legible; no depender del color para indicar estado. | Lectura fiable en ambos temas y marcas. | Media | P1 |
| 13 · V/C | Errores solo en toast temporal sin `role`/`aria-live`; `text()`/`area()` ignoran opciones de límites y los mensajes muestran claves técnicas de la API. | Ampliar las utilidades existentes para atributos de formulario; validación vinculada al campo y resumen enfocable; `role=status` para confirmación y `role=alert` para error. Traducir campos y mantener detalles técnicos plegados. | Corregir el error donde ocurrió y reducir intentos fallidos. | Media | P1 |
| 14 · C | Agenda usa zona del negocio; campañas convierten `datetime-local` con zona del navegador; chat/citas laterales usan `fmtDate` local. | Etiquetar la zona y usar la del negocio por defecto en programación y citas. Convertir con el `zonedToUtc` existente en servidor; permitir vista local explícita. Mantener instantes históricos en UTC. | Evitar citas o envíos interpretados con horas diferentes. | Media | P1 |
| 15 · C/R | La revisión de destinatarios de campaña existe, pero es opcional; la confirmación final no muestra cantidad, exclusiones ni fecha completa. | Reutilizar Preview como revisión obligatoria antes de lanzar: audiencia, exclusiones por consentimiento/baja, teléfonos, fecha/zona y contenido. Invalidar revisión al cambiar parámetros; mantener una confirmación explícita para enviar. | Menos campañas enviadas a un grupo o momento equivocado. | Media | P1 |

### Fase 2 — Simplificar navegación y procesos

| ID · Evidencia | Problema y efecto sobre el usuario | Solución concreta y reutilización | Beneficio esperado | Complejidad | Prioridad |
|---|---|---|---|---|---|
| 16 · C/R | Menú simple/completo y Ajustes repiten Servicios, Horarios, Equipo e Integraciones. Algunas páginas no dejan claro cómo volver. | Un acceso canónico por función; Ajustes como índice con enlaces, no otro editor. Añadir ruta de regreso coherente y acceso directo para expertos. Conservar URLs anteriores. | Encontrar funciones sin aprender varios nombres/rutas. | Media | P2 |
| 17 · C/R | Registro/confirmación siguen enviando a Primeros pasos; el listado nuevo ofrece otro asistente de creación. La ayuda describe botones eliminados. | Llevar nuevos usuarios al mismo asistente de Agentes. Adaptar estados existentes de onboarding, manteniendo compatibilidad de `#/inicio`. Actualizar ayuda y capturas en el mismo lote. | Un solo aprendizaje y menos instrucciones contradictorias. | Media | P1 |
| 18 · C/R | Siete pestañas del agente y ajustes duplicados dentro de Instrucciones distribuyen una misma tarea. | Probar cuatro grupos principales: Configurar, Conocimiento, Conexiones y Probar. Instrucciones/Preguntas/Activación dentro de Configurar; información/fotos/mensajes dentro de Conocimiento. Mantener enlaces directos a subsecciones y administración avanzada única. | Menos decisiones iniciales conservando todas las capacidades. | Media | P2 |
| 19 · C/R | Asistente de creación paso 2 concentra trabajo, datos, límites y estilo; repite nombre del negocio ya conocido. La edición del prompt exige Usar mi versión antes de Crear. | Precargar nombre/tipo del perfil; tres elecciones visibles de propósito/datos/límites y Estilo plegado con defaults actuales. En revisión, indicar de forma inequívoca si se usará el texto editado; no descartarlo al crear. | Menos escritura repetida y menos sorpresas al crear. | Media | P2 |
| 20 · C | Los datos elegidos en el asistente se incorporan al prompt, pero el generador crea `data_fields: []`; la pestaña Preguntas queda vacía. | Mostrar en la configuración los datos solicitados por instrucciones. Ofrecer convertirlos en preguntas ordenadas con revisión de texto/tipo. No activar obligatoriedad ni orden estricto silenciosamente en agentes existentes. | Continuidad entre creación y edición; el usuario ve lo que configuró. | Media | P2 |
| 21 · C/R | Preguntas muestra claves técnicas; Fotos exige ID manual obligatorio; mensajes guardados también piden códigos. | Generar identificadores únicos desde la pregunta/nombre con normalización existente y restricciones del servidor. Claves/códigos bajo Avanzado; nunca renombrar referencias existentes automáticamente. | Configurar preguntas/fotos sin comprender identificadores. | Media | P2 |
| 22 · C/R | Abrir un teléfono existente desde la tarjeta lleva primero al listado de conexiones. El CTA principal suele ofrecer crear otro. | El nombre/número del teléfono abre directamente `connectionHref`. Si hay conexiones, acción principal Administrar conexiones; Conectar otro como secundaria. Mostrar ocupación 0–4 y estado propio. | QR existente en un clic desde Agentes. | Baja | P2 |
| 23 · C/R | Otros canales presentan configuración, credenciales y validación en una ficha larga, con dependencia de guardar antes de conectar. | Guiar sobre la ficha actual: Datos necesarios → Verificar → Listo. Usar `setup()` y OAuth solo en plataformas que ya lo soportan. Guardar datos antes de verificar con una sola acción; conservar opciones técnicas para maestro. | Conexiones más fáciles de completar sin ocultar requisitos externos. | Media | P2 |
| 24 · C/R | No hay acción única para borrar filtros; canal y agente se eligen independientemente y pueden producir combinaciones vacías. | Chips de filtros activos y Limpiar filtros; filtrar canales por agente y limpiar selección incompatible. Mantener cambios inmediatos con carga del listado, sin reconstruir toda la página. | Recuperarse de un resultado vacío en una interacción. | Media | P2 |
| 25 · C/R | En móvil, chat, pendientes, contacto, citas, secuencias y resumen forman una página de 2.712 px en la muestra. Cada mensaje nuevo fuerza el desplazamiento al final. | Accesos Datos/Resumen/Citas junto al chat; reutilizar `details` o `dialog` para el panel móvil. Priorizar resumen/contacto y plegar secundarios. Desplazar al final solo si el usuario ya estaba allí; ofrecer Nuevos mensajes al leer arriba. | Atender y consultar contexto con menos desplazamiento. | Media | P2 |
| 26 · C | Al volver a Probar se recuperan mensajes, pero el GET solo devuelve historial; la columna de datos y detalle no recupera el estado anterior. | Extender el GET actual con snapshot de contacto/conversación existente y pintar las mismas tarjetas; no crear sesión al consultar. Diferenciar Reiniciar de cambiar de agente. | El usuario comprueba persistencia y entiende qué se guardó. | Media | P2 |
| 27 · C/R | Reprogramar exige escribir `AAAA-MM-DDTHH:MM` en un prompt; recordatorios se configuran como minutos sueltos. | Reutilizar el selector de slots para reprogramar; recordatorios con unidades «1 día / 1 hora», convertir a minutos para la API. Mantener valor personalizado avanzado. | Citas y recordatorios configurables sin formatos técnicos. | Media | P2 |
| 28 · C/R | Hay plantillas y prueba de reglas, pero condiciones, variables y etapas se escriben con claves/números; la prueba usa lo guardado. | Empezar desde plantillas existentes, mostrar resumen Cuando → Si → Entonces y seleccionar campos/etapas disponibles de la metadata. Mantener Otro valor. Señalar cambios sin guardar antes de probar; insertar variables desde la lista actual. | Reglas comprensibles y pruebas de la versión correcta. | Media | P2 |
| 29 · C/R | Reordenar secuencias reconstruye controles; la demora se interpreta desde el inicio o el mensaje anterior; no hay vista global de la línea temporal. | Conservar el editor, añadir resumen calculado «al iniciar / 2 h después / siguiente apertura». Mostrar exclusiones y detener al responder con defaults actuales. Preservar borrador/foco al mover mensajes. | Menos errores de secuenciación sin otro constructor visual. | Media | P2 |
| 30 · C/R | El importador admite archivo, URL y texto a la vez; prioriza archivo aunque la persona haya escrito después una web. No permite quitar el archivo con un botón. | Selector explícito de fuente sobre `importCard`, Quitar archivo y vista previa de cuál se leerá. Conservar lo escrito al cambiar de fuente. Indicar límite/truncado y revisión antes de guardar. | Leer la fuente prevista y evitar solicitudes repetidas. | Baja | P2 |
| 31 · C/R | Mi equipo dice invitar, pero el alta exige que el administrador establezca contraseña; maestro puede abrir ajustes de cuenta sin seleccionar perfil. | Usar lenguaje Crear usuario mientras sea ese el flujo. Reutilizar recuperación para activación por correo si SMTP está disponible, sin mostrar claves en diálogos de texto. Reutilizar `accountPicker`/`needAccount` dentro de páginas del maestro. | Alta de equipo más clara y menos operaciones en el contexto equivocado. | Media | P2 |
| 32 · C/R | Estadísticas y Consumo repiten costos con periodos distintos; consumo usa meses UTC y texto de precios OpenAI pese al proveedor configurable. | Estadísticas como resultados operativos y Consumo como detalle enlazado. Explicar rango/zona y costo reportado/estimado; identificar proveedor/modelo actuales, sin modificar histórico ni inventar conversiones monetarias. | Entender cifras y dónde revisar un gasto. | Media | P2 |

### Fase 3 — Modernizar y unificar la interfaz

| ID · Evidencia | Problema y efecto sobre el usuario | Solución concreta y reutilización | Beneficio esperado | Complejidad | Prioridad |
|---|---|---|---|---|---|
| 33 · C/R | Hay variables CSS, pero también muchos estilos inline, encabezados h1→h3 y espaciados definidos por página. | Ampliar tokens actuales para espacio, tipografía, acciones, superficie y estados; estilos comunes para cabecera/sección/campo. Corregir jerarquía semántica sin agrandar todos los títulos. | Coherencia y mantenimiento con cambios pequeños. | Media | P2 |
| 34 · V/C/R | Inputs fecha/hora/file quedan nativos y pequeños; a 390 px el campo hora mide 24 px frente a otros controles de 44 px. | Estilo compartido para todos los tipos y botón de archivo con nombre/estado; ayudas/unidades bajo etiquetas. Mantener inputs nativos accesibles y API de formulario. | Formularios legibles y fáciles de tocar. | Baja | P2; solapamiento ya se corrige en F1 |
| 35 · C/R | Tablas largas mantienen muchas columnas en móvil; scroll horizontal evita overflow pero no facilita entender cada fila. | En móvil, priorizar cliente/estado/último mensaje y acción; mostrar detalle secundario al expandir. En escritorio mantener tabla. Usar datos actuales y una sola fuente para la fila. | Consulta más rápida sin eliminar información. | Media | P2 |
| 36 · C/R | Las fotos muestran todos sus campos editables a la vez; conocimiento muestra contenidos completos de todos los temas. | Reutilizar el patrón de lectura/Editar del conocimiento para fotos. Miniatura, nombre, regla resumida y estado; editor de la seleccionada. Excerpt/buscador de temas de conocimiento y expansión de contenido. | Menos densidad y menor coste DOM con catálogos grandes. | Media | P2 |
| 37 · C/R | Existen varios Guardar cambios y botones primarios en una misma ficha; guardar, duplicar y eliminar se mezclan. | Una acción primaria por contexto, barra con Cambios pendientes/Guardando/Guardado y acciones administrativas en menú etiquetado. Conservar confirmación reforzada para borrado definitivo. | Evitar guardar la sección incorrecta o confundir acciones. | Media | P2 |
| 38 · C/R | `prompt/confirm/alert` se usan para agenda, claves, usuario, marca, borrado y entregas; el diseño y la validación cambian con el navegador. | Reutilizar el `dialog` nativo del reporte para formularios/confirmaciones comunes, con título asociado, validación, foco y Escape. Mostrar entregas dentro de la página. No reducir protecciones de borrado o lanzamiento. | Interacciones coherentes y más comprensibles. | Media | P2 |
| 39 · C/R | Chatbot/asistente/agente y cuenta/perfil se alternan; aparecen términos como tokens, embeddings, ID y p95 fuera del diagnóstico experto. | Glosario fijo: Agente, Perfil de negocio, Conexión, Persona del equipo. «Información preparándose» en tareas comunes; detalle técnico bajo Ver detalles. Actualizar ayuda y copy junto a la navegación. | Menos aprendizaje técnico y menos dudas de significado. | Baja | P2 |
| 40 · C/R | Vacíos/fallos suelen ser un renglón genérico; estadística faltante puede impedir todo el listado Agentes por un `Promise.all`. | Estados reutilizables: vacío inicial, sin coincidencias, cargando, error parcial y sin permiso. Permitir crear/editar agentes si falla una estadística accesoria. Reutilizar el patrón de último dato visible de Estadísticas con aviso de antigüedad. | Continuidad de trabajo y siguiente acción evidente. | Media | P1 para fallos que bloquean; P2 para diseño |
| 41 · C/R | La cuadrícula de siete pestañas ocupa cuatro filas en móvil; redactor de chat comparte ancho reducido con dos botones. | Navegación secundaria compacta y etiqueta de ubicación; conservar acceso por teclado. En móvil, redactor de ancho completo y acciones en otra fila; calibrar alto del chat con viewport dinámico. | Más espacio útil sin controles diminutos. | Media | P2 |
| 42 · C/R | Estadísticas tiene once KPI y varias gráficas; el estado inicial no distingue lo que requiere acción. | Resumen de cuatro o cinco resultados relevantes para el perfil, enlaces a detalles existentes y bloque de atención si hay mensajes fallidos/sin asignar. Mantener métricas completas desplegables y los controles accesibles actuales. | Entender la situación del negocio con menos lectura. | Baja | P3, validar con usuarios |

### Fase 4 — Automatización, accesibilidad y optimización avanzada

| ID · Evidencia | Problema y efecto sobre el usuario | Solución concreta y reutilización | Beneficio esperado | Complejidad | Prioridad |
|---|---|---|---|---|---|
| 43 · V/C | Cada navegación vuelve a pedir meta, sesión y cuentas; varios recorridos piden canales dos veces. Agentes hizo nueve solicitudes en carga inicial. | Mantener `/api/me` y verificaciones del servidor; cachear/deduplicar metadata de corta vigencia y compartir canales entre banner/vista. Invalidar por usuario/perfil/cambios. Pintar carga antes de esperar datos accesorios. | Menos espera y solicitudes sin debilitar permisos. | Media | P2; carga/error básica en F1 |
| 44 · V/C | Editores de automatización hicieron 11–12 solicitudes en la muestra; `automationRefs()` pide imágenes secuencialmente por cada agente. `/api/accounts` calcula estadísticas incluso para el selector. | Referencias compartidas por perfil y carga de catálogo solo cuando se use; concurrencia limitada para lecturas independientes. Vista ligera del selector en la ruta actual de cuentas, dejando totales para Perfiles. | Escalar con varios agentes/perfiles sin sumar una espera por cada uno. | Media | P2 |
| 45 · C | Polling de chat/lista/avisos/estadísticas sigue en pestañas ocultas; no hay indicador consistente de información antigua. | Pausar lecturas no esenciales con `visibilitychange`, agrupar avisos y aplicar backoff a fallos; actualizar al volver. Conservar limpieza de timers y no detener workers de mensajes/citas. | Menos carga y una interfaz que explica su frescura. | Media | P2 |
| 46 · C | El chat decide si repinta por cantidad de mensajes; cambios de estado con igual cantidad pueden no verse. Recarga hasta 500 mensajes cada cinco segundos. | Lectura incremental/versionada y merge por ID/estado, siguiendo el patrón `after` del widget. Mantener histórico y actualizar fallidos/entregados sin mover el foco ni el scroll. | Chat más ligero y estado de envío correcto. | Media | P2 |
| 47 · C/R | El QR redibuja botones en cada sondeo; estados de carga y respuestas no se anuncian uniformemente. El widget no implementa Escape/retorno de foco. | Actualizar solo la región cambiante del QR; anunciar conexión/error una vez, no cada segundo del contador. Etiquetas de diálogo, `aria-current`, regiones de chat apropiadas, vuelta de foco y Escape en panel/modal. Respetar movimiento reducido. | Navegación estable con teclado y lectores de pantalla. | Media | P2 |
| 48 · C/R | Entrar a Probar enfoca automáticamente el redactor; formularios de acceso no especifican autocomplete y login usa email como texto. | Foco en encabezado al cambiar de pantalla y redactor tras intención de escribir, especialmente móvil. `autocomplete=username/current-password/new-password`, tipo email/tel y ayudas asociadas. Mantener atajos opcionales. | Mejor teclado móvil, gestores de contraseña y orientación. | Baja | P2 |
| 49 · C/R | El estado del índice se lee al abrir Conocimiento, aunque los documentos se preparan en segundo plano; fallos quedan en diagnóstico. | Actualizar ese estado mientras haya pendientes, con pausa/backoff. Usar conteos y reintento del índice existentes; explicar qué documento necesita acción y cómo corregirlo. No relanzar embeddings repetidos por cada visita. | Saber cuándo la información ya se puede usar. | Media | P2 |
| 50 · C/R | La configuración de estilo y límites ya tiene defaults, pero no hay una revisión única de preparación para empezar a atender. | Resumen previo a Encender con conocimiento, teléfonos, citas/servicios, activación y referencias de fotos; enlaces a los ajustes existentes. Defaults sugeridos según datos confirmados, siempre visibles/editables. Nunca asumir consentimiento, destinatarios, horarios no proporcionados ni activar atención sin acción explícita. | Configuración sencilla y detección temprana de omisiones. | Media | P2 |
| 51 · C/R | El acceso carga el grafo de módulos del panel; no hay separación explícita por ruta ni evidencias de compresión configurada en la app. | Medir recursos/transferencia reales primero. Si importan, carga diferida por ruta y caché versionada en despliegue; comprobar compresión del proxy antes de añadirla. No adoptar un framework nuevo ni virtualización sin datos. | Login/inicio más rápidos con complejidad controlada. | Media | P3 |
| 52 · C/R | No hay medición de tareas UX ni pruebas de navegador/accesibilidad integradas en la suite del repo; `check:frontend` verifica código, no recorridos. | Instrumentar tiempos/acciones sin texto de clientes ni credenciales; suite de tareas críticas, fallos y axe en CI. Reutilizar arnés y patrones de las pruebas actuales; mantener pruebas humanas cortas para nomenclatura y descubrimiento. | Detectar regresiones y decidir con resultados observables. | Media | P2 |

## Arquitectura de navegación propuesta

Propuesta a validar con usuarios antes de cambiar etiquetas. Reagrupa destinos actuales; no crea módulos funcionales nuevos.

| Nivel principal cotidiano | Contenido |
|---|---|
| **Agentes** | Crear; Configurar; Conocimiento; Conexiones; Probar. Cada teléfono mantiene su ficha y QR. |
| **Conversaciones** | Bandeja, contacto/resumen, pendientes, citas y seguimientos del cliente. Notificaciones dentro de este área y acceso de campana permanente. |
| **Agenda** | Citas y llamadas; Servicios y disponibilidad. |
| **Negocio / Ajustes** | Automatización, horarios, equipo, integraciones, resultados/consumo y plan. Accesos directos del menú completo conservados para expertos. |

Para el maestro, **Administración** conserva Perfiles, Planes y cobro, Marca blanca y Sistema. Mostrar claramente Perfil seleccionado y Todos los perfiles; las acciones que necesitan uno deben ofrecer el selector en el contenido, también en móvil. La cuenta de destino nunca debe inferirse de un listado general si el agente ya determina otra cuenta.

Dentro del agente, cuatro grupos principales pueden reducir la elección inicial. Preguntas, Activación, Fotos y Mensajes guardados siguen localizables y enlazables directamente. Si el piloto muestra que agrupar añade fricción a usuarios frecuentes, mantener accesos rápidos por tarea en vez de imponer otro nivel de clics.

## Implementación por fases y puertas de aceptación

### Fase 1: fiabilidad antes de renovación visual

**Orden de lotes:** (1) navegación/guardado/envío y pérdidas de borrador; (2) importación/estados/fechas/campañas; (3) acceso por teclado, controles visibles y feedback. Incluir paginación temprana para no ocultar registros existentes. Incorporar recuperación de errores que bloquean Agentes, aunque el componente visual común se complete en F3.

**Aceptación verificable:**

1. Editar cualquier sección y cambiar de pestaña/perfil no pierde la edición sin guardar o descartar explícitamente. Recargar ofrece recuperación del borrador de configuración; borradores personales no quedan en almacenamiento local.
2. Editar un contacto y dejar el foco fuera durante al menos dos ciclos de actualización conserva lo escrito; un conflicto de versión ofrece revisión y no sobrescribe el dato del servidor.
3. Dos Enter/clics rápidos producen una solicitud por acción pendiente. En un fallo el texto queda recuperable; el éxito no elimina el siguiente borrador.
4. Con HTTP 503/409 el borrado/guardado mantiene la ficha, muestra el fallo y permite reintentar. La aplicación no declara éxito antes de la respuesta.
5. Navegar tres veces con respuestas reordenadas deja URL, encabezado, perfil y datos de la última ruta. Fallo de sesión muestra Cargando/Error/Reintentar; 401 vuelve al acceso y 403 conserva las restricciones.
6. Fallar cualquier escritura de una importación deja todas las secciones anteriores intactas. Un guardado correcto conserva las correcciones revisadas sin otra lectura de IA.
7. QR conectado + agente apagado muestra Teléfono conectado y Agente apagado, con Encender como siguiente acción. Pausa, palabra de activación, canal deshabilitado y perfil en pausa tienen explicación distinta.
8. Con 150 conversaciones y 600 mensajes todos se pueden consultar mediante paginación/anteriores; filtros y permisos se mantienen.
9. Con negocio en Ciudad de México y navegador en UTC/otra zona, la misma cita y programación muestran zona explícita e instante consistente; se conservan citas y envíos históricos.
10. Una campaña no se lanza sin revisar destinatarios, exclusiones, número(s), hora/zona y contenido; cambios invalidan la revisión.
11. Abrir un cliente/servicio/regla/aviso funciona solo con teclado. Los selectores tienen nombre accesible y los errores se anuncian. Ningún foco queda bajo Guardar en 320–1440 px, zoom 200 % y prueba de teclado virtual.
12. Texto normal ≥4,5:1 y texto grande ≥3:1; controles/indicadores pertinentes ≥3:1. Marca blanca admite una combinación legible en ambos temas, incluyendo blanco/negro/colores claros. No quedan infracciones críticas de nombre accesible en tareas principales.

**Métricas:** cero pérdidas de borrador, cero envíos duplicados por interacción rápida, cero éxitos falsos y cero discrepancias ruta/pantalla en el banco de pruebas. Al menos 90 % de finalización sin ayuda en tareas críticas del piloto, medido por tarea y rol.

### Fase 2: un recorrido por tarea

**Lotes:** navegación/compatibilidad y ayuda; creación/configuración de agente; conexión/conversación; agenda/automatización/equipo. Mantener el menú completo para expertos y el esquema de permisos actual.

**Aceptación verificable:**

1. Usuario recién registrado o verificado y administrador existente encuentran el mismo recorrido de creación. Primeros pasos y enlaces históricos llevan al destino correspondiente sin perder datos de onboarding.
2. Cada función tiene un editor canónico. Agenda/Ajustes enlazan al mismo editor de servicios; no existe otro juego de horarios sin explicar si es específico del servicio.
3. Los datos elegidos en creación son visibles después de crear; el prompt revisado se usa o indica claramente que no se aplicó. Convertir a preguntas obligatorias requiere revisión explícita.
4. La creación cotidiana no exige escribir ID de foto ni clave de dato. Los IDs existentes siguen funcionando en instrucciones, reglas y mensajes guardados.
5. Abrir el QR de un teléfono existente desde Agentes requiere como máximo un clic de navegación. Se pueden crear/asignar cuatro teléfonos entre agentes; el quinto se bloquea sin crear una sesión; otras plataformas siguen disponibles.
6. Limpiar filtros requiere una acción y una combinación agente/canal incompatible se corrige de forma explícita. Un vacío con filtros ofrece Limpiar filtros, no sugiere que se borraron clientes.
7. Ver resumen/datos/citas desde el chat móvil necesita como máximo una acción local por destino. Un mensaje nuevo no interrumpe la lectura de mensajes anteriores.
8. Reprogramar utiliza disponibilidad y selector, sin escribir ISO. Recordatorios aceptan horas/días y conservan el resultado equivalente en minutos.
9. Plantillas y prueba de reglas siguen disponibles; la versión probada queda identificada. Preview de campaña y línea temporal de secuencia mantienen condiciones, bajas, consentimiento y límites actuales.
10. Cambiar la fuente de importación no lee silenciosamente el archivo anterior. Alta de equipo y elección de perfil del maestro no requieren instrucciones sobre menús ocultos.

**Métricas:** reducir 25–30 % la mediana de tiempo de creación/reprogramación/configuración de seguimiento frente al piloto inicial; reducir 30 % errores de configuración observados. Experto no debe requerir más interacciones para tareas frecuentes por haber agrupado opciones.

### Fase 3: componentes y densidad coherentes

**Lotes:** tokens y formularios; tablas/catálogos/chat; acciones/diálogos/estados; resultados y revisión visual. Reutilizar `h`, `field`, `saveBar`, `details`, `dialog`, cuadrículas y tarjetas actuales.

**Aceptación verificable:**

1. Formularios principales comparten etiquetas, ayudas, errores, altura y estados de botón; no quedan fecha/hora/file sin estilo que reduzcan objetivos táctiles.
2. En móvil las filas permiten identificar cliente, estado y acción sin arrastrar varias columnas; los datos restantes permanecen disponibles.
3. Con 30 fotos y 50 temas de conocimiento se puede localizar/editar un elemento sin mostrar 30 formularios abiertos ni descargar imágenes fuera de pantalla innecesariamente.
4. Cada contexto de guardado identifica qué guarda y muestra pendiente/en curso/guardado/fallido. Duplicar/eliminar no compiten visualmente con Guardar.
5. Formularios/confirmaciones de diálogo tienen título asociado, foco inicial, retorno de foco y navegación de teclado; se conservan avisos de consecuencias de acciones irreversibles.
6. Glosario y ayuda coinciden con los nombres visibles. Logs, tokens y modelos siguen disponibles donde ayudan a diagnosticar, sin dominar las tareas iniciales.
7. No hay desbordamiento, controles cubiertos ni acciones inaccesibles en móvil/tableta/escritorio, claro/oscuro y cadenas largas. Ejecutar además zoom 200/400 % y dispositivos con teclado virtual.
8. Estados vacíos, sin coincidencias, cargando, error parcial y permiso denegado muestran el siguiente paso correcto. Un fallo de estadísticas no impide configurar el agente.

**Métricas:** ≥90 % de participantes localizan la acción principal sin ayuda; reducción de errores por pulsar la sección equivocada; todas las tareas centrales tienen objetivos táctiles de 44 px donde sea viable, y cumplen el mínimo WCAG aplicable. El índice de densidad se mide por pantalla útil, no simplemente por cantidad de tarjetas.

### Fase 4: rendimiento, accesibilidad completa y ayuda automática

**Lotes:** solicitudes/polling/lectura incremental; foco/regiones/acceso público; estado de conocimiento/preparación; métricas y regresión. La accesibilidad que bloquea tareas ya debe estar resuelta en F1.

**Aceptación verificable:**

1. En carga de Agentes no se pide dos veces el mismo listado de canales para el mismo perfil; metadatos estáticos no se recargan sin necesidad. `/api/me`, 401/403 y permisos del servidor siguen protegiendo la sesión.
2. Los catálogos no se consultan secuencialmente para todos los agentes al abrir un editor que aún no usa imágenes. El selector no calcula estadísticas comerciales de cada perfil para mostrar nombres.
3. Una pestaña oculta suspende lecturas periódicas no esenciales y vuelve a actualizar al activarse. Workers, recordatorios y procesamiento de mensajes siguen funcionando.
4. Un cambio de estado de envío con igual cantidad de mensajes se ve sin recargar. La lectura incremental y Cargar anteriores no duplican ni omiten mensajes.
5. Tras 100 ciclos de QR/chat se mantiene el foco, no crecen temporizadores ni se anuncian cuentas regresivas continuamente. En widget/modal funcionan Escape y regreso al control que los abrió.
6. Pruebas manuales con lector de pantalla/teclado completan crear, conectar, atender, resumir, reservar y programar. axe no registra incumplimientos críticos/serios en esos recorridos; la jerarquía de encabezados y nombres también se revisa.
7. Pendientes/errores del conocimiento cambian de estado sin recargar la página; reintentar no vuelve a indexar documentos sanos por cada visita. La revisión antes de Encender identifica los requisitos reales del agente.
8. Feedback inicial de acciones/navegación ≤100 ms, aunque el servicio tarde. Bajo el mismo retraso artificial de 200 ms, comparar al menos 20 ejecuciones por rol: objetivo inicial p95 ≤1.100 ms para entrada fría en Agentes y ≤700 ms para navegación caliente, ajustable tras establecer la distribución real.
9. Medir latencia del proveedor aparte del tiempo de interfaz. No prometer respuestas IA instantáneas ni atribuir lentitud externa al render.
10. CI cubre pérdidas de borrador, carrera de rutas, fallos, duplicados, permisos, importación atómica, fechas, campañas revisadas y accesibilidad. No se registran textos de mensajes, prompts, QR, credenciales ni datos personales para medir UX.

**Métricas:** solicitudes por navegación, p50/p95 hasta contenido utilizable, tiempo hasta feedback, mensajes transferidos por sondeo, peticiones con página oculta, incidentes de configuración y cumplimiento de tareas con teclado/lector. Objetivo de ≥30 % menos solicitudes redundantes, no reducción de controles de autorización.

## Métricas de tareas y medición de resultados

Separar **línea base observada**, **línea base pendiente** y **objetivo propuesto**. No sustituir el tiempo de usuario por el tiempo de un script.

| Tarea / indicador | Línea base disponible | Objetivo propuesto | Cómo verificar |
|---|---|---|---|
| Crear y probar agente sin documento | Cuatro pasos; tres transiciones y Crear. Tiempo humano no medido. | ≥90 % completa sin ayuda; ≥25 % menos tiempo que el piloto inicial, sin más campos obligatorios. | Mismo negocio ficticio y reglas, usuarios nuevos/experimentados; medir entrada, revisión y primera prueba. |
| Abrir QR de teléfono existente desde Agentes | Dos clics por la ruta nombre de conexión → listado → Ver QR. | Un clic; medir tiempo hasta QR aparte del tiempo que tarda la persona en escanear. | Teléfono ya creado y desconectado; prueba de navegación y sesión simulada, después piloto real. |
| Conectar teléfono nuevo | Crear ya fija agente/cuenta y abre el conector; esos pasos están simplificados. | Conservarlo y ≥90 % de finalización; sin pedir de nuevo agente/cuenta. | Crear/asignar/reconectar, varios teléfonos, límite y perfiles. No contar espera externa como clic de app. |
| Editar configuración/contacto | Pérdida reproducida en las dos pruebas descritas. | Cero pérdidas en pruebas de navegación, polling y conflicto. | Editar, cambiar foco/ruta, esperar/red lenta y volver. |
| Responder cliente | Dos solicitudes por dos Enter concurrentes; el chat manual conservó texto en fallo. | Una solicitud pendiente; texto recuperable; siguiente borrador intacto. | Teclado, clic, doble clic, red lenta, rechazo y éxito. |
| Consultar resumen en móvil | Parte baja de un detalle de 2.712 px en muestra. Tiempo humano no medido. | ≤1 acción local para abrir resumen; ≥30 % menos tiempo en piloto. | Misma conversación con resumen guardado y sin resumen; incluir generación, antigüedad y descarga. |
| Reprogramar cita | Prompt con ISO y ejemplos de slots. | Selector, fecha/zona claras; cero errores de formato en la tarea. | Servicio con huecos disponibles, navegador en dos zonas y conflictos concurrentes. |
| Importar conocimiento | Fallo en tercera escritura dejó dos secciones nuevas guardadas. | Cero guardados parciales; revisión intacta al fallar. | Inyectar fallo en cada sección y comparar datos anteriores. |
| Configurar seguimiento/campaña | Hay plantillas, Preview y editor; tiempo y clics humanos pendientes. | ≥25 % menos tiempo y ≥30 % menos errores; ninguna campaña sin revisión. | Seguimiento a 2 h y campaña futura ficticia; medir consultas a ayuda y exclusiones comprendidas. |
| Accesibilidad automatizada | 33/44 variantes con contraste; 16/44 selectores sin nombre; 30/44 jerarquía. | Cero incumplimientos críticos/serios en tareas centrales y cumplimiento manual de teclado/foco. | Misma fixture antes/después; repetir en claro/oscuro, marcas, estados y diálogos abiertos. |
| Carga Agentes | Nueve solicitudes API en entrada inicial; 1.487 ms con retraso artificial de 200 ms, una ejecución. | Una sola lectura de canales; objetivos p95 de F4 tras 20 muestras. | Misma versión de navegador, DB, perfiles, latencia artificial y caché fría/caliente. |
| Datos/acciones por pantalla | Instrucciones: 24 controles; Activación: 31; Horario y ajustes: 38 en la fixture. | Menos controles iniciales sin perder descubrimiento ni acceso experto. | Contar visibles en viewport y pasos para tarea; no premiar esconder funcionalidad. |

### Protocolo del piloto

1. Primera ronda orientativa: al menos seis personas nuevas y cuatro experimentadas. Usar tareas idénticas con datos ficticios y sin ayudas del moderador; segmentar por rol y dispositivo.
2. Medir tiempo activo, espera externa, éxito sin ayuda, errores recuperables/no recuperables, clics/taps/selecciones, retrocesos, uso de ayuda y una valoración de facilidad de 1–7 por tarea.
3. Comparar versión inicial y cada fase con condiciones equivalentes; controlar aprendizaje alternando versiones o usando grupos comparables. Para muestras pequeñas comunicar conteos además de porcentajes.
4. Definir finalización por resultado correcto: agente guardado probado, número asignado al agente correcto, resumen actualizado, cita en el hueco correcto o campaña revisada. Llegar a una pantalla no es finalizar.
5. En producción, si se incorpora medición, usar eventos agregados de tarea/rol/duración/error sin contenido sensible. Contrastar fallos UX con métricas operativas existentes sin duplicar registros personales.

## Pruebas de conservación de capacidades

Antes de cerrar cada fase, comprobar que la nueva presentación conserva:

- Rol maestro/admin/operador y límites de perfil; reasignación sin pérdida de contacto, mensajes o datos; URLs antiguas del panel.
- Cuatro sesiones WhatsApp independientes por cuenta, varios teléfonos por agente, reconexión y asignación de conexiones pendientes.
- Instrucciones, orden/obligatoriedad de preguntas, activación/desactivación y captura automática sin creación manual de campos.
- Conocimiento esencial/relevante, preparación semántica y alternativa por palabras cuando corresponda; no alterar pgvector ni evaluaciones Promptfoo para maquillar resultados.
- Fotos por contexto, mensajes guardados, palabras y eventos; reglas de repetición, máximo de fotos y referencias al reordenar etapas.
- Citas/llamadas, disponibilidad, reprogramación, cancelación y recordatorios; zonas horarias consistentes.
- Triggers, condiciones, acciones, secuencias, campañas, bajas, consentimiento, horarios y límites; simulador claramente diferenciado del envío real.
- Atención humana, asignación por turnos, resúmenes, exportaciones, privacidad y conservación del histórico.
- Integraciones, pagos, cuentas, marca blanca, costos y supervisión. Un cambio visual no debe cambiar el estado comercial ni permisos.

Reutilizar las pruebas existentes de `config-persistence`, `questions`, `activation`, `whatsapp-profiles`, `profile-permissions`, `agent-channel-assignment`, `conversation-records`, `image-prompt`, `flow-delivery`, `automation-triggers`, `flows`, `analytics` y `billing`, ejecutando las pertinentes a cada lote. Las pruebas nuevas de navegador deben verificar resultados y recuperación, no copiar la estructura interna del DOM.

## Referencias de código y evidencias

| Tema | Punto de entrada revisado |
|---|---|
| Router, permisos y carga | `public/js/main.js:30`; `public/js/session.js:19`; `public/js/connect.js:10`; `public/js/shell.js:23` |
| Formularios, errores y confirmaciones | `public/js/core.js:11`, `:60`, `:69`, `:86`, `:90`, `:94`; `src/routes/util.ts:14` |
| Edición y organización del agente | `public/js/bot.js:121`, `:175`, `:304`, `:421`, `:448`, `:543`; `public/js/agentwizard.js:19` |
| Generación y campos del asistente | `src/templates/agent-builder.ts:133`, `:228`; `src/routes/chatbots.ts:138` |
| Conexiones, estado y QR | `public/js/agent-connections.js:34`; `public/js/channels.js:202`; `public/js/whatsapp.js:20`; `public/js/dashboard.js:16` |
| Simulador e historial | `public/js/playground.js:42`, `:48`, `:98`; `src/routes/chatbots.ts:467` |
| Ediciones y lectura del chat | `public/js/conversations.js:143`, `:186`, `:268`, `:343`; `src/routes/conversations.ts:47`, `:74` |
| Importación parcial y transacción reutilizable | `public/js/importer.js:61`; `src/routes/import.ts:92` |
| Agenda y zona horaria | `public/js/agenda.js:33`, `:94`, `:131`; `public/js/automation.js:457`; `src/automation/time.ts:52` |
| Referencias/editores de automatización | `public/js/automation.js:24`, `:310`, `:394`, `:457`, `:534` |
| Menú, ayuda y alta | `public/js/dashboard.js:84`; `public/js/auth.js:47`, `:107`; `public/js/onboarding.js:29`; `public/ayuda.html:82` |
| Roles, costos e integraciones | `public/js/admin.js:12`, `:179`, `:208`; `public/js/integrations.js:50`; `public/js/usage.js:17`; `public/js/billing.js` |
| Patrón de actualización/foco y lectura incremental | `public/js/analytics.js:295`; `public/widget.js:177`, `:214` |
| Estilos y marca | `public/styles.css:140`, `:162`, `:271`; `public/js/brand.js:9` |
| Selector costoso de perfiles | `src/routes/admin.ts:104`; `public/js/session.js:19` |

Evidencias conservadas junto a este informe en `riverrun-ux-evidence/`:

- [results.json](baseline/results.json): 44 pantallas, solicitudes, hallazgos axe, altura/controles y 60 escenarios adaptables.
- [edge-results.json](baseline/edge-results.json): carreras, fallos, importación parcial, envíos y medición artificial de carga.
- [conversation-mobile.png](baseline/conversation-mobile.png) y [automation-mobile.png](baseline/automation-mobile.png): capturas de la muestra móvil.
- La regresión portable incorporada después de esta auditoría está en [scripts/test-ux.mts](../../scripts/test-ux.mts). Los scripts exploratorios originales dependían de rutas del entorno y no se incorporan al repositorio. El arnés reinicia el esquema de una **base de pruebas aislada**; consulta las instrucciones de ejecución en [implementación](implementation.md).

## Cambios que no recomiendo como primer paso

No recomiendo reescribir el panel en otro framework, añadir un constructor visual nuevo de automatizaciones, crear otro CRM de contactos, aumentar menús por cada problema ni introducir sincronización offline de envíos. Primero hay que corregir pérdidas de edición/errores y mejorar la presentación de capacidades actuales. La carga diferida, virtualización o un nuevo almacenamiento de eventos solo se justifican después de medir el cuello de botella.

No automatizar decisiones de consentimiento, destinatarios, publicación/encendido o permisos. Los defaults deben reducir escritura; las acciones que cambian quién recibe mensajes o quién puede entrar deben permanecer explícitas y revisables.
