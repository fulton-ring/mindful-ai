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
FROM dependencies AS prod-dependencies
RUN pnpm --filter @walden/api deploy --prod --legacy /out

FROM dependencies AS build
COPY . .
RUN pnpm build:self-hosted

# Immutable, checksummed model assets are independent of application changes.
FROM node:24.15-bookworm-slim AS models
COPY apps/api/scripts/download-embedding-model.mjs /download-embedding-model.mjs
RUN node /download-embedding-model.mjs /models/minilm

# This exact Playwright version must match apps/api/package.json.
FROM node:24.15-bookworm-slim AS browser
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini ca-certificates \
 && npm exec --yes --package=playwright@1.64.1 -- playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm \
 && mkdir -p /data \
 && chown node:node /data \
 && chmod -R a+rX /opt/playwright

FROM browser AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=3000 APP_ROLE=all DATA_DIR=/data \
    EMBEDDING_MODEL_DIR=/app/models/minilm
WORKDIR /app
COPY --from=prod-dependencies /out/node_modules/ /app/node_modules/
COPY --from=models /models/ /app/models/
COPY LICENSE /app/models/minilm/LICENSE
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /app/
COPY --from=build /workspace/apps/api/dist/node/ /app/dist/node/
COPY --from=build /workspace/apps/api/public/ /app/public/
COPY --from=build /workspace/apps/api/public/THIRD_PARTY_LICENSES.txt /app/THIRD_PARTY_LICENSES.txt
COPY --from=build /workspace/apps/api/migrations/ /app/migrations/
COPY --from=build /workspace/apps/api/postgres-migrations/ /app/postgres-migrations/
COPY apps/api/package.json /app/package.json
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/node/server.js"]
