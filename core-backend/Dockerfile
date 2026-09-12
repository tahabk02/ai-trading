# =============================================================================
#  STAGE 1 — Builder
#  Base: node:18-alpine  (small, secure, glibc-free)
# =============================================================================
FROM node:18-alpine AS builder

# Install build-time system deps needed by prisma and bcrypt
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    openssl-dev \
    ca-certificates

WORKDIR /build

# 1. Copy dependency manifests first (leverage Docker layer caching)
COPY package*.json ./
COPY prisma/ ./prisma/

# 2. Install ALL dependencies (including devDependencies) for the build
RUN npm ci --include=dev --ignore-scripts=false 2>&1

# 3. Generate Prisma client from the schema
RUN npx prisma generate

# 4. Copy the rest of the source code
COPY . .

# 5. Compile TypeScript to JavaScript
RUN npm run build

# =============================================================================
#  STAGE 2 — Production Runner
#  Base: node:18-alpine  (clean, minimal runtime)
# =============================================================================
FROM node:18-alpine AS runner

# Security: install ONLY what prisma needs at runtime (openssl)
RUN apk add --no-cache \
    openssl \
    ca-certificates \
    tzdata \
  && rm -rf /var/cache/apk/*

# Security: create a non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy the built artefacts and production dependencies from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/prisma ./prisma
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package*.json ./

# Make sure the prisma schema is present for potential runtime migrations
COPY --from=builder /build/prisma/schema.prisma ./prisma/schema.prisma

# Security: drop root privileges
RUN chown -R appuser:appgroup /app
USER appuser

# Security: deny all other processes from reading /app
RUN chmod -R 750 /app

# Document the port the app listens on (must match config/secrets.ts → PORT)
EXPOSE 4000

# Health check (requires the /health endpoint to respond 200)
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Run as a non-privileged user; init wrapper handles signals properly
CMD ["node", "dist/index.js"]

# =============================================================================
#  LABELS — Metadata for container registries & observability
# =============================================================================
LABEL org.opencontainers.image.title="Trading AI Platform — Core Backend"
LABEL org.opencontainers.image.description="Express/TypeScript API server with Prisma, Socket.IO, and Redis"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.source="https://github.com/your-org/trading-ai-platform"
LABEL org.opencontainers.image.vendor="Your Company"
