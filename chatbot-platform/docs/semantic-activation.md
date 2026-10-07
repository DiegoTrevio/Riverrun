# Activación de pgvector — punto 2

Este procedimiento activa la infraestructura y el proveedor. La preparación de todos los documentos corresponde al punto 3. No ejecuta campañas, transportes ni trabajos del backend durante las comprobaciones.

## Antes de cambiar el servidor

Completar la [revisión de producción y copia recuperable](production-review.md). La clave OpenRouter debe estar configurada de forma privada en el servidor. Confirmar PostgreSQL 16, versión de parche, extensión disponible y permisos de instalación. La imagen probada es `pgvector/pgvector:0.8.7-pg16` con PostgreSQL 16.15; no cambiar a una imagen con versión PostgreSQL anterior a la desplegada.

No asumir que un volumen es compatible solo porque ambas imágenes dicen PostgreSQL 16. Al cambiar el sistema operativo/libc puede cambiar la versión de **collation**, que PostgreSQL usa para ordenar textos e índices. El ensayo con un volumen de `postgres:16` detectó versiones 2.41 y 2.36 distintas. La app y la herramienta bloquean migraciones ante esa diferencia; actualizar únicamente la versión registrada sin reconstruir índices ocultaría el problema.

Si las imágenes no son compatibles, conservar el volumen original y restaurar la copia lógica en un PostgreSQL nuevo con pgvector. Verificar conteos, permisos, datos y archivos antes de cambiar la conexión. No usar `docker compose down -v`, no iniciar dos servidores sobre el mismo volumen y no borrar el volumen original. Una instalación con PostgreSQL administrado mantiene su servidor y utiliza la extensión que ofrece su proveedor.

## Diagnóstico y activación

Desde el proyecto, con `DATABASE_URL` apuntando expresamente a la base correcta:

```bash
npm run knowledge:check
```

El diagnóstico es de solo lectura. Informa versión de PostgreSQL, compatibilidad de collation, versión instalada de vector, tipo vector(1536), migraciones pendientes y presencia de clave/flag. No imprime claves, cadenas de conexión, datos del cliente ni respuestas del proveedor. Sin comprobación real del proveedor no devuelve `ready: true` y su código de salida es 1.

Configuración requerida del backend:

```dotenv
KNOWLEDGE_SEARCH_ENABLED=true
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Además, `OPENROUTER_API_KEY` debe tener un valor válido; nunca incorporarlo al repositorio ni a los comandos del informe. Después de la copia verificada y en la ventana de mantenimiento:

```bash
npm run knowledge:activate
```

La activación comprueba la versión, la collation, la disponibilidad de la extensión y la configuración antes de modificar el esquema. Aplica las migraciones transaccionales existentes, vuelve a comprobar el tipo vectorial y genera **un embedding sintético** con el modelo configurado. Verifica sus 1536 dimensiones y una consulta coseno en PostgreSQL. Esa llamada genera un pequeño consumo en OpenRouter; no se asocia a un cliente ni se incluye en el consumo de un perfil. La herramienta no modifica `.env` ni enciende automáticamente procesos.

La activación solo termina con código 0 si no quedan problemas y `provider: verified`, `ready: true`. Un fallo de autenticación/modelo deja la activación incompleta; las migraciones ya aplicadas se conservan y se puede repetir sin borrar datos. Nunca empezar el servicio basándose solo en `database_ready: true`.

## Docker Compose

El archivo `docker-compose.semantic.yml` activa la búsqueda y exige la clave. Mantener el mismo directorio/proyecto Compose que el despliegue existente, sus volúmenes y todas sus variables; no crear otro nombre de proyecto por accidente. Después de preparar una base compatible y respaldar:

```bash
docker compose -f docker-compose.yml -f docker-compose.semantic.yml build backend
docker compose -f docker-compose.yml -f docker-compose.semantic.yml run --rm --no-deps backend node dist/cli/knowledge-activate.js --apply --verify-provider
```

La base debe estar disponible antes del comando `run`; este usa el `DATABASE_URL` del backend, no crea un servidor de base ni inicia Evolution. Con el resultado verificado, publicar el backend en la ventana autorizada:

```bash
docker compose -f docker-compose.yml -f docker-compose.semantic.yml up -d --no-deps backend
docker compose -f docker-compose.yml -f docker-compose.semantic.yml exec -T backend node dist/cli/knowledge-activate.js --verify-provider
```

Usar ambos archivos también en publicaciones futuras para conservar la activación. Si se usa Caddy, mantener además el perfil HTTPS habitual. Si la base se restaura en otro servidor o volumen, adaptar la conexión antes de estos pasos; Compose base apunta al servicio `postgres`. No arrancar automáticamente una copia completa del backend para ensayar restauraciones: el arranque reanuda tareas pendientes.

## Recuperación y evidencia

Ante problemas del proveedor, el motor conserva la búsqueda por palabras. Para desactivar la función explícitamente, volver a publicar el backend con `KNOWLEDGE_SEARCH_ENABLED=false` y sin el overlay que la fuerza a true. No eliminar documentos, fragmentos o migraciones. Esto revierte el comportamiento de búsqueda; no es una instrucción para regresar a una imagen PostgreSQL anterior ni para conectar la base original después de recibir nuevas escrituras.

Ensayos locales: respaldo/restauración sobre PostgreSQL 16.15, migraciones repetidas conservando datos, detección de un volumen con collation incompatible, activación mediante CLI con embeddings sintéticos, rechazo de dimensiones incorrectas y errores sin exponer claves. La extensión probada es vector 0.8.7. El modelo real y el servidor de producción solo se acreditan cuando la comprobación se ejecuta allí con acceso y credenciales válidas.
