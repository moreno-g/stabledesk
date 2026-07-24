# Stabledesk — zero-dependency Node app (uses built-in node:sqlite).
FROM node:24-slim

WORKDIR /app
# PORT is a fallback — Railway injects its own. DB_PATH is deliberately NOT set here so that
# db.js can auto-detect RAILWAY_VOLUME_MOUNT_PATH; docker-compose sets DB_PATH explicitly.
ENV NODE_ENV=production \
    PORT=4317

# No dependencies to install — just copy the source.
COPY package.json ./
COPY *.js ./
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 4317
CMD ["node", "server.js"]
