# Riverrun: cómo trabajar en este repositorio

El producto está en `chatbot-platform/`: backend Node + TypeScript + PostgreSQL, panel web en módulos ES nativos (sin build) en `public/`, Docker y el comando `./riverrun`. Responde en español.

## Usa las skills de ECC según el contexto

Antes de empezar cada tarea, revisa qué skill de ECC (prefijo `ecc:`) aplica y úsala. Si ninguna aplica, dilo en una línea y sigue.

| Situación | Skill |
|---|---|
| Implementar algo nuevo | `ecc:orch-add-feature` |
| Arreglar un error | `ecc:orch-fix-defect` |
| Cambiar algo que ya funciona | `ecc:orch-change-feature` |
| Reorganizar código sin cambiar lo que hace | `ecc:orch-refine-code` |
| Escribir pruebas o trabajar con pruebas primero | `ecc:tdd-workflow` |
| Cambios en TypeScript o JavaScript (backend o panel) | `ecc:typescript-reviewer` (agente) al terminar |
| Login, permisos, datos de clientes, pagos, llaves o webhooks | `ecc:security-review` |
| Esquema de base de datos, consultas o índices | `ecc:postgres-patterns` |
| Migraciones (`migrations/*.sql`) | `ecc:database-migrations` |
| Prompts, validador o motor de IA (`src/engine/`) | `ecc:agent-architecture-audit` si algo falla sin causa clara |
| Panel web: pantallas, formularios, accesibilidad | `ecc:frontend-patterns` y `ecc:accessibility` |
| Docker, CI o despliegue | `ecc:docker-patterns` / `ecc:deployment-patterns` |
| Revisar cambios antes de abrir un PR | `ecc:code-review` (o `ecc:review-pr` para un PR) |
| Antes de decir que algo está terminado | `ecc:verification-loop` |

Las skills `ecc:orch-*` tienen puntos de aprobación (plan y commit): úsalas en cambios de varios archivos. Para un ajuste de una o dos líneas basta con `ecc:tdd-workflow` y `ecc:verification-loop`.

## Comprobaciones antes de subir cambios

Desde `chatbot-platform/`:

- `npm run typecheck`
- `npm test`. Las pruebas con base de datos necesitan PostgreSQL en `TEST_DATABASE_URL` (por omisión `postgres://chatbot:chatbot@localhost:5432/chatbot_test`); sin él se omiten y las corre el CI.
- `npm run check:frontend` si tocaste `public/`.
- Si cambias el prompt del asistente (`src/engine/context.ts`), actualiza las fotografías con `UPDATE_PROMPT_SNAPSHOTS=1 node --import tsx --test test/prompt-snapshot.test.ts` y revisa el cambio.
- Si cambias el motor o el validador: `npm run eval` y `npm run eval:engine`.

## Reglas del proyecto

- El asistente no inventa: precios, horarios, enlaces y montos salen de la información del negocio; el validador (`src/engine/validator.ts`) lo hace cumplir. No relajes una verificación sin una prueba que muestre el caso legítimo y otra que muestre que lo inventado sigue sin pasar.
- Los textos que ve el cliente o el negocio van en español claro, sin jerga técnica.
- Cada cambio de comportamiento lleva su prueba en `test/` y, si cambia cómo se usa, su nota en el README o en `docs/`.
- Los archivos de la raíz (`index.html`, `privacy.html`, `terms.html`, `tiktok…txt`, `.nojekyll`) son del sitio de GitHub Pages: no los muevas ni renombres.
