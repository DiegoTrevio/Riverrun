# Implementación de la auditoría UX/UI

La [auditoría original](audit.md) describe la rama anterior a estos cambios. Este documento registra qué se incorpora al PR, qué se verifica automáticamente y qué requiere observación de usuarios o del despliegue. La auditoría sigue conservando prioridades, complejidades, beneficios esperados y criterios por fase.

## Cambios por fase

1. **Fiabilidad:** borradores de configuración, protección de la edición del contacto frente a actualizaciones y conflictos, envíos sin solicitudes concurrentes, errores recuperables, navegación protegida frente a respuestas antiguas, importación atómica, historial paginado y revisión de campañas con la zona horaria del negocio.
2. **Simplificación:** cuatro destinos cotidianos y cuatro grupos del agente; preguntas, activación, fotos y mensajes continúan disponibles. Registro y enlaces antiguos convergen en Agentes. El QR existente se abre desde el teléfono de la tarjeta. Crear usuario, importar información, reprogramar citas y conectar plataformas usan acciones explícitas y etiquetas acordes al funcionamiento real.
3. **Presentación:** formularios y controles nativos de tamaño uniforme, tablas adaptables, espacios y colores comunes, acciones que no cubren campos, contraste de marca, diálogos nativos y resumen de estadísticas con detalle desplegable. Se reutilizan los componentes ES y CSS existentes.
4. **Eficiencia y accesibilidad:** módulos por ruta, selector ligero de perfiles, catálogos de fotos diferidos, lecturas compartidas, polling visible sin solapamientos, actualización incremental del chat y estado de preparación del conocimiento. Foco, nombres accesibles, estados de error/carga, movimiento reducido y regresión de navegador en CI.

No requiere migraciones. La paginación es opcional: los clientes anteriores reciben una lista. Los horarios ISO anteriores siguen aceptándose; `scheduled_local` añade una conversión explícita según la configuración del negocio. Se mantienen los roles y restricciones de perfil, las cuatro conexiones WhatsApp, el motor de citas/automatizaciones y los enlaces anteriores.

## Cobertura de las 52 oportunidades

**Aplicado** significa que hay una solución concreta en este cambio. **Parcial** significa que se implementa la parte indicada y se deja explícito el alcance restante. No equivale a certificar cada criterio humano o de producción de la auditoría.

