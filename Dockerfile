ARG NODE_IMAGE=node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

FROM ${NODE_IMAGE} AS base
ARG APP_HOME=/app
WORKDIR ${APP_HOME}

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build ${APP_HOME}/dist ./dist
COPY --from=build ${APP_HOME}/src/shared/infrastructure/database/migrations ./dist/src/shared/infrastructure/database/migrations
USER node
CMD ["node", "dist/src/main.js"]
