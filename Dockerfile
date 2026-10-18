# syntax=docker/dockerfile:1.7
FROM node:24.15-bookworm-slim AS dependencies
WORKDIR /workspace
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm install --global pnpm@10.30.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile

# Stable production dependency layer. Workspace packages are bundled by build:node.
# Dependency source maps, type declarations and other platforms' ONNX binaries are not deployed.
FROM dependencies AS prod-dependencies
COPY scripts/prune-deployment.mjs /prune-deployment.mjs
RUN pnpm --filter @walden/api deploy --prod --legacy /out \
 && node /prune-deployment.mjs /out/node_modules

FROM dependencies AS build
COPY . .
RUN pnpm build:self-hosted
RUN node scripts/build-container-browser-check.mjs /workspace/container-browser-smoke.mjs

# Runtime attribution covers the exact deployed package store plus the bundled web dependencies.
FROM build AS runtime-notices
COPY --from=prod-dependencies /out/node_modules/ /deployed/node_modules/
RUN node scripts/third-party-notices.mjs --filter=@walden/api --filter=@walden/web \
    --deployed=/deployed/node_modules /workspace/THIRD_PARTY_LICENSES.txt

# Immutable, checksummed model assets are independent of application changes.
FROM node:24.15-bookworm-slim AS models
COPY apps/api/scripts/download-embedding-model.mjs /download-embedding-model.mjs
RUN node /download-embedding-model.mjs /models/minilm

# Debian Chromium excludes proprietary Chrome/Widevine components. Its matching
# source package is included in the release's corresponding-source companion.
FROM node:24.15-bookworm-slim AS browser
ARG WALDEN_APT_REFRESH=development
RUN echo "Debian package refresh: $WALDEN_APT_REFRESH" \
 && apt-get update \
 && apt-get upgrade --yes \
 && apt-get install --yes --no-install-recommends tini ca-certificates chromium fonts-liberation fonts-noto-color-emoji fonts-freefont-ttf \
 && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data \
 && chown node:node /data

FROM browser AS packaged
ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=3000 APP_ROLE=all DATA_DIR=/data \
    EMBEDDING_MODEL_DIR=/app/models/minilm \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ARG WALDEN_IMAGE_VERSION=development
ARG WALDEN_IMAGE_REVISION=unknown
ARG WALDEN_SOURCE_URL=https://github.com/fulton-ring/mindful-ai
LABEL org.opencontainers.image.title="Walden" \
      org.opencontainers.image.source=$WALDEN_SOURCE_URL \
      org.opencontainers.image.version=$WALDEN_IMAGE_VERSION \
      org.opencontainers.image.revision=$WALDEN_IMAGE_REVISION
WORKDIR /app
COPY --from=prod-dependencies /out/node_modules/ /app/node_modules/
COPY --from=models /models/ /app/models/
COPY LICENSE /app/models/minilm/LICENSE
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /app/
COPY --from=build /workspace/apps/api/dist/node/ /app/dist/node/
COPY --from=build /workspace/apps/api/public/ /app/public/
COPY --from=runtime-notices /workspace/THIRD_PARTY_LICENSES.txt /app/THIRD_PARTY_LICENSES.txt
COPY --from=build /workspace/apps/api/migrations/ /app/migrations/
COPY --from=build /workspace/apps/api/postgres-migrations/ /app/postgres-migrations/
COPY apps/api/package.json /app/package.json
COPY licenses/native/ /app/licenses/native/
COPY scripts/container-notices.mjs /app/scripts/container-notices.mjs
RUN node scripts/container-notices.mjs runtime /app/notices

# Release checks and source collection must run on the exact tested runtime inventory.
FROM packaged AS tested-inventory
ARG WALDEN_DEBIAN_INVENTORY_SHA256
ARG WALDEN_NATIVE_PINS_SHA256
RUN printf '%s  %s\n' \
      "$WALDEN_DEBIAN_INVENTORY_SHA256" /app/notices/debian-packages.tsv \
      "$WALDEN_NATIVE_PINS_SHA256" /app/licenses/native/sources.json \
    | sha256sum --check --strict -

# Export sources separately; large archives never enter the runtime image.
FROM tested-inventory AS source-archives
ARG TARGETARCH
ARG WALDEN_SOURCE_ID=development
RUN set -e; \
    sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    mkdir -p /sources/native /sources/debian /out; \
    chown _apt:root /sources/debian; \
    node scripts/container-notices.mjs sources /sources/native; \
    node scripts/container-notices.mjs debian-sources /app/notices/debian-packages.tsv /sources/debian; \
    cp -r /app/notices /sources/notices; \
    cp /app/licenses/native/README.md /sources/README.md; \
    walden_archive="/walden-sources-${TARGETARCH}-${WALDEN_SOURCE_ID}.tar"; \
    mkfifo "$walden_archive"; \
    tar -C /sources -cf "$walden_archive" . & walden_tar_pid=$!; \
    node scripts/container-notices.mjs split "$walden_archive" /out; \
    wait "$walden_tar_pid"; \
    node scripts/container-notices.mjs verify /out; \
    rm -rf /sources "$walden_archive"

FROM scratch AS release-sources
COPY --from=source-archives /out/ /

# CI exercises the real research adapter with the installed browser. The test
# helper stays in this separate target, outside the published runtime image.
FROM tested-inventory AS browser-check
COPY --from=build /workspace/container-browser-smoke.mjs /app/container-browser-smoke.mjs
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/container-browser-smoke.mjs"]

FROM packaged AS runtime
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/node/server.js"]
