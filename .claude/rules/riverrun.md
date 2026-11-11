# Riverrun: cómo aplicar las reglas de ECC aquí

Las reglas de `.claude/rules/ecc/` son las de ECC tal cual (ver `ecc/SOURCE.md`). Este archivo dice cómo se aplican en Riverrun. Si una regla de ECC choca con `CLAUDE.md` o con este archivo, ganan `CLAUDE.md` y este archivo.

## Idioma y textos

- Responde en español. Los textos que ve el cliente o el negocio van en español claro, sin jerga técnica.
- Los mensajes de commit y los PR van en español y describen el cambio en palabras del producto (así está la historia del repo). Los prefijos `feat:`/`fix:` de ECC son opcionales.
- Conserva la línea `Co-Authored-By` que pida la sesión; la nota de ECC sobre quitarla no aplica aquí.

## Pruebas

- Las pruebas usan `node:test` (`npm test`), no Jest ni Vitest. Los ejemplos con `expect(...)` de ECC se traducen a `assert` de `node:assert/strict`.
- Las pruebas de principio a fin del panel ya usan Playwright y axe-core en `scripts/test-*-ux.mts` (`npm run test:*:ux`). Agrega ahí los flujos nuevos en lugar de crear otro marco.
- La meta de 80 % de cobertura es una guía, no un bloqueo: lo obligatorio es que cada cambio de comportamiento traiga su prueba en `test/`.
- El motor y el validador además se miden con `npm run eval` y `npm run eval:engine`.

## Código

- Backend: Fastify 5 + `pg` + Zod 4. Valida la entrada con Zod, como ya hace el código.
- No cambies el formato de respuesta de la API existente para ajustarla al "sobre" `success/data/error` de ECC: sigue el formato de la ruta vecina.
- `console.log` solo en los comandos de `src/cli/` y en el arranque; en el resto usa el registro (`src/logs.ts`, el log de Fastify).
- El panel en `public/` son módulos ES nativos sin build ni React: las reglas de ECC sobre React, TSX, Tailwind, `pnpm build`, Prettier, ESLint o Stylelint no aplican. La comprobación es `npm run check:frontend`.
- Los archivos HTML de la raíz (`index.html`, `privacy.html`, `terms.html`) son del sitio de GitHub Pages: no los muevas ni renombres aunque las reglas de web sugieran otra organización.
- No busques "proyectos esqueleto" para clonar ni agregues dependencias para algo que el código ya resuelve; primero mira cómo lo hace el repo.
- Archivos grandes que ya existen: la meta de 800 líneas aplica a lo nuevo; no partas un archivo existente solo por su tamaño dentro de otro cambio.

## Lo que el asistente nunca relaja

- El asistente no inventa precios, horarios, enlaces ni montos; `src/engine/validator.ts` lo hace cumplir. Ninguna regla de ECC justifica relajar una verificación sin una prueba del caso legítimo y otra que muestre que lo inventado sigue sin pasar.
