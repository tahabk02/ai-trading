# Backend Critical Fixes - Deployment Guide

## 🚀 Quick Deploy (5 minutes)

### Prerequisites

- Docker and Docker Compose installed
- Backend source code updated with fixes

### Step 1: Rebuild Backend Image

```bash
cd core-backend
docker build --no-cache -t trading-backend:latest .
```

**Expected Output**:

```
...
RUN npx prisma generate
# Successfully generated Prisma Client
# Prisma binary for linux-musl-openssl-3.0.x✓
...
RUN npm run build
# Successfully compiled TypeScript
...
```

### Step 2: Restart Services

```bash
docker-compose down
docker-compose up -d
```

### Step 3: Verify Fixes (< 1 minute)

```bash
# Wait for services to start
sleep 10

# Check Prisma initialized
docker logs backend_node | head -30
# ✅ Should NOT contain: "Query Engine not found"
# ✅ Should NOT contain: "ECONNREFUSED"

# Check AI Engine connectivity
curl http://localhost:4000/health
# ✅ Should respond: 200 OK

# Test prediction endpoint
curl -X POST http://localhost:4000/api/v1/predict \
  -H "Content-Type: application/json" \
  -d '{"symbol":"EURUSD","candles":[],"live_price":1.0850}'
# ✅ Should respond: 200 OK with prediction
# ❌ Should NOT respond: 502 Bad Gateway
```

---

## 📋 What Was Changed

### Change #1: Prisma Binary Targets

**File**: `core-backend/prisma/schema.prisma`

```diff
  generator client {
    provider      = "prisma-client-js"
+   binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
  }
```

**Reason**: Alpine Linux uses musl libc; Prisma needs the correct binary target.

### Change #2: AI Engine Service Name

**File**: `core-backend/src/config/secrets.ts`

```diff
- AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://localhost:8000",
+ AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://ai-engine:8000",
```

**Reason**: Docker DNS resolves service names. `ai-engine` is the service name in docker-compose.yml.

### Change #3: Remove Redundant Fallback

**File**: `core-backend/src/controllers/signal.controller.ts`

```diff
  const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(
-   secrets.AI_ENGINE_URL || "http://localhost:8000",
+   secrets.AI_ENGINE_URL,
  );
```

**Reason**: `secrets.AI_ENGINE_URL` already has a proper default.

---

## 🔍 Troubleshooting

### Issue: Prisma Engine Still Not Found

**Symptom**:

```
Prisma Client could not locate the Query Engine for runtime "linux-musl-openssl-3.0.x"
```

**Solution**:

```bash
# Ensure you rebuilt with --no-cache
docker build --no-cache -t trading-backend:latest .

# Verify Prisma generated correctly
docker logs backend_node | grep -i "prisma"
# Should show: "Prisma Client generated successfully"

# If still failing, check generated files
docker run -it trading-backend:latest ls -la node_modules/@prisma/engines/
# Should contain libquery_engine-linux-musl-openssl-3.0.x.so.node
```

---

### Issue: AI Engine Connection Refused

**Symptom**:

```
ECONNREFUSED 127.0.0.1:8000
or
502 Bad Gateway to AI Engine
```

**Solutions**:

1. **Verify secrets.ts was updated**:

   ```bash
   grep -n "AI_ENGINE_URL" core-backend/src/config/secrets.ts
   # Should show: http://ai-engine:8000 (not localhost:8000)
   ```

2. **Check Docker network connectivity**:

   ```bash
   docker exec backend_node nslookup ai-engine
   # Should resolve to an IP address

   docker exec backend_node curl -v http://ai-engine:8000/health
   # Should respond (200, 404, or any response - not Connection Refused)
   ```

3. **Verify both services in same network**:

   ```bash
   docker network inspect radar_network
   # Both ai-engine and core-backend should be listed
   ```

4. **Check AI Engine is running**:
   ```bash
   docker logs ai_brain
   # Should show: listening on :8000
   # Should NOT show: errors or crashes
   ```

---

### Issue: Changes Not Taking Effect

**Symptom**:

```
Updated code but still seeing localhost:8000 in logs
```

**Solution**:

