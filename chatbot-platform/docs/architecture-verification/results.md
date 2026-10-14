# Verificación de la rama

Base revisada: main **b82d8fa**. PostgreSQL 16 con pgvector, Node 24, proveedor y canales simulados; sin producción.

| Comprobación ejecutada | Resultado |
|---|---|
| `npm run build` | Correcto |
| `npm run check:frontend` y `node --check public/app.js` | Correcto; 32 módulos |
| Suite completa `npm test` con `REQUIRE_PGVECTOR=true` | **772 casos: 759 pasan, 0 fallan, 13 omitidos** |
| Revisión de los últimos ajustes: arquitectura, cola, automatización, imágenes y mensajes guardados | **70 pasan, 0 fallan** |
| `npm run eval` | **6/6** |
| `npm run eval:engine` | **24/24**, base sintética separada creada y eliminada |
| `npm run test:ux`, base sintética separada | **15 comprobaciones, 44 pantallas, 60 escenarios adaptables**; sin errores de página ni infracciones axe graves/críticas |
| `npm run test:semantic:ux`, base sintética separada | **5 comprobaciones**: estado inicial, verificación/preparación/comparación/activación, móvil 390 px, tableta 768 px y rollback; sin errores de página ni infracciones axe graves/críticas |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilidades** |
| `git diff --check` | Correcto |

Los 13 omitidos están etiquetados `[real]` y requieren Evolution real mediante `scripts/evolution-compat.sh`. No se ejecutaron escaneo de un teléfono real, envíos reales ni evaluaciones con credenciales/cobro de OpenRouter. Las evaluaciones anteriores son regresiones sintéticas, no pruebas de la calidad de un modelo real.

## Fallos y recuperación cubiertos

- Proceso terminado con SIGKILL durante procesamiento y recuperación por otro proceso.
- Dos workers con sesiones PostgreSQL diferentes en la misma conversación; límite global de workers.
- Debounce guardado al cerrar y reanudado por otra instancia; apagado espera operaciones vivas.
- Webhooks simultáneos duplicados: una entrada, una decisión y una entrega.
- Sesión propietaria terminada durante la IA: no se envía sin propiedad; callback heredado no conserva derechos tras liberar la sesión.
- PostgreSQL temporalmente inaccesible: conservación del trabajo y reconexión.
- Proveedor de IA caído: backoff, límite de intentos, DLQ y recuperación autorizada.
- Control humano durante IA y control desde WhatsApp con dos workers ocupados.
- 5xx ambiguo: sin replay automático; revisión y reconocimiento administrativo.
- Rechazo explícito de foto: reintento de scheduler con una sola entrega efectiva.
- Indexación interrumpida: los lotes en caché se reutilizan; documentos modificados no publican una versión obsoleta.
- Acceso desde otra cuenta: consultar, verificar, preparar, probar y activar rechazados.
- Activación por cuenta, rollback, presupuesto, separación de cachés y documentos editados durante búsqueda.
- Regresión de citas, campañas, secuencias, solicitudes, preguntas y fotos por contexto/reglas en la suite y evaluaciones del motor.

## Evidencia

`results.json`, `general-ux.json` y `semantic-ux.json` contienen los recuentos/evidencia de navegador. CI publica también capturas de la activación semántica. Los procedimientos de despliegue/rollback y límites están en [durable-processing.md](../durable-processing.md).

## Reproducción

Usar **únicamente una base local de pruebas**: el arnés recrea su esquema. No lanzar dos suites contra la misma base simultáneamente.

```bash
TEST_DATABASE_URL=postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test REQUIRE_PGVECTOR=true npm test
npm run build
npm run check:frontend
npm run eval
TEST_DATABASE_URL=postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test npm run eval:engine
TEST_DATABASE_URL=postgres://chatbot:chatbot@127.0.0.1:5433/chatbot_test npm run test:semantic:ux
npm audit --omit=dev --audit-level=high
```

Para `test:ux`, proporcionar una base de pruebas separada si la suite sigue corriendo; `test:semantic:ux` crea su propia base local. En el entorno cloud se usó Chromium `/usr/bin/chromium`; CI instala Chromium con Playwright. El simulacro y métricas de producción permanecen sin certificar aquí.
