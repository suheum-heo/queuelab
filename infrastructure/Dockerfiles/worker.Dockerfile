FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @queuelab/shared-types build \
  && pnpm --filter @queuelab/database build \
  && pnpm --filter @queuelab/worker build

CMD ["node", "apps/worker/dist/main.js"]