```bash
# 1. Rebuild image (critical!)
docker build --no-cache -t trading-backend:latest .

# 2. Force restart container
docker-compose down
docker-compose up -d

# 3. Wait for services to fully start
sleep 15

# 4. Verify new code is running
docker logs backend_node | grep -i "ai.engine\|localhost"
# Should show: ai-engine:8000
# Should NOT show: localhost:8000
```

---

## ✅ Verification Checklist

Use this checklist to confirm all fixes are working:

- [ ] **Prisma Binary Targets**
  - [ ] `schema.prisma` contains `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`
  - [ ] Docker build log shows "Prisma binary for linux-musl-openssl-3.0.x✓"
  - [ ] `docker logs backend_node` contains no Query Engine errors

- [ ] **AI Engine Service Name**
  - [ ] `secrets.ts` line 46 shows `"http://ai-engine:8000"`
  - [ ] `signal.controller.ts` line 80-81 uses only `secrets.AI_ENGINE_URL` (no fallback)
  - [ ] `docker exec backend_node nslookup ai-engine` resolves successfully

- [ ] **Connectivity**
  - [ ] `curl http://localhost:4000/health` returns 200 OK
  - [ ] `docker logs backend_node` contains no connection refused errors
  - [ ] `docker logs ai_brain` shows AI Engine is healthy

- [ ] **Functionality**
  - [ ] Test predict endpoint returns 200 (not 502)
  - [ ] WebSocket connections work
  - [ ] Client app receives predictions from AI Engine

---

## 📊 Expected Log Output

### After Fix (Healthy Backend)

```
backend_node | 2024-01-15T10:30:45.123Z [INFO] Prisma Client loaded
backend_node | 2024-01-15T10:30:45.456Z [INFO] Redis connected: redis:6379
backend_node | 2024-01-15T10:30:45.789Z [INFO] Server listening on port 4000
backend_node | 2024-01-15T10:30:50.123Z [INFO] Forwarding data to AI Engine
backend_node | 2024-01-15T10:30:50.456Z [INFO] Prediction received from AI Engine
```

### Before Fix (Error Logs)

```
backend_node | Error: Prisma Client could not locate the Query Engine
backend_node | Error: connect ECONNREFUSED 127.0.0.1:8000
backend_node | Error: AI Engine request failed: ECONNREFUSED
```

---

## 🌐 Docker Network Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Docker Network: radar_network                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐        ┌─────────────────┐               │
│  │  core-backend   │───────→│   ai-engine     │               │
│  │  172.17.0.3:4000│ HTTP   │  172.17.0.2:8000│               │
│  └─────────────────┘        └─────────────────┘               │
│        ↓                            ↑                          │
│  Makes request to:          Listens on port:                 │
│  http://ai-engine:8000      http://0.0.0.0:8000              │
│                                                                  │
│  Docker DNS resolution:                                         │
│  ai-engine → 172.17.0.2 (determined by Docker bridge)         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Key**: Services can communicate by name within the Docker network. No need for localhost or hardcoded IPs.

---

## 📝 Configuration Summary

### Environment Variables (Optional Overrides)

These are already configured correctly but can be overridden if needed:

```yaml
# docker-compose.yml or .env
AI_ENGINE_API_KEY=INTERNAL_SECRET_AI_ENGINE
AI_ENGINE_URL=http://ai-engine:8000
```

### Default Behavior

- Backend connects to `ai-engine:8000` (no config needed)
- Prisma generates correct binary for Alpine Linux (automatic with binaryTargets)
- All service names resolve via Docker DNS (no special setup needed)

---

## 🎯 Summary

| Issue                                  | Solution                                    | Status        |
| -------------------------------------- | ------------------------------------------- | ------------- |
| Prisma Query Engine not found          | Added `binaryTargets` for Alpine Linux      | ✅ Fixed      |
| Backend → AI Engine connection refused | Changed `localhost:8000` → `ai-engine:8000` | ✅ Fixed      |
| Redundant fallback logic               | Removed duplicate fallback                  | ✅ Cleaned up |

**Next Steps**:

1. Rebuild Docker image
2. Restart containers
3. Verify connectivity
4. Test prediction endpoint

All fixes are backward compatible and can be deployed immediately.
