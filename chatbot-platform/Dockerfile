FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production UPLOADS_DIR=/data/uploads APP_VERSION=$APP_VERSION
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
# Lista de contraseñas comunes (src/identity/passwords.ts la busca junto a dist/).
COPY assets ./assets
# Las cotizaciones se llenan en Word y se convierten a PDF con LibreOffice. Liberation tiene las mismas medidas que
# Arial y Times New Roman, para que el PDF se vea como el formato del negocio.
RUN apk add --no-cache libreoffice-writer font-liberation font-dejavu font-noto fontconfig \
  && mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3000
# Sano = responde y llega a la base de datos (/health/db); los primeros 60 s (migraciones) no cuentan como falla.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/db" || exit 1
CMD ["node", "dist/index.js"]