| ID | Estado | Implementación y límites |
|---|---|---|
| 01 | Aplicado | `editing.js`: borradores por usuario/perfil/objeto, aviso, descarte y recuperación. Agente/asistente persistentes hasta siete días; canales, campañas, reglas y servicios solo en memoria. Los archivos seleccionados deben volver a elegirse al recargar. |
| 02 | Aplicado | El polling no modifica el formulario del contacto mientras se edita. Un 409 abre revisión por campo; por defecto conserva el dato concurrente del cliente. Las notas conservan su borrador y muestran el resultado guardado. |
| 03 | Aplicado | Generación de navegación y comprobaciones de vigencia; fallo de sesión con Reintentar; callbacks de conexión comprueban la ruta antes de redirigir. |
| 04 | Aplicado | Guardia de envío manual/simulador/galería, texto retenido ante fallo y conservación de un mensaje nuevo escrito durante el envío anterior. |
| 05 | Aplicado | Las acciones comprobadas solo recargan, redirigen o descartan borradores después de una respuesta satisfactoria. Errores visibles en la tarjeta y toast. |
| 06 | Aplicado | Guardado revisado del conocimiento en una transacción; conserva la edición sin repetir la extracción de IA. Prueba con fallo de escritura y rollback. |
| 07 | Aplicado | La conexión del teléfono no promete atención: explica agente encendido, perfil activo y activación. |
| 08 | Aplicado | Conversaciones con cursor estable, microsegundos y desempate por ID; Cargar más. Mensajes anteriores y nuevas páginas incrementales sin omitir lotes mayores de 500. |
| 09 | Aplicado | Filas accionables con botón nativo para teclado; controles interiores no activan la fila. |
| 10 | Aplicado | Filtros con nombres accesibles, etiquetas asociadas y selector de perfil explícito. |
| 11 | Aplicado | Barra de guardado en el flujo normal y tamaños nativos homogéneos; deja visibles los campos de hora en móvil. |
| 12 | Aplicado | Contraste de texto secundario/error y selección de texto oscuro/claro para marca; enlaces del panel con contraste independiente. El widget calcula su texto de marca. |
| 13 | Aplicado | Etiquetas, ayudas, fieldsets, validación nativa en acceso, avisos persistentes y regiones de estado/error. Los errores detallados de API quedan desplegables. |
| 14 | Aplicado | Fechas de campaña en zona del negocio; rechazo de fechas imposibles y huecos de cambio horario; conversación/agenda muestran su zona. |
| 15 | Aplicado | Destinatarios, exclusiones, conexiones, texto y fecha antes de enviar/reprogramar. Cancelar no guarda; cambios durante la revisión invalidan la confirmación. |
| 16 | Aplicado | Agentes, Conversaciones, Agenda y Ajustes; campana permanente y menú completo para expertos. Ajustes enlaza a los mismos editores. |
| 17 | Aplicado | Registro y confirmación apuntan al asistente unificado; primeros pasos y URLs antiguas siguen funcionando; ayuda actualizada. |
| 18 | Aplicado | Configurar/Conocimiento/Conexiones/Probar, con subapartados enlazables y administración avanzada única. |
| 19 | Aplicado | Negocio precargado, estilo plegado, borrador de pasos y prompt editado usado directamente al crear. |
| 20 | Aplicado | Datos elegidos visibles en el agente, opcionales y sin imponer orden. Conversión explícita a preguntas para revisión. Se excluyen datos sensibles del generador. |
| 21 | Aplicado | Identificadores automáticos de preguntas, fotos y mensajes; códigos avanzados editables, sin cambiar referencias existentes. |
| 22 | Aplicado | Teléfono de la tarjeta abre su ficha/QR directamente; ocupación y estado individual siguen disponibles. |
| 23 | Aplicado | Telegram, Meta, correo y Zernio guardan antes de verificar/conectar; guardia concurrente, estado del proceso y credenciales en memoria. Los requisitos externos y OAuth existentes se conservan. |
| 24 | Parcial | Limpiar filtros y eliminación de combinaciones agente/canal/tipo incompatibles. Se conservan selectores visibles; no se añaden chips redundantes para todos los filtros. |
| 25 | Parcial | Accesos Datos/Resumen/Citas y Volver a mensajes; scroll conserva lectura y ancla al cargar anteriores. No se añade un segundo panel móvil ni un contador independiente de mensajes nuevos. |
| 26 | Aplicado | El GET del simulador recupera contacto y conversación existentes sin crear sesión. La tarjeta de datos refleja el historial recuperado. |
| 27 | Aplicado | Reprogramar elige slots disponibles; recordatorios aceptan días/horas/minutos y mantienen minutos en la API. |
| 28 | Parcial | Plantillas existentes comienzan apagadas y la prueba indica que usa la configuración guardada. Se conservan los editores avanzados; no se añade un nuevo constructor de condiciones ni selector de variables. |
| 29 | Aplicado | Línea temporal calculada con retrasos, horas y horario del negocio; reordenar conserva modelos y devuelve foco al mensaje. |
| 30 | Aplicado | Archivo/Web/Texto como fuente explícita; quitar archivo y conservación de texto entre opciones. |
| 31 | Parcial | Crear usuario y selector de perfil dentro del contenido; contraseñas en diálogo protegido. Invitaciones por correo quedan sujetas a un flujo específico y SMTP verificado. |
| 32 | Aplicado | Consumo explica mes UTC, proveedor configurable e histórico; Estadísticas conserva sus rangos y detalle operativo. |
| 33 | Parcial | Tokens y controles compartidos, jerarquía de títulos y espaciado; se preservan estilos locales de gráficas/editores que todavía requieren medidas específicas. |
| 34 | Aplicado | Fecha/hora/archivo/teléfono/URL comparten presentación y objetivos táctiles; unidades con ayudas asociadas. |
| 35 | Aplicado | Tablas con etiquetas por celda y presentación móvil; filtros y acciones conservan su función. |
| 36 | Parcial | Fotos con preview y editor plegado; conocimiento con búsqueda y extracto desplegable. No se incorpora virtualización ni otro editor de catálogo. |
| 37 | Aplicado | Se elimina configuración cotidiana duplicada del apartado avanzado; acciones destructivas separadas y referencias actuales conservadas. |
| 38 | Aplicado | Diálogos nativos comunes, Escape, foco y cancelación; acciones destructivas mantienen confirmación explícita. |
| 39 | Aplicado | Ayuda y nombres cotidianos alineados con rutas; códigos técnicos y opciones avanzadas permanecen accesibles. |
| 40 | Aplicado | Feedback de carga inmediato, reintento visible y estadísticas accesorias que no bloquean configurar agentes. |
| 41 | Aplicado | Pestañas/subpestañas y composer adaptable; sin desbordamiento en la muestra de cinco anchos y dos temas. |
| 42 | Aplicado | Cuatro indicadores principales, avisos de atención y Todas las métricas; preferencia experta por usuario/perfil. |
| 43 | Parcial | Metadatos y lectura de canales compartidos con TTL breve e invalidación; sesión y selector de perfiles se verifican sin caché. Se prioriza vigencia de permisos. |
| 44 | Aplicado | Selector ligero y carga de imágenes al usar el catálogo, con hasta tres agentes en paralelo y un pedido compartido por editor. |
| 45 | Parcial | Polling común visible, sin solapamiento y con backoff; QR/widget omiten páginas ocultas. No se añade un indicador global de antigüedad a todas las páginas. |
| 46 | Aplicado | Merge de mensajes por ID/contenido/estado; `after` más actualización de hasta cien envíos existentes; no reconstruye encabezado si no cambia. |
| 47 | Aplicado | QR actualiza regiones cambiantes; `aria-current`, diálogos, Escape/retorno en widget, nombres de controles y movimiento reducido. |
| 48 | Aplicado | Foco en encabezado al navegar; Probar no abre teclado automáticamente; email/tel y autocomplete apropiado en acceso/registro/recuperación. |
| 49 | Parcial | Estado del índice se actualiza mientras hay pendientes y enlaza a errores/repreparación existente. No se agrega una nueva pantalla de reparación por documento. |
| 50 | Parcial | Revisión básica de instrucciones, conexiones, activación y Probar; conserva defaults editables y no enciende silenciosamente. Diagnóstico integral de proveedor, servicios y todas las referencias sigue siendo un trabajo separado. |
| 51 | Parcial | Importación dinámica por ruta. Compresión y caché de archivos en el proxy deben comprobarse en el despliegue; no se cambian a ciegas. |
| 52 | Aplicado | Eventos agregados en memoria, prueba de navegador y axe en CI; informe y protocolo humano conservados. |

