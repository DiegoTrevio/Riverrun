# Preparación del conocimiento — punto 3

Requiere completar la [activación verificable del punto 2](semantic-activation.md) sobre la base correcta. La preparación genera consumo de embeddings por perfil/agente. No envía mensajes ni ejecuta campañas. No reemplaza documentos, contactos ni conversaciones.

## Inventario sin consumir IA

```bash
npm run knowledge:prepare -- --all
npm run knowledge:prepare -- --account UUID_DEL_PERFIL
npm run knowledge:prepare -- --chatbot UUID_DEL_AGENTE
```

Elegir exactamente un alcance. Sin `--apply` solo consulta documentos y fragmentos; no necesita la clave ni llama al proveedor. La CLI es una herramienta del operador del servidor con acceso a la base; no está expuesta como endpoint global a usuarios del panel.

La salida JSON por agente informa identificadores, documentos activos, esenciales, inactivos, preparados, pendientes, fragmentos esperados y cobertura completa. No muestra títulos, contenido, datos de clientes ni claves. Los esenciales se incluyen directamente en el contexto y no necesitan embeddings; los inactivos se excluyen. Un documento solo cuenta como preparado si todos sus fragmentos corresponden al contenido y modelo actuales, en orden y sin huecos. Un índice parcial se reporta pendiente y se repara.

## Preparar todos los documentos existentes

```bash
npm run knowledge:prepare -- --all --apply
```

Para comenzar con un perfil o agente, usar su selector en lugar de `--all`. En la imagen compilada:

```bash
docker compose -f docker-compose.yml -f docker-compose.semantic.yml run --rm --no-deps backend node dist/cli/knowledge-prepare.js --all --apply
```

El comando comprueba infraestructura, migraciones, configuración y presencia de clave antes de trabajar. Recorre los agentes secuencialmente, mantiene lotes de hasta 32 fragmentos y registra el consumo con su cuenta y agente. **`--all` incluye también agentes/perfiles pausados**: es una preparación explícita del operador; para evitar ese consumo elegir un perfil/agente.

En modo `--apply`, solo termina con código 0 cuando la cobertura está completa y no hay fallos; de lo contrario devuelve 1. El inventario de solo lectura termina con código 0 si pudo consultar el alcance, aunque existan pendientes. La salida final distingue el trabajo aplicado de un inventario. Si hay un fallo conserva los documentos completados, informa pendientes y continúa con otros agentes. Se puede repetir el mismo comando: los documentos completos no generan embeddings otra vez. Si se interrumpe, no hay archivos de progreso que reconstruir: PostgreSQL conserva el trabajo y los hashes identifican lo pendiente. Cambios concurrentes pueden dejar pendientes al terminar; repetir hasta obtener `complete: true` y `pending_items: 0`.

No considerar el inventario terminado una confirmación de producción: se debe ejecutar sobre su base y con el proveedor real, después del punto 2.

## Cambios posteriores

La migración `012_knowledge_index_invalidation.sql` agrega un trigger que elimina fragmentos al cambiar categoría, título, contenido, agente, estado activo o marca esencial. Esto ocurre dentro de la escritura del documento, sin llamar al proveedor. Cambiar únicamente el orden no vuelve a generar embeddings. Eliminar documentos elimina fragmentos por clave foránea. La migración funciona también en instalaciones sin pgvector.

El backend inicia un proceso de mantenimiento cuando la búsqueda y su clave están configuradas. Cada 30 segundos revisa pendientes, alterna agentes y prepara como máximo cuatro documentos de un agente por pasada. Los tiempos aumentan según documentos, agentes, latencia y reintentos del proveedor; no se garantiza que un documento quede listo en 30 segundos. No factura automáticamente perfiles pausados, desactivados o con la prueba vencida. Prepara conocimiento de agentes apagados dentro de perfiles elegibles, permitiendo probarlos en el simulador.

Las conversaciones mantienen su preparación limitada y búsqueda por palabras ante fallos. **Conocimiento → Preparar todo ahora** permite completar pendientes del agente sin esperar al proceso automático; la ruta continúa verificando rol y perfil. Si otra preparación/edición deja pendientes, informa el estado incompleto en vez de anunciar éxito. El panel muestra preparados, pendientes y esenciales.

Los bloqueos de PostgreSQL por agente/modelo coordinan procesos del backend y CLI, además del bloqueo local. Un proceso ocupado deja el trabajo pendiente para la siguiente pasada; nunca se considera completo por haber omitido ese agente. Las escrituras comprueban hash, estado y perfil después de generar los embeddings, evitando guardar documentos editados, desactivados o eliminados durante la llamada. El cambio de modelo vuelve a marcar fuentes como pendientes para ese modelo; sus fragmentos se guardan separados y las consultas usan únicamente el modelo configurado. Se conservan las versiones completas de otros modelos para que instancias con configuraciones diferentes no se destruyan mutuamente el trabajo durante una publicación. Cambiar o eliminar la fuente invalida todas esas versiones. Al cerrar el backend se detiene el temporizador y se espera la pasada que ya estaba en curso.

## Comprobación realizada

Se probaron con PostgreSQL y pgvector reales: inventario sin llamadas IA, selección por perfil, preparación de todos los agentes, repetición sin gasto adicional, reparación de un índice parcial, cambios sin conversación, desactivación/esenciales/eliminación, conservación tras fallo parcial, bloqueo entre procesos y cambio de modelo. Los embeddings de pruebas son sintéticos y deterministas; no acreditan el proveedor ni la cobertura de una base de producción inaccesible.

Si hay un piloto configurado mediante `KNOWLEDGE_SEARCH_ACCOUNT_IDS`, preparar solo sus perfiles con `--account UUID --apply`. La preparación global se rechaza si incluye cuentas fuera del piloto. Véase el [punto 6](production-rollout.md).
