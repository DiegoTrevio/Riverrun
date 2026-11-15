# Velocidad: qué hay, qué se hizo y qué no aplica

Revisión del 2026-11-15 contra una lista común de mejoras de rendimiento. Riverrun corre en un solo Droplet de 4 GB con Docker; el panel son módulos ES nativos sin build ni React.

| Punto | Estado | Dónde o por qué |
|---|---|---|
| Siluetas de carga | Hecho | `loadingSkeleton` en `public/js/core.js`; el lector de pantalla oye «Cargando…» y la animación se apaga con «reducir movimiento». |
| Imágenes WebP/AVIF | Hecho | Capturas de la ayuda en AVIF y WebP con la JPG de respaldo (`<picture>`); se quitaron tres capturas que nadie usaba. |
| Búsquedas mientras se escribe (debounce) | Hecho | Bandeja de conversaciones y cotizaciones buscan 300 ms después de dejar de escribir, y una respuesta vieja no tapa la nueva. Cobros ya lo hacía. La tabla de conversaciones y Contactos siguen buscando al presionar Enter, porque cambian la dirección y redibujan la pantalla. |
| Carga diferida de imágenes | Ya estaba | `loading="lazy"` en fotos del chat, catálogo, redes y ayuda. |
| Dividir el JavaScript por página | Ya estaba | Cada pantalla se pide con `import()` al abrirla (`public/js/main.js`). |
| Virtualizar listas largas | No aplica hoy | Las listas ya paginan (50 por página con «cargar más», tope 500); no se dibuja todo de golpe. |
| Caché del navegador | Hecho / ya estaba | Fuentes un año (`immutable`) e imágenes una semana (`src/static-cache.ts`). JS y CSS siguen con ETag (304 sin descargar): sus nombres no llevan versión y guardarlos sin preguntar mezclaría dos versiones tras actualizar. |
| Fuentes locales y pocos grosores | Ya estaba | DM Sans variable en `public/fonts/` (un archivo para todos los grosores), `font-display: swap`. |
| CDN | No aplica hoy | Todo el panel pesa menos de 1 MB comprimido y lo usan negocios en México; Caddy ya lo entrega comprimido y en caché. Cloudflare delante del dominio es el paso natural si hace falta. |
| Brotli o gzip | Hecho / ya estaba | Caddy comprime con zstd o gzip; ahora además el panel viene comprimido en Brotli y gzip desde la imagen (`scripts/minify-public.mjs`), sin gastar CPU por petición. |
| Balanceo entre varias instancias | No aplica hoy | Un solo servidor; la cola y los límites ya lo permitirían (ver [produccion-10-puntos.md](produccion-10-puntos.md#9-escalar)). |
| Evitar llamadas duplicadas | Ya estaba | `api()` en `core.js` junta peticiones iguales en curso y guarda catálogos breves. |
| Paginación | Ya estaba | Conversaciones, contactos y mensajes con cursor; cotizaciones y cobros con tope. |
| Peticiones en paralelo | Ya estaba | `Promise.all` en el panel y en el backend donde las consultas no dependen entre sí. |
| Pedir solo las columnas necesarias | Ya estaba en lo caliente | La lista de conversaciones elige columnas; donde hay `SELECT *` el panel usa esas columnas. |
| Cola de trabajos | Ya estaba | `src/engine/queue.ts` (en PostgreSQL). |
| Timeout a servicios externos | Ya estaba | Toda llamada `fetch` lleva `AbortSignal.timeout`. |
| Respuestas de IA en streaming | No aplica | Cada respuesta pasa entera por el validador antes de enviarse (no inventa precios ni enlaces), y WhatsApp, Messenger o Instagram reciben un mensaje completo, no por partes. |
| Optimistic UI | No aplica en general | Casi todo lo que se guarda pasa por validaciones del servidor (permisos, montos, plantillas); mostrarlo antes y deshacerlo confundiría. |
| Consultas N+1 | Ya estaba en lo caliente | Listas con `LATERAL ... LIMIT 1`. Queda una al reiniciar las conversaciones de un agente (rara), para después. |
| Redis | No aplica hoy | Un solo proceso: los datos más consultados ya se guardan en memoria (salud, modelos, PDF, calendarios). Redis sumaría un contenedor y memoria al Droplet. |
| Índices | Hecho | Migración 123: avisos de entrega de Zernio por id externo y registros/corridas de IA por cuenta. |
| Pool de conexiones | Ya estaba | `src/db.ts`, con tiempo límite por consulta. |
| Rastrear peticiones lentas | Hecho | `SLOW_REQUEST_MS` (2 s): queda en el registro y en `/metrics` (`riverrun_http_*`). Sin OpenTelemetry: pediría otro servicio y memoria. |
| Servidor cerca de la base | Ya estaba | Están en el mismo Droplet. |
| Renderizar en el servidor | No aplica | El panel es privado y depende de la sesión; las páginas públicas (reservas, cotización, ayuda) ya son HTML del servidor. |
| Scripts de terceros después de cargar | Ya estaba | El panel no carga scripts de terceros. |
| Quitar dependencias sin uso | Ya estaba | Cada dependencia se usa. |
| Velocidad real de usuarios | Parcial | El panel mide cada llamada (`recordUX`) en el navegador, pero no la envía al servidor; `/metrics` ya da el tiempo del lado del servidor. |
| Celulares y redes lentas | Ya estaba | Las pruebas `npm run test:*:ux` revisan pantallas de celular; probar con red lenta es manual (DevTools, «Slow 4G»). |

## Para después

- `GET /api/contacts` agrupa todos los contactos de la cuenta en cada página: medir con unos 20 mil antes de reescribirlo.
- El total de cobros del mes lee todo el historial de la cuenta: un índice parcial de pagados cuando haya muchos.
- Búsqueda `ILIKE '%texto%'` sin índice trigram: solo si una cuenta pasa de unos 20 o 30 mil contactos.
