FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/events/package.json packages/events/
RUN npm ci --omit=dev --workspace @hrms/worker --include-workspace-root

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/events ./packages/events
# The worker imports infrastructure from the API workspace (pool, outbox, storage).
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

USER node
CMD ["node", "--experimental-strip-types", "apps/worker/src/main.ts"]
