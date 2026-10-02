# Auditoría de la plataforma — octubre 2026

## Alcance

| Área | Cómo se revisó | Resultado |
|---|---|---|
| Compilación y dependencias | `tsc`, build, `npm audit`, `docker compose config` (con y sin perfil https) | Sin errores, 0 vulnerabilidades |
| Pruebas automáticas | Suite completo 3 veces seguidas | 128/128 en las 3 corridas |
| Migraciones | Base nueva (001→006), actualización desde 001 con datos, aplicar dos veces | Correctas e idempotentes |
| Docker | `docker build` y arranque de la imagen con PostgreSQL | Construye, migra, sirve el panel, corre como usuario `node`, queda *healthy* |
| Evolution API real (v2.3.7) | Contenedor oficial: crear instancia, webhook, estado, perfil, logout, borrar, recrear | Formatos confirmados; 2 fallos encontrados (abajo) |
| Aislamiento entre cuentas | **Todas** las rutas autenticadas (leídas del código) con admin y agente de otra cuenta | 114 intentos: 68 → 404, 46 → 403, ningún dato ajeno |
| Fugas de secretos | Todas las respuestas GET del panel (cuenta y superadmin) | Sin hash de contraseñas, tokens, QR, códigos ni llaves |
| Autenticación | Cookie `HttpOnly`/`SameSite=Strict`, sesión falsificada, límite de intentos, enlaces de un solo uso | Correcto |
| Webhooks entrantes | Token inválido, JSON roto, cuerpo de 11 MB, firma/secretos | 404 / 400 / 413 / rechazos correctos |
| XSS | Datos maliciosos en nombre, etiquetas, notas, mensajes, conocimiento y avisos, vistos en el navegador | Nada se ejecuta (todo es texto) |
| Inyección de instrucciones | El cliente "dicta" un precio y la IA obedece | Encontró un fallo (abajo) |
| Resiliencia | Backend matado con `kill -9` a mitad de conversación; PostgreSQL detenido y reiniciado; IA caída | 1 fallo grave encontrado (abajo) |
| Volumen | 1,000 contactos, campaña de 1,000, 20,000 registros de consumo | Listados ~13 ms, campaña programada en 1.5 s, consumo 38 ms |
| Horario de verano | Horarios y citas en Nueva York alrededor del cambio de hora | Correcto |
| Panel | 75 páginas en escritorio (3 roles) y 36 en celular (390 px), dos veces | Sin errores |

## Hallazgos

| # | Gravedad | Hallazgo | Estado |
|---|---|---|---|
| 1 | **Alta** | Si PostgreSQL se reiniciaba, una conexión inactiva lanzaba un error sin manejar y **el backend se caía**. | Corregido: el pool descarta la conexión rota y se reconecta solo; las transacciones liberan conexiones rotas. Verificado reiniciando PostgreSQL con el servidor arriba. |
| 2 | **Alta** | Conexión de WhatsApp: si Evolution no devolvía QR al instante (lento o sin salida a internet), la sesión **borraba y recreaba la instancia cada 3 s**, así el QR nunca alcanzaba a salir. | Corregido: máximo una solicitud cada 15 s; recreación solo tras 45 s sin código y máximo una cada 2 min; el QR que llega por webhook se muestra al instante. |
| 3 | Media | Al recrear una instancia, Evolution real tarda en liberar el nombre: la creación fallaba ("already in use") y la persona veía un error. | Corregido: espera a que se libere; si no, muestra "preparando" y reintenta. Verificado contra Evolution real. |
| 4 | Media | Un precio de **un dígito** dictado por el cliente ("cuesta $1") pasaba la verificación de datos. | Corregido: los montos de dinero siempre se verifican contra la información del negocio. |
| 5 | Media | Webhooks salientes: la IP se revisaba antes de conectar; un dominio con DNS cambiante (*DNS rebinding*) podía llegar a la red interna. | Corregido: la IP se valida en el momento de conectar; sin redirecciones; 10 s máximo. |
| 6 | Media | Si la IA (OpenAI) fallaba también en el reintento, el mensaje quedaba sin respuesta y **nadie se enteraba**. | Corregido: aviso al equipo ("⚠️ Un cliente espera respuesta") en el panel y por WhatsApp. |
| 7 | Media | "Horario y ajustes" aceptaba zonas horarias inexistentes y franjas invertidas (18:00–09:00), que rompen agenda, secuencias y campañas. | Corregido: se validan; el editor acepta "9-18". |
| 8 | Baja | El detector de tú/usted confundía nombres propios ("soporte de TI", "paquete Tus Uñas", "salón Te Consiento") y gastaba reintentos. | Corregido: ignora mayúsculas y nombres a mitad de oración. |
| 9 | Baja | Cada intento de reconexión de Evolution ("connecting", varios por minuto) se registraba como advertencia y llenaba Registros. | Corregido: solo se registran conexión y desconexión. |
| 10 | Baja | El `HEALTHCHECK` de Docker usaba siempre el puerto 3000. | Corregido: usa `PORT`. |
| 11 | Baja | Dos pruebas automáticas tenían carreras de tiempo (causa de una falla intermitente). | Corregido. |

