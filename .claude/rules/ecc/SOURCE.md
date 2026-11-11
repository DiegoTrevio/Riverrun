# Origen de estas reglas

Copiadas sin cambios de ECC (everything-claude-code), versión 2.2.3: <https://github.com/affaan-m/ECC/tree/main/rules>.

- `common/`: principios generales (siempre se cargan).
- `typescript/`: se cargan al trabajar con archivos `.ts`/`.js` (backend y panel).
- `web/`: se cargan al trabajar con HTML y CSS del panel.

El plugin de ECC instala skills, agentes y hooks, pero no puede instalar reglas; por eso viven aquí. Las adaptaciones a Riverrun están en `../riverrun.md` y ganan sobre estas.

Para actualizarlas, copia de nuevo los directorios completos (no archivo por archivo) desde la versión nueva de ECC y cambia la versión de arriba:

```bash
cp -R /ruta/a/ECC/rules/common /ruta/a/ECC/rules/typescript /ruta/a/ECC/rules/web .claude/rules/ecc/
```

No se copiaron los paquetes de otros lenguajes y marcos (Python, Go, React, Vue, etc.) porque Riverrun no los usa.
