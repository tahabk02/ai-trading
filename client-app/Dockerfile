FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
# `npm ci` (not `npm install`) so the image is reproducible from the lockfile.
RUN npm ci

COPY . .
# NOTE: no proxy env is passed here ON PURPOSE. `API_PROXY_URL` / `AI_PROXY_URL`
# are read at REQUEST time by server.js, not at build time by next.config.js —
# so the image is environment-agnostic and one build serves every target.
RUN npm run build

FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Drop root privileges — the image contains no build tooling to abuse.
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nextjs
RUN chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000

# Readiness must not depend on the proxied upstreams: /api/healthz is answered
# by the Next server itself, so a slow core-backend cannot mark the frontend
# unhealthy and trigger a restart loop.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# server.js, NOT `next start`: the runtime proxy (and the WebSocket upgrade
# tunnel) only exists in the custom server.
CMD ["node", "server.js"]

