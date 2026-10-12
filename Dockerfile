# Override with an immutable digest in your release pipeline.
ARG NODE_IMAGE=node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_COMMIT=development
ARG BUILD_VERSION=0.3.0
LABEL org.opencontainers.image.source="https://github.com/rdpr/checkpoint" org.opencontainers.image.version=$BUILD_VERSION org.opencontainers.image.revision=$SOURCE_COMMIT org.opencontainers.image.licenses="Apache-2.0"
ENV SOURCE_COMMIT=$SOURCE_COMMIT APP_RELEASE=$BUILD_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/ops/container.py /app/ops/sqlite_ops.py ./ops/
COPY --from=build /app/package.json /app/package-lock.json /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
RUN mkdir /data /backups && chown node:node /data /backups
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data BACKUP_DIR=/backups OPERATIONS_STATUS_FILE=/data/operations.json
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s CMD ["python3", "ops/container.py", "health"]
ENTRYPOINT ["python3", "ops/container.py"]
CMD ["serve"]
