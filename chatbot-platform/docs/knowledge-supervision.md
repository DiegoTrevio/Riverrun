# Punto 7: supervisión y avisos del conocimiento

El backend inicia una revisión al arrancar y programa la siguiente cinco minutos después de completar cada revisión. Solo consulta PostgreSQL: no genera embeddings ni conversaciones de prueba, no envía mensajes a teléfonos y no sondea OpenRouter. El proceso se detiene y espera su revisión en curso al cerrar el backend. Las pruebas que construyen la app no arrancan automáticamente este proceso.

## Dónde verlo

**Registros → Supervisión del conocimiento** muestra la última revisión por perfil: documentos pendientes, errores de embeddings, proporción de búsqueda por palabras, p95 de latencia, costo de IA registrado y alertas activas. **Notificaciones** contiene avisos y recuperaciones. Los administradores reciben únicamente los de su perfil; el maestro recibe los de todos. Los agentes de conversaciones no reciben estos avisos operativos.

`GET /api/knowledge/monitor` requiere administrador y aplica el alcance de la sesión. Un administrador no puede ampliar el alcance enviando `account_id` ajeno. El maestro puede filtrar por UUID. La ruta solo lee el último snapshot; actualizar la pantalla no ejecuta otra revisión ni hace llamadas IA. Un perfil aún no revisado muestra ese estado explícitamente. Los perfiles inactivos no se revisan automáticamente y pueden conservar un snapshot antiguo: comprobar siempre su fecha.

## Qué se registra

- Cada petición de embeddings del motor y del indexado registra éxito/error, etapa (proveedor, validación o almacenamiento), duración, modelo y cantidad de entradas. Cubre preparación manual, CLI, mantenimiento y consultas. No guarda el texto enviado, claves ni cuerpos de errores del proveedor.
- Las consultas semánticas registran selección o uso de búsqueda por palabras, motivo y duración; una consulta que no logra seleccionar fragmentos por presupuesto de contexto también cuenta como alternativa.
- La revisión guarda una muestra por perfil activo en `knowledge_monitor_samples`, el último estado en `knowledge_monitor_state` y las incidencias en `knowledge_alerts`. Las muestras se conservan siete días; el estado/incidencias se conserva para evitar duplicados después de reinicios. Borrar un perfil elimina sus datos por claves foráneas.
- Pendientes usa el inventario exacto de fragmentos para el modelo y contenido actuales, dentro del alcance semántico habilitado. Una huella de documentos pendientes permite distinguir falta de avance de ediciones o preparación parcial, sin guardar su contenido en la supervisión.
- Errores, alternativa, latencia y consumo usan una ventana móvil de una hora, con límite superior en la fecha de revisión. El consumo suma todas las ejecuciones IA del perfil, no solo embeddings. Las muestras contienen ventanas solapadas: no sumar sus importes; usar `ai_runs` para el total de un periodo.

## Avisos

| Condición | Valor inicial |
| --- | --- |
| Embeddings | Uno o más errores en la última hora |
| Pendientes | Mismo conjunto/versiones de documentos pendiente durante 15 minutos |
| Alternativa por palabras | Más del 5%, con al menos 20 consultas |
| Latencia de búsqueda o embeddings p95 | Más de 10 000 ms, con al menos 20 muestras del componente |
| Gasto alto | Más de 5 USD registrados en una hora por perfil |
| Costo no reportado | Uno o más embeddings exitosos sin `usage.cost` del proveedor |
| Entregas | Uno o más mensajes salientes marcados como fallidos en la última hora |
| Configuración/inventario | Búsqueda habilitada sin clave/extensión, o inventario que no pudo revisarse |

Una incidencia nueva genera un aviso al administrador activo del perfil y a los maestros activos. Si persiste, se recuerda como máximo una vez cada seis horas. Al dejar de detectarse se genera un aviso **Resuelto**; si reaparece, vuelve a avisar. Estado y notificaciones se escriben juntos en una transacción; los bloqueos de filas evitan avisos duplicados entre réplicas. Marcar una notificación como leída no resuelve la incidencia.

La resolución de errores/entregas se basa en que dejan de aparecer en la ventana de una hora; no prueba por sí sola una nueva petición exitosa. Una edición, progreso de indexado, retirada del alcance o desactivación de búsqueda reinicia/retira el aviso de pendientes. Estas acciones se reflejan en el snapshot, sin borrar conocimiento ni conversaciones.

Los importes registrados pueden incluir precios estimados de `ai_prices` cuando falta el costo del proveedor. Se muestran ejecuciones con costo cero y embeddings sin costo reportado, sin afirmar que fueran gratuitos. Las peticiones de embeddings que fallaron pueden haber generado cargos que no están disponibles en su respuesta; esos cargos no se inventan ni se añaden al total. Revisar también el panel de facturación de OpenRouter. Los avisos no bloquean conversaciones, facturan ni aplican un límite de crédito.

Si falla el inventario pero PostgreSQL aún acepta escrituras, se guarda un aviso de revisión incompleta y se conserva el último snapshot. Si PostgreSQL o el proceso completo están caídos, la aplicación no puede guardar notificaciones: se registra una advertencia en la salida del servidor cuando es posible. Para detectar esas caídas hace falta el monitor externo del alojamiento. Este PR no envía correo, Slack o WhatsApp operativo.

## Configuración

Variables disponibles en `.env.example` y Compose; reiniciar el backend después de cambiarlas:

```dotenv
KNOWLEDGE_MONITOR_ENABLED=true
KNOWLEDGE_ALERT_PENDING_MINUTES=15
KNOWLEDGE_ALERT_FALLBACK_RATIO=0.05
KNOWLEDGE_ALERT_MIN_ATTEMPTS=20
KNOWLEDGE_ALERT_P95_MS=10000
KNOWLEDGE_ALERT_HOURLY_USD=5
```

`KNOWLEDGE_MONITOR_ENABLED=false` detiene nuevas revisiones/avisos y conserva el historial. En el panel se indica que está desactivado. `KNOWLEDGE_ALERT_HOURLY_USD=0` desactiva solo el umbral de gasto alto; sigue avisando si faltan costos reportados. Los umbrales deben ser finitos y no negativos, dentro de sus límites; un valor inválido impide arrancar. Ajustar proporción/muestras/latencia a la línea base del piloto antes de ampliarlo.

La migración `013_knowledge_supervision.sql` crea tablas e índice de eventos. Se aplica con el arranque/migración habitual; preservar el respaldo y el procedimiento del [punto 6](production-rollout.md). No requiere una clave nueva para observar o enviar avisos del panel.

## Validación

Se verifican con PostgreSQL/pgvector real y embeddings sintéticos: pendientes con gracia/avance, avisos por errores de preparación sin conversaciones, umbrales de muestras/latencia/costo, falta de costo reportado, entregas fallidas, aislamiento de perfiles, notificaciones concurrentes, resolución/reaparición, inventario roto y retención/apagado. Se comprueba además el panel en Chromium con fixtures sintéticas. Estas pruebas no acreditan el proveedor real ni un despliegue de producción.
