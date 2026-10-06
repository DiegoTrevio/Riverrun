# Auditoría de implementación

Fecha: 2026-10-06. Alcance: código y pruebas del PR #5, con PostgreSQL 16 y pgvector locales. No es una certificación del despliegue de producción.

## Hallazgos corregidos

1. **Arranque concurrente:** tres ejecuciones simultáneas de `migrate()` reproducían errores `23505` al crear tablas. Todas las operaciones de migración ahora usan una conexión con bloqueo asesor de PostgreSQL, incluyendo el esquema inicial y la activación posterior de pgvector. El bloqueo se libera al terminar o fallar; una conexión rota se descarta. Pruebas: instalación nueva concurrente, actualización sin perder datos, idempotencia y fallo con rollback seguido de arranque de otra réplica con pool de una conexión.
2. **Cierre con conversaciones activas:** aparecían errores `Cannot use a pool after calling end on the pool`, porque `app.close()` dejaba temporizadores y procesamiento pendientes. El cierre ahora cancela los temporizadores de la cola y espera las conversaciones activas, incluyendo el simulador; impide trabajo nuevo y reintentos durante el cierre. Los mensajes cancelados antes de procesarse conservan su estado pendiente en PostgreSQL para `resumePending()` al arrancar. Pruebas: cancelación, procesamiento activo, operación exclusiva y operación exclusiva en espera.

## Cobertura revisada

- Migraciones y restricciones de pertenencia entre cuenta, agente, canal, contacto y conversación.
- Permisos del maestro, administradores y agentes; bloqueo de lectura y escritura entre perfiles.
- Configuración del agente, captura automática en contacto/conversación/mensaje, correcciones concurrentes y resúmenes con historial completo y fuentes verificables.
- Hasta cuatro conexiones WhatsApp por cuenta, instancias independientes, QR y detección de conexión con Evolution simulada.
- Indexación por modelo y hash, invalidación al editar documentos, aislamiento de recuperación, piloto y alternativa por palabras.
- Avisos de documentos pendientes, embeddings, alternativa por palabras, latencia, costos y fallos de entrega; deduplicación, recuperación y permisos de destinatarios.
- Evaluaciones Promptfoo deterministas, presupuestos de evaluaciones reales y controles del workflow.
- Panel de supervisión en Chromium con servicios simulados y sin errores JavaScript.

## Verificación final

- Compilación TypeScript aprobada.
- Suite completa: 251 pruebas aprobadas, cero fallos y cero omitidas, con pgvector obligatorio; sin errores de uso del pool después del cierre.
- Promptfoo: 6 evaluaciones de componentes y 14 del motor aprobadas. El motor se evalúa en una base sintética independiente que se elimina al terminar.
- Chromium: métricas y avisos visibles, selección de perfil funcional y cero errores JavaScript.
- `git diff --check` aprobado.

## Límites operativos

Las pruebas locales usan proveedores simulados y datos sintéticos. La clave de OpenRouter, Evolution real y el despliegue de producción no están disponibles en este entorno: faltan pruebas reales de autenticación, generación/escaneo de QR, respuestas y embeddings del proveedor, y ejecución del workflow protegido. Los procedimientos están en `production-rollout.md` y `knowledge-supervision.md`.

La cola de conversaciones es local a un proceso. Serializar las migraciones permite arranques concurrentes seguros del esquema; no habilita varias réplicas para procesar simultáneamente las mismas conversaciones. Mantener un único proceso consumidor hasta implementar coordinación distribuida. Una caída total de PostgreSQL requiere supervisión externa: no puede escribir avisos dentro de esa misma base.
