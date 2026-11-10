FROM node:22-alpine

RUN apk add --no-cache openssl \
  && corepack enable \
  && corepack prepare pnpm@10.15.0 --activate

WORKDIR /app
COPY . .
# prisma generate reads this at build time. Compose replaces it when the container starts.
ARG DATABASE_URL=postgresql://queuelab:queuelab@localhost:5432/queuelab
ENV DATABASE_URL=$DATABASE_URL
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @queuelab/shared-types build \
  && pnpm --filter @queuelab/storage build \
  && pnpm --filter @queuelab/database build \
  && pnpm --filter @queuelab/api build

ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
