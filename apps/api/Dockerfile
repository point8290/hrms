# Node runs the TypeScript directly via type stripping, so there is no build step and no
# compiled output to drift from the source.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/events/package.json packages/events/
RUN npm ci --omit=dev --workspace @hrms/api --include-workspace-root

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/events ./packages/events
COPY apps/api ./apps/api
COPY db ./db

# Never run as root.
USER node
EXPOSE 4000

# The API refuses to start if its database connection can bypass RLS, so a misconfigured
# DATABASE_URL fails the deploy instead of silently serving cross-tenant data.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
