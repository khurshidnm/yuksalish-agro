# Build from the repository root: docker build -f apps/api/Dockerfile .
# The same image runs the API and, with a different command, the one-shot migration.
FROM node:22-slim AS deps
RUN corepack enable
# Allows optional native add-ons with prebuilt binaries, such as msgpackr-extract, to skip install scripts.
ENV pnpm_config_strict_dep_builds=false
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@yap/api..."

FROM node:22-slim AS runtime
ENV NODE_ENV=production STORAGE_DIR=/data/storage
# @yap/shared ships as TypeScript source, and tsx runs it exactly as in development.
RUN npm install -g tsx@4.23.15 && mkdir -p /data/storage && chown -R node:node /data
WORKDIR /app
COPY --from=deps /app ./
COPY packages/shared packages/shared
COPY apps/api/src apps/api/src
COPY apps/api/drizzle apps/api/drizzle
USER node
WORKDIR /app/apps/api
VOLUME ["/data/storage"]
EXPOSE 4000
CMD ["tsx", "src/index.ts"]
