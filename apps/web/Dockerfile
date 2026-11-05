# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
# Allows optional native add-ons with prebuilt binaries, such as msgpackr-extract, to skip install scripts.
ENV pnpm_config_strict_dep_builds=false
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@yap/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
# Public details of the website, fixed into the prerendered pages.
ARG VITE_SITE_URL=
ARG VITE_CONTACT_PHONE=
ARG VITE_CONTACT_TELEGRAM=
RUN pnpm --filter @yap/web build
COPY infra/nginx-security-headers.inc infra/csp-hashes.mjs ./
RUN node csp-hashes.mjs nginx-security-headers.inc apps/web/dist/index.html apps/web/dist/landing/*.html

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/nginx-security-headers.inc /etc/nginx/snippets/security-headers.inc
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
