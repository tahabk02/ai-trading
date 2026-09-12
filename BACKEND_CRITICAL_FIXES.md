# Backend Critical Fixes - Dockerized Microservices

## Summary

Two critical bugs have been fixed in the backend microservices:

1. ✅ **Prisma Client Engine Error** - Added binary targets for Alpine Linux
2. ✅ **AI Engine Connection Refused** - Changed from localhost to Docker service name

---

## Fix #1: Prisma Client Engine Error

### Problem

```
Prisma Client could not locate the Query Engine for runtime "linux-musl-openssl-3.0.x"
```

### Root Cause

The `core-backend/prisma/schema.prisma` generator block was missing the required binary target specification for Alpine Linux (linux-musl-openssl-3.0.x).

### Solution Applied

**File: `core-backend/prisma/schema.prisma`**

**Before:**

```prisma
generator client {
  provider = "prisma-client-js"
}
```

**After:**

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}
```

### Why This Works

- `"native"` - Builds for your local machine during development
- `"linux-musl-openssl-3.0.x"` - Tells Prisma to generate the Query Engine binary compatible with Alpine Linux (node:18-alpine base image uses musl libc, not glibc)
- The Dockerfile already calls `RUN npx prisma generate` during the build stage, so the correct binary is generated

### Docker Build Process

```
1. COPY prisma/ ./prisma/
2. npm ci --include=dev
3. npx prisma generate  ← Now generates correct binary with new binaryTargets
4. COPY . .
5. npm run build
```

---

## Fix #2: AI Engine Connection Refused (502 Bad Gateway)

### Problem

```
connect ECONNREFUSED ::1:8000
or
localhost:8000
```

The backend was trying to connect to `localhost:8000` when running inside Docker, but:

- Inside a Docker container, `localhost` = the container itself (not other services)
- Docker service-to-service communication requires the service name or network hostname

### Root Cause

Hardcoded fallback values pointing to `localhost:8000`:

1. `core-backend/src/config/secrets.ts` line 46
2. `core-backend/src/controllers/signal.controller.ts` line 81

### Solution Applied

#### **File 1: `core-backend/src/config/secrets.ts` (Line 46)**

**Before:**

```typescript
AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://localhost:8000",
```

**After:**

```typescript
AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://ai-engine:8000",
```

**Why `ai-engine`?**

- Service name in docker-compose.yml is `ai-engine`
- Docker DNS automatically resolves service names within the same network
- Both `ai-engine` (core-backend) and `ai_brain` (ai-engine container) are in `radar_network`

---

#### **File 2: `core-backend/src/controllers/signal.controller.ts` (Line 81)**

**Before:**

```typescript
const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(
  secrets.AI_ENGINE_URL || "http://localhost:8000",
);
```

**After:**

```typescript
const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(secrets.AI_ENGINE_URL);
```

**Why Remove the Fallback?**

- `secrets.AI_ENGINE_URL` already has a default: `"http://ai-engine:8000"`
- No need for redundant fallback to localhost
- Module-level constant is created once at startup with the correct URL

---

## How the Fix Works in Docker

### Network Architecture

```
┌─────────────────────────────────────────────────────┐
│          Docker Network: radar_network              │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────┐         ┌──────────────┐       │
│  │ core-backend │────────→│   ai-engine  │       │
│  │   :4000      │         │    :8000     │       │
│  └──────────────┘         └──────────────┘       │
│       ↓                                           │
│  Makes request to:                              │
│  http://ai-engine:8000/api/v1/predict           │
│       ↓                                           │
│  Docker DNS resolves:                           │
│  ai-engine → 172.17.0.X (ai-engine container IP)│
│       ↓                                           │
│  ✅ Connection succeeds!                         │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Request Flow

1. **Core Backend** receives `/api/v1/predict` request
2. Loads `AI_ENGINE_URL` from `secrets.ts` → `"http://ai-engine:8000"`
3. Builds full URL: `"http://ai-engine:8000/api/v1/predict"`
4. Makes HTTP POST to AI Engine
5. **AI Engine** responds with prediction

