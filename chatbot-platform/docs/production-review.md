# Revisión inicial de producción — punto 1

Fecha: 2026-10-06. Alcance: inspección del proyecto y comprobación de recuperación en un entorno aislado. No se desplegó ni modificó un servidor de producción.

## Evidencia y pendientes

| Elemento | Verificado en el proyecto/entorno | Pendiente en producción |
| --- | --- | --- |
| Alojamiento | La instalación documentada es un VPS con Docker Compose. | Proveedor, servidor, acceso operativo y ruta del checkout. |
| Publicación web | GitHub Pages publica `main` en `https://diegotrevio.github.io/Riverrun/`, sin dominio personalizado. Pages aloja contenido estático; este backend requiere Node, PostgreSQL y Evolution. | Identificar el dominio y dónde corre el backend real; Pages no confirma que la aplicación esté desplegada. |
| Base de datos | Compose declara `pgvector/pgvector:0.8.2-pg16`, bases `chatbot` y `evolution`, volumen `pgdata`. El entorno de desarrollo tiene PostgreSQL 16.15 sin vector; el de pruebas PostgreSQL 16.14 con vector 0.8.2. | Versión real, proveedor administrado/VPS, extensiones instaladas, tamaño, permisos y datos existentes. |
| Migraciones | Se ejecutan automáticamente antes de iniciar el backend. La migración 011 instala vector si está disponible y el usuario tiene permiso. | Historial aplicado, compatibilidad de los datos y copia recuperable antes de arrancar una imagen nueva. |
| OpenRouter | El backend lee la clave desde variables del servidor. Las claves OpenRouter/OpenAI no están configuradas en este entorno de desarrollo. | Comprobar presencia y autenticación en producción, saldo y disponibilidad de los modelos; nunca copiar claves al informe. |
| HTTPS | Caddy está en el perfil opcional `https`; el backend y Evolution se publican en loopback por defecto. | Dominio, DNS, certificado y URL pública del backend. |
| CI | [Chatbot quality](https://github.com/DiegoTrevio/Riverrun/actions/runs/37427538534) pasó instalación, build, pruebas y Promptfoo para el commit `b939525`. | Protección de la rama y proceso real para promover una versión aprobada. No hay workflow de despliegue del backend en el proyecto. |
| Copias | El README indicaba `pg_dumpall` y sesiones de Evolution, pero no comprobaba restauración. Se agregan las herramientas de esta revisión. | Última copia de producción, retención, almacenamiento privado externo, pruebas de restauración y recuperación de archivos/sesiones. |

La configuración declarada no demuestra la versión ni las credenciales de producción. Las imágenes `node:22-alpine`, `caddy:2-alpine` y `Evolution:latest` son etiquetas móviles; registrar las imágenes/digests realmente ejecutados antes de planificar una actualización. El desarrollo/evaluaciones necesitan Node >=22.22.

## Inspección de solo lectura en el servidor

Desde el directorio real de `chatbot-platform`, registrar la revisión desplegada y servicios sin imprimir el `.env` ni el Compose renderizado:

```bash
git rev-parse HEAD
docker compose ps
docker compose images
docker compose exec -T postgres sh -c 'exec psql -X -U "${POSTGRES_USER:-postgres}" -d chatbot' <<'SQL'
SHOW server_version;
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name IN ('vector', 'pgcrypto');
SELECT name FROM schema_migrations ORDER BY name;
SQL
```

Comprobar variables del **proceso del backend**, solamente su presencia:

```bash
docker compose exec -T backend node -e "for (const k of ['OPENROUTER_API_KEY','DATABASE_URL','SESSION_SECRET','EVOLUTION_API_KEY','SMTP_URL','PUBLIC_BASE_URL']) console.log(k + ': ' + (process.env[k] ? 'presente' : 'ausente'))"
```

Si la instalación utiliza otro proveedor o nombres de bases diferentes, adaptar estas lecturas a esa infraestructura. No asumir que las bases de desarrollo son producción. Autenticación válida y existencia de modelos deben verificarse después desde el backend con la clave del servidor; la presencia de una variable por sí sola no demuestra que funcione.

## Copias y ensayo de restauración

Para cada base se crea un directorio nuevo y privado. El script usa `pg_dump` dentro del contenedor de origen, produce un archivo custom, conserva roles globales, registra versión y conteos de tablas y agrega checksums. **Pausar las escrituras antes de usarlo como copia del sistema completo**: los dumps tienen snapshots propios y los conteos/archivos se obtienen en momentos separados. No detener producción sin una ventana de mantenimiento autorizada.

Ejemplo, sustituyendo contenedor y destino por los reales:

```bash
bash ops/backup-postgres.sh CONTENEDOR_POSTGRES chatbot /ruta/privada/backup-fecha/chatbot
bash ops/backup-postgres.sh CONTENEDOR_POSTGRES evolution /ruta/privada/backup-fecha/evolution
bash ops/verify-postgres-backup.sh /ruta/privada/backup-fecha/chatbot
bash ops/verify-postgres-backup.sh /ruta/privada/backup-fecha/evolution
```

El verificador rechaza archivos con checksums incorrectos y versiones mayores distintas de PostgreSQL 16. Restaura en un contenedor **nuevo**, sin red, puertos ni volúmenes de producción. Exige restauración sin errores y coincidencia de conteos por tabla. Al terminar destruye únicamente ese contenedor temporal. No inicia el backend ni Evolution, evitando respuestas, campañas y trabajos programados desde la copia. Los roles se conservan, pero no se ejecutan durante el ensayo; recuperar propietarios, permisos y secretos forma parte del procedimiento de recuperación real del operador. Conteos iguales no prueban por sí solos la equivalencia de todos los valores ni el funcionamiento del negocio: comprobar contactos, conversaciones, archivos y sesiones representativos en el ensayo de producción.

Además de las dos bases, una copia recuperable del sistema necesita:

- `uploads`: fotos y archivos referenciados por la app.
- `evolution_instances`: sesiones vinculadas de los teléfonos.
- `redisdata`: persistencia de Redis usada por Evolution.
- Configuración de despliegue y `.env`, almacenados de forma privada y cifrada; también registrar versiones/digests de imágenes. Copiar el `.env` nunca debe mostrarlo en logs ni subirlo a Git.
- `caddy_data` si se quiere conservar el estado de certificados, o un procedimiento comprobado para reemitirlos.

Archivar los volúmenes con un procedimiento del proveedor/Docker después de pausar escritores y comprobar que los archivos pueden recuperarse. No copiar `pgdata` en caliente como sustituto de `pg_dump`. Conservar una copia cifrada fuera del servidor, definir retención y registrar fecha, checksums y resultado del ensayo. El nuevo script respalda PostgreSQL; no pretende respaldar esos volúmenes automáticamente.

## Resultado de esta revisión

Se creó una copia local del esquema de la aplicación en PostgreSQL 16 + pgvector y se restauró en un contenedor aislado con conteos coincidentes de 24 tablas y cero restricciones sin validar. Se comprueba también la recuperación con datos sintéticos y una columna vector(1536). Los archivos permanecen fuera del repositorio. Esto valida las herramientas y la compatibilidad local; **no acredita un respaldo o restauración de producción**.

Para cerrar el punto 1 faltan los datos de alojamiento/acceso operativo y ejecutar allí las lecturas, respaldos y ensayo. Hasta tener esa evidencia no se debe afirmar que producción está lista para activar pgvector ni modificar el servidor o sus volúmenes.
