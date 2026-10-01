# syntax=docker/dockerfile:1
#
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t webhooks-web .
#
# NEXT_PUBLIC_* values are inlined into the client bundle and the prerendered
# pages at build time, so they are build arguments, not runtime env. Secrets
# are not: pass them to the container at runtime.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS builder
WORKDIR /app

# Fetch dependencies from the lockfile alone, so this layer survives source
# changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline

ARG NEXT_PUBLIC_APP_URL=https://webhooks.cc
ARG NEXT_PUBLIC_WEBHOOK_URL=https://go.webhooks.cc
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
ARG NEXT_PUBLIC_UI_STYLE_SPLIT=
ARG NEXT_PUBLIC_MAINTENANCE_BANNER_ENABLED=
ARG NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT=
ARG NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=
ARG NEXT_PUBLIC_BING_SITE_VERIFICATION=

# ARGs reach RUN as environment variables. An empty one is unset rather than
# passed as "", which lib/env.ts would reject as an invalid URL.
# The build script also copies public/ and .next/static into the standalone
# output.
RUN for v in $(env | sed -n 's/^\(NEXT_PUBLIC_[A-Z_]*\)=$/\1/p'); do unset "$v"; done; \
    pnpm --filter web build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
# lib/docs.ts reads the MDX sources at runtime from ../../content/docs,
# relative to the server's working directory (apps/web).
COPY --from=builder --chown=node:node /app/content ./content

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
