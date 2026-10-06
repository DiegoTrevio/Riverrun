# Punto 5: calidad continua y consumo de evaluaciones

Este punto prepara CI y la ejecución periódica de Promptfoo. **No despliega la aplicación, no modifica bases de producción y no acredita todavía el proveedor real.** pgvector se activa y prepara en el servidor mediante los puntos [2](semantic-activation.md) y [3](knowledge-preparation.md).

## Flujos

| Workflow | Cuándo se ejecuta | Credenciales | Resultado |
| --- | --- | --- | --- |
| `Chatbot quality` | PR, push a main o llamada desde el workflow real | Ninguna clave IA | Build, pruebas PostgreSQL/pgvector, componentes y motor; reportes sintéticos |
| `Chatbot live quality` | Manual desde main; lunes 08:30 UTC si se habilita | Clave dedicada del entorno `promptfoo-live` | Primero CI determinista; después 7 casos reales; consumo y reportes |

La ejecución real exige `main`; no hay eventos `pull_request_target` ni secretos entregados a código de forks. La clave se inyecta solamente en el paso de evaluación. El job utiliza PostgreSQL local temporal y transporte simulado, tiene timeout de 15 minutos y conserva reportes sintéticos durante siete días. Las ejecuciones reales se serializan y no cancelan una ejecución activa para lanzar otra. Un error de evaluación hace fallar el job.

El workflow semanal está **desactivado por defecto**. Después de integrar el PR, el operador configura en GitHub:

1. Un environment `promptfoo-live`, restringido a la rama `main`, con revisores requeridos si el plan de GitHub lo permite. La declaración YAML no crea esas protecciones automáticamente.
2. El secret de ese environment `OPENROUTER_EVAL_API_KEY`: una clave dedicada con límite de crédito en OpenRouter, sin renovación automática del límite. No reutilizar la clave de producción. El código la recibe como `OPENROUTER_API_KEY`.
3. Una primera ejecución manual de **Actions → Chatbot live quality → Run workflow** en main. Exigir siete casos aprobados, sin errores, y revisar consumo/artefactos.
4. Solo tras verificarla, la variable del repositorio `RIVERRUN_LIVE_EVAL_ENABLED=true` habilita el horario semanal. Suprimirla o ponerla en `false` desactiva nuevas ejecuciones semanales; una ejecución en curso conserva su presupuesto.
5. Configurar la protección/ruleset de main para exigir el check determinista `test` de `Chatbot quality` antes de fusionar. Confirmar el nombre observado del check en un PR real. El check real bajo demanda no debe exigirse en todos los PR porque solamente ejecuta código de main.

No se han creado secrets, environments, rulesets, cron activo ni despliegues desde este entorno. La inspección actual solo encontró `github-pages`; el API de protección de main respondió 403, por lo que su estado no se puede acreditar aquí. No compartir valores de claves en chat ni subirlos al repositorio. Las notificaciones de fallo utilizan las preferencias normales de GitHub Actions; no hay envío de Slack/correo desde la app.

## Presupuesto

Ambos comandos reales (`eval:live` y `eval:engine:live`) comparten la implementación `LiveBudget` dentro de cada ejecución. El presupuesto es por ejecución, no global entre máquinas/comandos. Por defecto:

| Variable | Valor | Máximo aceptado |
| --- | --- | --- |
| `RIVERRUN_EVAL_MAX_USD` | 1 USD | 10 USD |
| `RIVERRUN_EVAL_MAX_CALLS` | 40 | 40 |
| `RIVERRUN_EVAL_MAX_OUTPUT_TOKENS` | 2000 | 2000 |
| `RIVERRUN_EVAL_USAGE_FILE` | Sin archivo | Ruta a reporte numérico |

El workflow fija los valores por defecto y modelos `openai/gpt-4.1-mini` para chat/resúmenes y `openai/text-embedding-3-small` para embeddings. Otros modelos requieren revisar la política del código; no se aceptan automáticamente. Las peticiones reales de evaluación usan un solo intento HTTP por llamada, evitando que reintentos ocultos consuman varias solicitudes. La aplicación conserva tres intentos por defecto.

Antes de llamar, se reserva una estimación conservadora basada en bytes del contexto/schema, margen de 4096, salida máxima y techos de 5 USD/MTok de entrada, 20 USD/MTok de salida o 1 USD/MTok para embeddings. Son **techos locales para reservar**, no tarifas verificadas del proveedor ni una garantía de facturación. Rechaza entradas serializadas mayores de 100 KB y no inicia peticiones que excedan el saldo estimado o el número de llamadas. Las reservas cuentan también si hay llamadas simultáneas.

Después incorpora `usage.cost` real y tokens. Un costo ausente/inválido, un error del proveedor o un costo superior a la reserva/presupuesto detiene todas las llamadas siguientes y hace fallar la suite integral mediante una aserción común, incluso cuando el motor maneja el error con una respuesta alternativa. Una petición fallida conserva su reserva porque podría haberse cobrado. El reporte incluye USD reportados, reservas pendientes y número de costos desconocidos; estos conceptos no se suman como si todos fueran cargos confirmados.

**El límite monetario estricto debe aplicarlo OpenRouter en la clave dedicada.** Un costo inesperado solo se conoce después de la petición; el control local detiene las siguientes, pero no deshace un cargo. El límite del proveedor también protege ante interrupciones, máquinas paralelas, scripts externos y ejecuciones repetidas. Revisar tarifas y saldo de esa clave antes de habilitar el horario y renovar su crédito de forma deliberada cuando proceda.

```bash
mkdir -p evals/results
RIVERRUN_EVAL_MAX_USD=1 RIVERRUN_EVAL_USAGE_FILE=evals/results/usage.json \
  npm run eval:engine:live -- --output evals/results/live.json
node scripts/eval-summary.mjs
```

La clave se suministra mediante variables privadas del servidor o `.env` ignorado. La CLI no imprime su valor. El reporte de consumo solo guarda números y límites; los reportes Promptfoo solo incluyen las fixtures sintéticas. No exportar conversaciones reales para estos workflows.

## Validación y habilitación pendientes

Se comprueban localmente reservas previas, llamadas concurrentes, límites compartidos entre chat/resumen/embeddings, costos desconocidos, fallos, modelos no permitidos, reporte sin secretos, ausencia de reintentos ocultos y compatibilidad de los reintentos normales. También se ejecuta la suite integral con presupuesto insuficiente y red bloqueada para demostrar que falla sin enviar solicitudes.

Para acreditar operación real faltan: configurar la clave y acceso a `openrouter.ai`, integrar el PR, configurar las protecciones de GitHub, ejecutar los siete casos con el proveedor real y completar activación/indexado/verificaciones en el servidor de producción. No marcar producción como plenamente activa hasta disponer de esa evidencia.

El despliegue gradual por perfiles, diagnóstico sin gasto IA y recuperación están en el [punto 6](production-rollout.md).
