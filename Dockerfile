# SENTRIX API — production image
# Node 20 slim (matches "engines": { "node": ">=20" } in package.json)
FROM node:20-slim

# Fly best-practice: non-root user for the runtime
RUN groupadd --gid 1001 sentrix && useradd --uid 1001 --gid sentrix --shell /bin/bash --create-home sentrix

WORKDIR /app

# Cache-friendly install: copy manifests first
COPY --chown=sentrix:sentrix package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source
COPY --chown=sentrix:sentrix . .

USER sentrix

# The port fly.toml routes into
EXPOSE 4800

# start:prod runs `db/migrate.js && db/seed.js && server.js`
# — idempotent schema, no-op seed if data exists
CMD ["npm", "run", "start:prod"]
