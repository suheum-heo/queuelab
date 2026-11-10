FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @queuelab/shared-types build && pnpm --filter @queuelab/web build

FROM nginx:1.27-alpine
COPY infrastructure/Dockerfiles/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
