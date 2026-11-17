FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.22.3-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /app/.data /work && chown node:node /app/.data /work
USER node
ENV HOST=0.0.0.0 ACPAO_ROOT=/work
EXPOSE 4310
CMD ["node", "dist/apps/server/src/main.js"]
