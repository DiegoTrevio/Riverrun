# Versiones y pruebas propias de agentes

En el panel, **guardar es aplicar**: al pulsar **Guardar cambios** en cualquier sección del agente (instrucciones, preguntas, activación, avisos, estilo, recorrido, reglas, mensajes guardados o modelo), el cambio llega de inmediato a todas sus conexiones y queda una **versión** en el historial con su autor. Las pruebas automáticas son opcionales.

## Uso en el panel

1. En la ficha del agente, ajusta lo que necesites y pulsa **Guardar cambios** (`POST /api/chatbots/:id/version-apply`). Se aplica en una transacción y queda en el historial. La revisión detecta cambios concurrentes (otra pestaña) y pide recargar. Si la configuración cambió por otra vía (asistente de creación, primeros pasos o la API compatible) y no había cambios pendientes, se parte de la configuración actual sin perder ese cambio.
2. En **Opciones avanzadas → Historial de versiones** aparece cada versión con fecha y autor; **Volver a esta versión** la aplica de inmediato (recupera la configuración y las reglas de envío de fotos; no el conocimiento, los archivos ni las conexiones).
3. **Probar** usa siempre lo último que guardaste. En **Probar → Pruebas automáticas (opcional)** puedes guardar ejemplos del negocio: mensajes del cliente y resultados esperados (texto que debe aparecer o evitarse, acción, códigos de fotos, datos del contacto y reserva simulada). **Guardar y ejecutar pruebas** usa el proveedor/modelo configurado y el mismo motor; los errores y respuestas de respaldo no aprueban los casos. Se muestran respuestas, motivos de fallo, modelos, llamadas, tokens y costo informado por el proveedor.
4. Si un agente tenía cambios guardados como borrador con la versión anterior del panel, la ficha muestra **Aplicar cambios** o **Descartar**.

Para integraciones que quieran exigir pruebas antes de publicar, la API conserva el flujo anterior: `PUT /api/chatbots/:id/version-draft` guarda un borrador sin tocar la versión en vivo y `POST /api/chatbots/:id/version-publish` lo publica solo con una ejecución aprobada (válida 24 horas e invalidada por cambios del borrador, suite, fuentes, catálogo, servicios, reglas, ajustes de la cuenta, proveedor o modelo).

**Alcance:** encender/pausar el agente sigue siendo una operación inmediata. Conocimiento, archivos del catálogo, avisos al equipo, automatizaciones y conexiones conservan sus editores actuales y se actualizan al guardarlos; invalidan las pruebas cuando forman parte de su firma. Las versiones recuperan la configuración y las reglas de envío de fotos incluidas en la versión. No recuperan archivos eliminados, no revierten datos de clientes ni citas y no cambian los QRs. Al restaurar etapas se conservan las que coinciden exactamente; las que desaparecen vuelven a etapa 0.

## Seguridad e integridad

- Migración aditiva `047_agent_versions.sql`: versiones publicadas, borrador con revisión, suite con revisión y ejecuciones con firma/estado. Un trigger registra incluso actualizaciones de la API compatible y operaciones internas. Se guardan autor y motivo; las operaciones históricas anteriores a esta migración se representan por una versión inicial.
- El editor usa `PUT /api/chatbots/:id/version-draft`. La API existente `PUT /api/chatbots/:id` mantiene el contrato de actualización inmediata para integraciones existentes y queda auditada; si modifica el agente, bloquea la publicación de un borrador basado en la configuración anterior. No debe usarse como API de borradores. No modifica las funciones críticas existentes.
- Solo administradores del perfil y el master acceden a versiones, configuración y pruebas. Cada consulta valida primero la propiedad del agente. Los operadores no acceden a prompts ni resultados. No se incluyen credenciales en exportaciones de Promptfoo.
- La publicación bloquea los recursos relevantes durante la comprobación final y aplica configuración, reglas de fotos y remapeo de etapas en una sola transacción, con una sola versión histórica.
- Las pruebas usan un canal interno y contacto nuevos por caso. El borrador se proporciona al motor mediante un contexto `AsyncLocalStorage`, nunca escribiéndolo en el agente compartido. Las ejecuciones concurrentes por agente se impiden con un índice único de PostgreSQL.
- Se usan transporte de simulación y extensiones del motor sin entregas de automatización, notificaciones, sincronizaciones ni reservas externas. Los horarios vienen de la agenda real para validar el plan, pero reservar solo registra un resultado en memoria. No ocupa horarios ni crea citas. Las imágenes se comprueban por su salida planificada; esto no certifica la entrega de WhatsApp/Evolution.
- Contactos, mensajes y conversaciones de los casos se eliminan al terminar. El historial de resultados se conserva para administradores; usa ejemplos sintéticos, sin datos personales reales. El consumo de IA se mantiene en la cuenta para su observación habitual.
- Límites por ejecución: 10 casos, 6 turnos por caso, 40 llamadas, 1.200 tokens de salida por llamada y dos minutos antes de iniciar otra llamada. Si el proveedor informa un costo acumulado de USD 1, no se inicia otra llamada. El límite por tiempo/costo no cancela una petición ya enviada y no constituye una garantía de facturación cuando el proveedor no informa su precio. Solo una evaluación por agente puede estar activa.
- Las evaluaciones no se reenvían automáticamente tras una caída del proceso: se marcan interrumpidas después de cinco minutos al revisar su estado o solicitar otra ejecución y se limpian sus canales temporales. Se vuelven a ejecutar explícitamente. La publicación siempre requiere una ejecución finalizada y válida. El cierre normal espera que terminen antes de detener el motor.

