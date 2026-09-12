# Backend Critical Fixes - Quick Reference (Exact Code)

## Fix #1: Prisma Binary Targets

### File: `core-backend/prisma/schema.prisma` (Lines 1-3)

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}
```

**What Changed**: Added `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`

**Why**: Alpine Linux (node:18-alpine) uses musl libc, which requires a specific Prisma binary target.

---

## Fix #2: AI Engine Service Name

### File: `core-backend/src/config/secrets.ts` (Line 46)

```typescript
export const secrets = {
  // ── Server ──
  PORT: Number(process.env.PORT) || 4000,
  NODE_ENV: process.env.NODE_ENV || "development",

  // ── CORS ──
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",

  // ── JWT ──
  JWT_SECRET:
    process.env.JWT_SECRET || "change-me-in-production-min-32-chars!!",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "24h",

  // ── Redis ──
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_URL: process.env.REDIS_URL || "",

  // ── Database ──
  DATABASE_URL: process.env.DATABASE_URL || "file:./dev.db",

  // ── Rate Limiting ──
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX) || 120,

  // ── AI Engine ──
  AI_ENGINE_API_KEY:
    process.env.AI_ENGINE_API_KEY || "INTERNAL_SECRET_AI_ENGINE",
  AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://ai-engine:8000",
  //                                           ↑
  //                                    Changed from localhost to ai-engine
```

**What Changed**: Line 46 changed from `"http://localhost:8000"` to `"http://ai-engine:8000"`

**Why**: Inside Docker, service names are resolved by Docker DNS. Using the service name `ai-engine` instead of `localhost` allows the backend to communicate with the AI engine service on the Docker network.

---

## Fix #3: Remove Redundant Fallback

### File: `core-backend/src/controllers/signal.controller.ts` (Lines 73-81)

```typescript
const buildAiEnginePredictUrl = (baseUrl: string): string => {
  const cleaned = baseUrl.replace(/\/+$/, "");
  if (cleaned.endsWith("/api/v1")) return `${cleaned}/predict`;
  if (cleaned.endsWith("/api")) return `${cleaned}/v1/predict`;
  return `${cleaned}/api/v1/predict`;
};

const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(secrets.AI_ENGINE_URL);
//                    ↑
//      Removed || "http://localhost:8000" fallback
const PREDICT_TIMEOUT_MS = 120_000;
```

**What Changed**: Removed redundant `|| "http://localhost:8000"` from line 81

**Why**: `secrets.AI_ENGINE_URL` already has a proper default value (`"http://ai-engine:8000"`), so the duplicate fallback is unnecessary.

---

## Complete Code Blocks

### 1️⃣ schema.prisma - Full Block

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}
```

### 2️⃣ secrets.ts - AI_ENGINE Configuration

```typescript
  // ── AI Engine ──
  AI_ENGINE_API_KEY:
    process.env.AI_ENGINE_API_KEY || "INTERNAL_SECRET_AI_ENGINE",
  AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://ai-engine:8000",
```

### 3️⃣ signal.controller.ts - URL Construction

```typescript
const buildAiEnginePredictUrl = (baseUrl: string): string => {
  const cleaned = baseUrl.replace(/\/+$/, "");
  if (cleaned.endsWith("/api/v1")) return `${cleaned}/predict`;
  if (cleaned.endsWith("/api")) return `${cleaned}/v1/predict`;
  return `${cleaned}/api/v1/predict`;
};

const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(secrets.AI_ENGINE_URL);
const PREDICT_TIMEOUT_MS = 120_000;
```

---

## Docker Compose Verification

### Service Names in docker-compose.yml

```yaml
services:
  ai-engine:
    build:
      context: ./ai-engine
      dockerfile: Dockerfile
    container_name: ai_brain
    ports:
      - "8000:8000"
    networks:
      - radar_network

  core-backend:
    build:
      context: ./core-backend
      dockerfile: Dockerfile
    container_name: backend_node
    environment:
      DATABASE_URL: postgresql://...@postgres:5432/...
      REDIS_HOST: redis
      PORT: 4000
      # Optional: AI_ENGINE_URL: http://ai-engine:8000
    ports:
      - "4000:4000"
    networks:
      - radar_network
```

**Key Point**: Both services are in `radar_network`. The `ai-engine` service is resolvable as `http://ai-engine:8000` from the `core-backend` container.

---

## Deployment Commands

```bash
# 1. Rebuild backend with new Prisma binary targets
cd core-backend
docker build --no-cache -t trading-backend:latest .

# 2. Stop existing containers
docker-compose down

# 3. Start all services
docker-compose up -d

# 4. Verify Prisma initialized correctly
docker logs backend_node | head -20
# Should NOT contain: "Prisma Client could not locate the Query Engine"

# 5. Verify AI Engine connection
docker logs backend_node | grep "ai.engine"
# Should NOT contain: "ECONNREFUSED" or "localhost:8000"

# 6. Test the prediction endpoint
curl -X POST http://localhost:4000/api/v1/predict \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "EURUSD",
    "candles": [],
    "live_price": 1.0850
  }'
# Response should be 200 (not 502 Bad Gateway)
```

---

## Environment Variable Override

If you need a custom AI Engine URL:

```yaml
# In docker-compose.yml
core-backend:
  environment:
    AI_ENGINE_URL: http://custom-host:8000
```

Or in your `.env` file:

```env
AI_ENGINE_URL=http://custom-host:8000
```

---

## What Each Change Does

| Change               | From                                                 | To                                       | Effect                                      |
| -------------------- | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| Prisma binaryTargets | Missing                                              | `["native", "linux-musl-openssl-3.0.x"]` | Fixes "Query Engine not found" error        |
| AI Engine hostname   | `localhost:8000`                                     | `ai-engine:8000`                         | Allows Docker DNS resolution within network |
| Fallback removal     | `secrets.AI_ENGINE_URL \|\| "http://localhost:8000"` | `secrets.AI_ENGINE_URL`                  | Cleaner code, removes redundancy            |

---

## Verification Checklist

- [ ] Updated `core-backend/prisma/schema.prisma` with binaryTargets
- [ ] Updated `core-backend/src/config/secrets.ts` AI_ENGINE_URL to `ai-engine:8000`
- [ ] Removed fallback from `core-backend/src/controllers/signal.controller.ts`
- [ ] Rebuilt backend Docker image with `--no-cache`
- [ ] Restarted docker-compose services
- [ ] Verified no Prisma engine errors in `docker logs backend_node`
- [ ] Verified no ECONNREFUSED errors in logs
- [ ] Tested prediction endpoint returns 200 (not 502)

---

## Expected Behavior After Fix

### Before Fix

```
❌ Prisma Error: "Query Engine not found"
❌ Backend logs: "connect ECONNREFUSED 127.0.0.1:8000"
❌ API response: 502 Bad Gateway
```

### After Fix

```
✅ Prisma initialized successfully
✅ Backend logs: No connection errors to AI Engine
✅ API response: 200 OK with predictions
```
