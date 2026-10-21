# Plantillas legales (borradores)

**Estos textos son borradores de partida, no asesoría legal.** Hazlos revisar por un abogado de tu país antes de publicarlos. Reemplaza todo lo que está entre `[CORCHETES]`.

Una vez publicados (en tu sitio, o como páginas de GitHub Pages), pon sus direcciones en `.env`:

```dotenv
TERMS_URL=https://tusitio.com/terminos
PRIVACY_URL=https://tusitio.com/privacidad
TERMS_VERSION=2026-10
```

y el registro de nuevos clientes las enlazará en la casilla de aceptación. Cada aceptación queda guardada (tabla `terms_acceptances`): quién, qué versión (`TERMS_VERSION`, o la dirección de los términos si no la defines), las direcciones vigentes, la IP, el navegador y la fecha. También al registrarse con Google: la cuenta se crea hasta que acepta. Cuando publiques unos términos nuevos, cambia `TERMS_VERSION`. Los archivos `index.html`, `privacy.*` y `terms.*` que hay en la raíz del repositorio pertenecen a otro propósito (sitio estático de GitHub Pages) y **no describen este producto**: no los reutilices tal cual.

- [Términos del servicio](terminos-plantilla.md)
- [Aviso de privacidad](privacidad-plantilla.md)