## Promptfoo

En **Probar**, pulsa **Exportar a Promptfoo** y guarda el archivo como `chatbot-platform/evals/agent-promptfoo.json`. El proveedor `evals/agent-cases-provider.mjs` consulta la app autenticada, verifica la revisión de borrador/suite y ejecuta exactamente los mismos casos y comprobaciones del panel, una vez por suite. Promptfoo presenta cada caso como una evaluación propia.

Con `RIVERRUN_APP_URL` y `RIVERRUN_SESSION_COOKIE` configurados de forma segura en el entorno, ejecuta desde `chatbot-platform`:

```sh
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_CONFIG_DIR=/tmp/riverrun-promptfoo \
  npx --no-install promptfoo eval -c evals/agent-promptfoo.json --no-cache --max-concurrency 1
```

No guardes la cookie en el archivo exportado ni en Git. La app remota debe usar HTTPS; la sesión requiere permisos de administración y puede caducar. Si cambia el borrador o la suite, exporta nuevamente. Las regresiones globales `npm run eval` y `npm run eval:engine` conservan su funcionamiento.

## Verificación y despliegue

`npm run build`, `npm run check:frontend`, `npm test` y las evaluaciones existentes validan las regresiones. `npm run test:agent:ux` crea una base local temporal, verifica guardado/publicación/invalidación y cambios sin guardar en Chromium, ejecuta la exportación con Promptfoo y comprueba accesibilidad y ancho en 1.366, 768 y 390 píxeles. Nunca se ejecuta contra una base remota.

Las pruebas de `test/agent-versions.test.ts` cubren aislamiento del borrador, concurrencia, autor/historial, bloqueo sin pruebas, invalidación por cambios, recuperación, captura de datos, activación, fotos, reserva sin efectos externos y remapeo/reversión de etapas. El suite general incluye auditoría de permisos para las nuevas rutas.

Aplicar la migración mediante el proceso normal antes de servir la nueva interfaz. No se crea un nuevo servicio ni una dependencia en producción. Las versiones iniciales conservan la configuración existente. Para retirar la interfaz nueva se pueden conservar las tablas; los cambios directos seguirán registrándose. No borrar tablas mientras se quiera conservar historial o resultados. Cambios del contrato de evaluación del motor deben incrementar la revisión `engine` de `qualitySignature` para invalidar resultados del contrato anterior.

## Criterios de aceptación

- Guardar desde el panel aplica el cambio de inmediato y deja una versión en el historial con su autor.
- Dos sesiones no pueden sobrescribirse ni aplicar una revisión antigua.
- Por la API de borrador, una suite fallida, vacía, obsoleta o con fallos de IA impide publicar.
- Todas las conexiones del agente reciben la misma versión.
- Volver a una versión la aplica de inmediato y deja un nuevo registro histórico.
- Las pruebas pueden verificar preguntas, datos, fotos, transferencias y reservas sin mensajes ni citas de producción.
- Un caso exportado a Promptfoo devuelve el mismo resultado que el panel.
- Los controles son utilizables con teclado y no generan incidencias graves de accesibilidad ni desbordamiento en los anchos verificados.

No se ejecutaron llamadas reales a OpenRouter ni entregas a teléfonos como parte de las regresiones sintéticas; requieren credenciales y canales de prueba del entorno desplegado.

## Evidencia de esta implementación (2026-10-13)

| Comprobación | Resultado |
|---|---|
| Build TypeScript, sintaxis/imports del panel y `git diff --check` | Aprobados |
| Suite general con PostgreSQL 16 y pgvector | 793 casos: 780 aprobados, 0 fallidos, 13 omitidos que requieren Evolution real |
| Verificación final de versiones, migraciones, persistencia y aislamiento | 35/35 aprobados; incluye 23 casos de versiones/pruebas |
| Promptfoo global de contexto y validador | 6/6 aprobados |
| Promptfoo del motor completo | 24/24 aprobados |
| Navegador para borradores y pruebas propias | 8 comprobaciones aprobadas; 1 caso exportado aprobado por Promptfoo; 6 combinaciones de sección/ancho accesibles |
| Regresión general de interfaz | 15 comprobaciones, 44 pantallas y 60 escenarios adaptables aprobados |
| Asistente de activación semántica | 5 comprobaciones aprobadas |

Las verificaciones del navegador y Promptfoo usaron bases temporales independientes y un proveedor sintético. La verificación final incluye los dos casos de cancelación de reserva y guardado idéntico añadidos después de la suite general. No se desplegó ni se enviaron mensajes de producción.
