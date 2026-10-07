# Riverrun

Plataforma para dar a un negocio un **asistente de WhatsApp** (y Telegram, Instagram, Messenger y chat web) que responde con la información del propio negocio, agenda citas, atiende solo lo que puede y avisa a una persona cuando hace falta. Todo se configura desde un panel web, sin programar.

## Empieza aquí

| Quiero… | Ve a |
|---|---|
| **Instalar la plataforma** en mi servidor | [Instalación en 3 comandos](#instalar-en-3-comandos) |
| **Usar el panel** (soy cliente / dueño de un negocio) | [Guía del cliente](chatbot-platform/public/ayuda.html) — también está dentro del panel, en *Ayuda* |
| **Operar** (respaldos, actualizar, cobros, alertas) | [Manual técnico](chatbot-platform/README.md) y [`docs/`](chatbot-platform/docs) |
| **Entender el código** | [Estructura](chatbot-platform/README.md#estructura) |
| **Contribuir** | Las pruebas y el CI corren con `npm test` (ver [CI](.github/workflows/ci.yml)) |

## Instalar en 3 comandos

En un VPS con Linux (2 GB de RAM bastan):

```bash
git clone https://github.com/DiegoTrevio/Riverrun.git
cd Riverrun/chatbot-platform
./riverrun install
```

El instalador pregunta lo mínimo (dominio, tu correo y la clave de [OpenRouter](https://openrouter.ai/keys)), genera todas las contraseñas, levanta el sistema y te da la dirección del panel. Después:

```bash
./riverrun status     # cómo está todo
./riverrun update     # actualizar (respalda primero y vuelve atrás si algo falla)
./riverrun backup     # respaldo inmediato (también corre solo cada noche)
```

## Qué hay en este repositorio

```
Riverrun/
├── chatbot-platform/     ← EL PRODUCTO: backend (Node + PostgreSQL), panel web, Docker, scripts, pruebas y documentación
│   ├── riverrun          ← comando único: install · update · status · backup · restore · semantic · logs
│   ├── src/              ← backend (motor del asistente, canales, agenda, cobro, monitoreo)
│   ├── public/           ← panel web (módulos ES nativos, sin build) y la guía del cliente
│   ├── docs/             ← procedimientos de operación (activación de pgvector, evaluaciones, rollout…)
│   └── scripts/          ← pruebas de respaldo/restauración y del flujo de actualización
├── .github/workflows/    ← CI (tipos, pruebas con PostgreSQL, shellcheck, respaldos, imágenes Docker)
└── index.html · privacy.* · terms.* · tiktok….txt · .nojekyll
                          ← sitio estático de GitHub Pages (páginas públicas y archivo de verificación de TikTok).
                            NO forman parte del chatbot. No los muevas ni renombres: sus direcciones públicas
                            pueden estar registradas en servicios externos.
```

## Cómo funciona (en 30 segundos)

```
Cliente en WhatsApp / Telegram / Instagram / Messenger / web
        │
        ▼
   Canal ──► cola por conversación ──► contexto controlado (instrucciones + información del negocio + memoria)
                                              │
                                              ▼
                              la IA PROPONE una respuesta (JSON estricto)
                                              │
                                              ▼
              el sistema VERIFICA: precios y datos reales, afirmaciones respaldadas, fotos del catálogo,
              formato, reglas del negocio  →  si algo no cuadra, corrige o responde con un mensaje seguro
                                              │
                                              ▼
                         responde · agenda · guarda datos · pasa con una persona
```

El asistente **nunca inventa precios, teléfonos, enlaces ni servicios**: lo que no está en la información del negocio, lo confirma con el equipo.
