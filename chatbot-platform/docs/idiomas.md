# Idiomas del panel: español e inglés

El panel funciona en español y en inglés (para vender en Estados Unidos).

## Cómo elige el idioma cada persona

- Si la persona ya eligió uno, se usa ese (se guarda en su navegador).
- Si no, se usa el idioma de su navegador: inglés si lo tiene antes que el español; si no tiene ninguno de los dos, español.
- Se cambia en la pantalla de entrada (Español · English, abajo), en el menú de su cuenta (arriba a la derecha) y en **Mi perfil → Idioma**.
- En inglés las fechas, horas y números usan el formato de Estados Unidos (11/16/2026, 4:30 PM, 1,234.50).

## Cómo funciona por dentro

El código del panel sigue escrito en español. En inglés, `public/js/i18n.js` cambia cada texto que aparece en la pantalla por su traducción de `public/i18n/en.json`, antes de que el navegador lo pinte. La llave es el texto en español tal cual; `{0}`, `{1}`… son las partes que cambian (un nombre, un número):

```json
{
  "Guardar": "Save",
  "{0} días": "{0} days",
  "Te invitaron como {0}.": "You were invited as {0}."
}
```

- Lo que escribe la gente (mensajes de clientes, respuestas del asistente) va dentro de `translate="no"` y nunca se traduce.
- Los errores y avisos que manda el servidor también se traducen al mostrarse, con el mismo diccionario.
- Si el diccionario no carga, el panel sigue en español (nunca queda en blanco).

## Al agregar o cambiar un texto

`npm run check:frontend` y `npm test` fallan si un texto del panel (o un mensaje del servidor que el panel muestra) no tiene su traducción:

```bash
node scripts/i18n-strings.mjs            # dice qué falta
node scripts/i18n-strings.mjs --missing  # la lista completa en JSON, con dónde aparece cada texto
```

Agrega la traducción en `public/i18n/en.json` con las mismas partes `{0}`. Si un texto no se ve en la pantalla (un nombre interno, un selector), va en `scripts/i18n-ignore.json`.

`npm run test:english:ux` abre cada pantalla de cada rol en inglés en un navegador real y falla si quedó texto del panel en español, si algo no cabe en un teléfono o si hay fallas graves de accesibilidad.

## Lo que todavía está solo en español

- Lo que el asistente le contesta al cliente, los correos, las cotizaciones y los PDF (siguiente fase: idioma de cada negocio).
- La ayuda (`ayuda.html`), la página para reservar, el chat web y los avisos legales (fase de páginas públicas, con Privacy Policy y Terms para Estados Unidos).