## Verificación y aceptación

La regresión utiliza Chromium real, PostgreSQL + pgvector y permisos reales del arnés. IA, Evolution y verificaciones de plataformas externas se simulan. No se escanean teléfonos reales ni se envían campañas a clientes.

| Fase | Criterios verificados automáticamente | Validación adicional |
|---|---|---|
| 1 | Borrador de agente entre secciones/recarga y guardado real; contacto conservado durante polling y conflicto revisado; doble Enter produce un POST pendiente; errores conservan texto/ficha; navegación y sesión recuperables; importación rollback; paginación; campaña cancelada sin cambios y confirmada una sola vez. | Repetir tareas con datos propios en preproducción antes del despliegue. |
| 2 | Rutas por rol y enlaces del agente; conocimiento cancelado no reaparece como editado; reprogramación por slots y unidades de recordatorio en código/contratos; conexión guarda antes de verificar y no persiste credenciales en localStorage. | Piloto de nomenclatura y descubrimiento con personas nuevas/experimentadas. |
| 3 | 44 pantallas/variantes de rol con axe, sin hallazgos críticos/serios; 60 escenarios de tamaño/tema sin desbordamiento; contraste de acción con marca blanca; evidencia móvil. | Lectores de pantalla, teclado virtual Safari/Android, marcas reales y datos extensos. |
| 4 | Motor completo, contratos UX, solicitudes incrementales, foco de QR, navegación concurrente, instrumentación sin contenido de contactos y CI repetible. | Latencias/compresión del despliegue, cien ciclos prolongados y métricas de tareas humanas. |

