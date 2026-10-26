FROM node:26.12.1-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26.12.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY apps ./apps
COPY libs ./libs
COPY scripts ./scripts
USER node

FROM runtime AS docker-controller
CMD ["node", "apps/docker-controller/main.mjs"]

FROM runtime AS discord-api
CMD ["node", "apps/discord-api/main.mjs"]

FROM runtime AS backup-worker
CMD ["node", "apps/backup-worker/main.mjs"]