### Aceptados (riesgo bajo, sin cambio)
- **Teléfonos dictados por el cliente:** el bot puede repetir un teléfono que el propio cliente escribió en la conversación. Los precios sí se bloquean siempre (#4).
- **Hora inexistente:** la hora que no existe el día que se adelanta el reloj (2:30 a.m. en EUA) se toma como 1:30. Solo afecta horarios en esa hora exacta.
- **Lista de conversaciones:** muestra las 100 más recientes; las anteriores se encuentran con el buscador.
- **Límites por IP con el backend expuesto sin Caddy:** con `PANEL_BIND=0.0.0.0` sin proxy, hay que poner `TRUST_PROXY_HOPS=0` o la IP se puede falsear con `X-Forwarded-For`. La configuración por defecto (Caddy delante) es segura.

## Lo que no se pudo probar aquí (requiere el servidor real)
El entorno de la auditoría no tiene salida directa a WhatsApp, Meta ni OpenAI. Con Evolution real se confirmaron los formatos de la API, pero no la vinculación con un teléfono.

**Lista de verificación en tu VPS (15 minutos):**
1. `docker compose --profile https up -d --build` y entrar al panel por HTTPS.
2. Registrar una empresa de prueba y confirmar el correo (SMTP configurado).
3. Paso 5 de Primeros pasos desde la **computadora**: el QR aparece solo; escanearlo. Debe decir "Conectado como …".
4. Desconectar, y repetir desde el **celular** con "Con mi número": recibir el código y vincular. Si WhatsApp rechaza el código con un número de México, probar con y sin el `1` después del `52`.
5. Desde otro teléfono escribir al número: el asistente responde con datos reales; pedir un precio inexistente: dice que no lo tiene confirmado.
6. Escribir "asesor": pasa a una persona y llega el aviso al WhatsApp de avisos.
7. Apagar el internet del teléfono del negocio unos minutos: llega el correo "Tu WhatsApp se desconectó" con el enlace para volver a vincular.
8. **Consumo de IA:** revisar que el gasto registrado coincida, aproximadamente, con el panel de OpenAI.
9. `docker compose restart postgres`: el panel y el bot siguen funcionando sin reiniciar el backend.

## Pruebas nuevas que quedan en el repositorio
- `test/isolation.test.ts`: recorre todas las rutas del panel con usuarios de otra cuenta. Las rutas nuevas quedan cubiertas solas, porque se leen del código.
- En las pruebas existentes se agregaron casos para:
  - la recreación de instancias (incluido el nombre ocupado);
  - el límite de solicitudes de QR;
  - los precios dictados por el cliente;
  - el DNS que apunta a la red interna;
  - la IA caída;
  - la validación de ajustes;
  - los nombres propios en el trato.