### Resultado local

- Suite completa: **614 pruebas aprobadas**, cero fallos y cero omisiones, con PostgreSQL + pgvector.
- Tras el ajuste defensivo final de fechas vacías/inválidas: **9 contratos UX aprobados** de nuevo.
- Navegador final: **15 comprobaciones dirigidas, 44 pantallas/variantes de rol y 60 escenarios adaptables**. Cero errores JavaScript; cero hallazgos axe críticos/serios en las 44 pantallas examinadas.
- `check:frontend`, compilación TypeScript, sintaxis del widget y `git diff --check`: correctos. `npm audit --omit=dev --audit-level=high`: cero vulnerabilidades.
- [Resultados posteriores](verification/results.json), [agente en móvil](verification/bot-mobile.png) y [conversación en móvil](verification/conversation-mobile.png).

Estos resultados son del entorno local aislado; la ejecución del CI de GitHub y el despliegue son verificaciones distintas. Los hallazgos axe moderados/menores, si los hay, se conservan en el JSON.

### Ejecutar las comprobaciones

```bash
npm ci
npm run check:frontend
npm run build
npx playwright install --with-deps chromium
export TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/chatbot_test
export REQUIRE_PGVECTOR=true
npm test
npm run test:ux
```

`TEST_DATABASE_URL` debe apuntar a una **base aislada de pruebas**: el arnés reinicia `public`. Ejecutar las suites secuencialmente, nunca contra datos de usuarios. Para Chromium del sistema, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium` es opcional. CI usa PostgreSQL con pgvector y el navegador de Playwright. Los resultados/capturas se generan en `data/ux-test-results/` y se adjuntan como artifact de CI.

Los contratos adicionales están en [ux-contracts.test.ts](../../test/ux-contracts.test.ts); la regresión en [test-ux.mts](../../scripts/test-ux.mts). Los datos de la auditoría anterior se conservan en [baseline](baseline/results.json), separados de los resultados posteriores.

## Métricas y privacidad

`riverrun:ux` emite grupo API/ruta, rol, duración y resultado; máximo 200 entradas en memoria de la sesión. Registros muestra el diagnóstico agregado. Cerrar sesión limpia la muestra. No se registran IDs, URLs completas, emails, mensajes, prompts, QR ni claves. No se instala un servicio de analítica externa.

Los objetivos de tiempo por tarea, finalización, errores e interacciones están en la auditoría. Para evaluarlos, utilizar su protocolo de piloto: seis personas nuevas y cuatro experimentadas, mismas tareas/datos ficticios, separar tiempo activo de espera externa y registrar conteos además de porcentajes. La muestra automatizada no establece mejoras porcentuales de productividad ni p95 de producción.

El almacenamiento persistente se limita a configuración del agente/asistente y texto del negocio. Los contactos y notas de clientes permanecen en el servidor; credenciales de canal y configuraciones que podrían incluir secrets solo tienen borrador de memoria. No se guardan QR ni archivos en localStorage. Los borradores persistentes son locales al navegador, no sincronizados entre dispositivos; se descartan explícitamente o caducan a los siete días al recuperarse.
