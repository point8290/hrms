FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/events/package.json packages/events/
RUN npm ci --workspace @hrms/web --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN npm run build --workspace @hrms/web

# Static assets only. In AWS these go to S3 behind CloudFront; this image exists so the
# same artifact can be served anywhere.
FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