---

## Environment Variable Override

If you need to override the defaults (e.g., for a different hostname or port):

### In docker-compose.yml

```yaml
core-backend:
  environment:
    AI_ENGINE_URL: http://custom-ai-host:8000
```

### Or via `.env` file

```env
AI_ENGINE_URL=http://custom-ai-host:8000
```

**Priority Order:**

1. `process.env.AI_ENGINE_URL` (highest priority)
2. `"http://ai-engine:8000"` (default fallback)

---

## Verification Checklist

### ✅ Local Development (docker-compose up)

```bash
# 1. Check core-backend logs for Prisma errors
docker logs backend_node
# Should NOT see: "Prisma Client could not locate the Query Engine"

# 2. Check for connection errors to AI Engine
docker logs backend_node | grep -i "econnrefused\|localhost:8000"
# Should NOT see any connection refused errors

# 3. Test prediction endpoint
curl -X POST http://localhost:4000/api/v1/predict \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "EURUSD",
    "candles": [...],
    "live_price": 1.0850
  }'
# Should get a 200 response with prediction, NOT a 502 error
```

### ✅ Docker Network Verification

```bash
# Enter core-backend container
docker exec -it backend_node sh

# Test DNS resolution
nslookup ai-engine
# Should resolve to an IP address

# Test connectivity
curl -v http://ai-engine:8000/health
# Should get a response (200 or 404, not connection refused)
```

### ✅ Logs to Check

```bash
# Backend should show successful AI Engine requests
docker logs backend_node | grep -i "ai engine"
# Expected: No ECONNREFUSED, no "localhost:8000"

# Should see requests being forwarded
docker logs backend_node | grep -i "forwarding.*ai engine"
```

---

## Files Modified

| File                                                | Change                                                         | Reason                                    |
| --------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `core-backend/prisma/schema.prisma`                 | Added `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` | Alpine Linux requires musl binary target  |
| `core-backend/src/config/secrets.ts`                | Changed default from `localhost:8000` to `ai-engine:8000`      | Docker service name instead of localhost  |
| `core-backend/src/controllers/signal.controller.ts` | Removed redundant `\|\| "http://localhost:8000"`               | Clean up; already in secrets              |
| `core-backend/Dockerfile`                           | No changes                                                     | Already calls `npx prisma generate` ✓     |
| `docker-compose.yml`                                | No changes                                                     | Network and services already configured ✓ |

---

## Deployment Steps

### 1. Build New Backend Image

```bash
cd core-backend
docker build --no-cache -t trading-backend:latest .
```

### 2. Stop Old Containers

```bash
docker-compose down
```

### 3. Start New Containers

```bash
docker-compose up -d
```

### 4. Verify

```bash
# Check Prisma generated correctly
docker logs backend_node | head -20
# Should NOT show Prisma engine errors

# Check AI Engine connection works
sleep 5
curl http://localhost:4000/health
# Should respond 200 OK
```

---

## Troubleshooting

### Error: "Prisma Client could not locate the Query Engine"

**Solution**: Rebuild with `docker build --no-cache`. The new binary targets will be generated.

### Error: "connect ECONNREFUSED 127.0.0.1:8000"

**Cause**: AI Engine URL is still localhost  
**Solution**: Verify secrets.ts was updated to use `ai-engine:8000`

### Error: "Cannot resolve hostname ai-engine"

**Cause**: Services not in same Docker network  
**Solution**: Verify docker-compose.yml has both services in `radar_network`

### AI Engine timeout (no response)

**Cause**: AI Engine service not running  
**Solution**: `docker logs ai_brain` - check if AI Engine started successfully

---

## Summary of Changes

✅ **Prisma**: Now generates correct binary for Alpine Linux  
✅ **Backend**: Connects to `ai-engine:8000` via Docker DNS  
✅ **Dockerfile**: Already calls `prisma generate` at build time  
✅ **Docker Compose**: Services on same network for service-to-service communication

**Result**: 502 Bad Gateway errors should now be eliminated. Backend can successfully forward requests to AI Engine.
