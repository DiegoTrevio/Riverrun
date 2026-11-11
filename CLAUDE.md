# Riverrun: cómo trabajar en este repositorio

El producto está en `chatbot-platform/`: backend Node + TypeScript + PostgreSQL, panel web en módulos ES nativos (sin build) en `public/`, Docker y el comando `./riverrun`. Responde en español.

## ECC en este repositorio

ECC (everything-claude-code) aporta skills, agentes, hooks y reglas:

- **Plugin:** `.claude/settings.json` lo declara (`ecc@ecc`), así que Claude Code ofrece instalarlo y activarlo al abrir el repo. Trae las skills y agentes con prefijo `ecc:` y los hooks (por ejemplo GateGuard, que pide los hechos antes de editar o correr comandos).
- **Reglas:** el plugin no puede instalarlas, así que están copiadas en `.claude/rules/ecc/` (`common`, `typescript`, `web`) y se cargan solas. `.claude/rules/riverrun.md` dice cómo aplicarlas aquí y gana si chocan.

## Usa las skills de ECC según el contexto

Antes de empezar cada tarea, revisa qué skill o agente de ECC (prefijo `ecc:`) aplica y úsalo. Si ninguno aplica, dilo en una línea y sigue.

**Flujo de trabajo**

| Situación | Skill o agente |
|---|---|
| Implementar algo nuevo | `ecc:orch-add-feature` |
| Arreglar un error | `ecc:orch-fix-defect` |
| Cambiar algo que ya funciona | `ecc:orch-change-feature` |
| Reorganizar código sin cambiar lo que hace | `ecc:orch-refine-code` |
| Planear algo grande antes de tocar código | `ecc:plan` o el agente `ecc:planner`; `ecc:architect` para decisiones de arquitectura |
| Escribir pruebas o trabajar con pruebas primero | `ecc:tdd-workflow` |
| `npm run typecheck` o el build fallan | `ecc:build-fix` |
| Revisar cambios antes de abrir un PR | `ecc:code-review` (o `ecc:review-pr` para un PR) |
| Cambios en TypeScript o JavaScript (backend o panel) | agente `ecc:typescript-reviewer` al terminar |
| Ver si las pruebas de un PR cubren lo que cambió | agente `ecc:pr-test-analyzer` |
| Errores que se tragan o respaldos que esconden fallas | agente `ecc:silent-failure-hunter` |
| Antes de decir que algo está terminado | `ecc:verification-loop` |

**Por área del producto**

| Situación | Skill o agente |
|---|---|
| Rutas de la API, formatos de petición y respuesta | `ecc:api-design` y `ecc:backend-patterns` |
| Manejo de errores en el backend | `ecc:error-handling` |
| Login, permisos, datos de clientes, pagos, llaves o webhooks | `ecc:security-review` y el agente `ecc:security-reviewer`; `ecc:security-scan` para una revisión completa |
| Esquema de base de datos, consultas o índices | `ecc:postgres-patterns` y el agente `ecc:database-reviewer` |
| Migraciones (`migrations/*.sql`) | `ecc:database-migrations` |
| Prompts, validador o motor de IA (`src/engine/`) | `ecc:prompt-optimizer` al cambiar prompts; `ecc:agent-architecture-audit` si algo falla sin causa clara |
| Evaluaciones del motor (`evals/`, `npm run eval`) | `ecc:eval-harness` y `ecc:ai-regression-testing` |
| Costo de las llamadas a la IA | `ecc:cost-aware-llm-pipeline` |
| Leer texto libre (cotizador escrito, datos como los escribe la gente) | `ecc:regex-vs-llm-structured-text` |
| Panel web: pantallas, formularios, accesibilidad | `ecc:frontend-patterns`, `ecc:accessibility` y el agente `ecc:a11y-architect` |
| Flujos de principio a fin del panel (Playwright) | `ecc:e2e-testing` o el agente `ecc:e2e-runner`; `ecc:browser-qa` para probar a mano en el navegador |
| Documentación de una librería o API externa | `ecc:documentation-lookup` |
| README y `docs/` después de un cambio | `ecc:update-docs` o el agente `ecc:doc-updater` |
| Docker, CI o despliegue | `ecc:docker-patterns` / `ecc:deployment-patterns` |
| Medir qué tan bien está configurado el repo para Claude | `ecc:harness-audit` |

Las skills `ecc:orch-*` tienen puntos de aprobación (plan y commit): úsalas en cambios de varios archivos. Para un ajuste de una o dos líneas basta con `ecc:tdd-workflow` y `ecc:verification-loop`.

Lo que ECC trae para otros lenguajes y marcos (Python, Go, Rust, Java, Django, React, Vue, Flutter, etc.) no aplica a Riverrun y se deja fuera a propósito.

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
