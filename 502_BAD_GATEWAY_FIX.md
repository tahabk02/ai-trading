# 502 Bad Gateway Fix - Complete Solution

## ✅ Issues Fixed (2 Critical Bugs)

### Issue #1: Hardcoded AI Engine IP Address (172.18.0.4:8000)

- **Problem**: Core backend trying to connect to hardcoded Docker container IP instead of service name
- **Error**: `connect ECONNREFUSED 172.18.0.4:8000`
- **Root Cause**: Old docker-compose assigned static IPs, now using dynamic Docker DNS

### Issue #2: Frankfurter API Returning 301 Moved Permanently

- **Problem**: AI Engine using deprecated `api.frankfurter.app` endpoint
- **Error**: `301 Moved Permanently` redirect, causing connection failures
- **Root Cause**: Frankfurter API migration to new domain `api.frankfurter.dev/v1`

---

## ✅ Files Fixed (4 Total)

### Fix #1: `ai-engine/app/data/collector.py` (2 changes)

**Change 1** - Update comment (Line 15):

```diff
- #   2. Daily candles:     https://api.frankfurter.app/  (ECB reference rates)
+ #   2. Daily candles:     https://api.frankfurter.dev/v1/  (ECB reference rates)
```

**Change 2** - Update API endpoint (Line 61):

```diff
- FRANKFURTER_API = "https://api.frankfurter.app"
+ FRANKFURTER_API = "https://api.frankfurter.dev/v1"
```

**Why**: The new API endpoint includes `/v1` in the base URL. The URL patterns remain the same:

- `/latest?from={base}&to={quote}` for live rates
- `/{start_iso}..?from={base}&to={quote}` for historical candles

---

### Fix #2: `core-backend/.env` (1 addition)

**Added** (after Alpaca configuration):

```bash
# ── AI Engine URL (Docker service name for inter-container communication) ──
AI_ENGINE_URL="http://ai-engine:8000"
```

**Why**:

- Uses Docker service name `ai-engine` instead of hardcoded IP
- Docker DNS automatically resolves `ai-engine` to the container's internal IP
- Survives container restarts without requiring IP reconfiguration

---

### Fix #3: `core-backend/.env.example` (1 update)

**Changed**:

```diff
  # ── AI Engine & WebSockets ────────────────────────────────────────────────
- AI_ENGINE_URL="http://localhost:8000"
+ # Use Docker service name (ai-engine) for inter-container communication
+ # For local development without Docker, use http://localhost:8000
+ AI_ENGINE_URL="http://ai-engine:8000"
  AI_ENGINE_API_KEY="INTERNAL_SECRET_AI_ENGINE"
  WS_PATH="/ws"
```

**Why**: Documents the correct production Docker configuration vs local development

---

### Fix #4: `core-backend/src/config/secrets.ts` (Already Correct ✓)

This file already has the correct default:

```typescript
AI_ENGINE_URL: process.env.AI_ENGINE_URL || "http://ai-engine:8000",
```

✅ **No changes needed** - was already fixed in previous updates

---

## 🚀 Deployment Steps

### Step 1: Rebuild Both Containers

```bash
# Rebuild AI Engine (Frankfurter API fix)
docker build -t trading-ai-engine:latest ./ai-engine --no-cache

# Rebuild Core Backend (AI Engine URL fix)
docker build -t trading-backend:latest ./core-backend --no-cache
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

# Test 1: Check Backend Health
curl http://localhost:4000/health
# Expected: 200 OK

# Test 2: Check AI Engine Health
curl http://localhost:8000/health
# Expected: Response (200 or error, not connection refused)

# Test 3: Check Backend Can Reach AI Engine
docker logs backend_node | grep -i "econnrefused\|172.18"
# Expected: NOTHING (no connection refused errors)

# Test 4: Make a Prediction Request
curl -X POST http://localhost:4000/api/v1/predict \
  -H "Content-Type: application/json" \
  -d '{"symbol":"EURUSD","candles":[],"live_price":1.0850}'
# Expected: 200 OK with prediction data
# NOT: 502 Bad Gateway
```

---

## 🔄 How the Connection Works Now

### Before (Broken ❌)

```
Client
  ↓
Core Backend (localhost:4000)
  ↓
Tries to reach: http://172.18.0.4:8000  (hardcoded old IP)
  ↓
Docker container at that IP no longer exists
  ↓
ECONNREFUSED error
  ↓
502 Bad Gateway response
```

### After (Working ✅)

```
Client
  ↓
Core Backend (localhost:4000)
  ↓
AI_ENGINE_URL from .env: http://ai-engine:8000
  ↓
Docker DNS resolves "ai-engine" → current container IP
  ↓
Successfully connects to AI Engine
  ↓
200 OK response with predictions
```

---

## 🌐 Docker Network Resolution

```
┌─────────────────────────────────────────────┐
│   Docker Network: radar_network             │
├─────────────────────────────────────────────┤
│                                             │
│  core-backend container                     │
│    ↓                                        │
│  Reads env: AI_ENGINE_URL=http://ai-engine:8000
│    ↓                                        │
│  Makes HTTP request to: ai-engine:8000     │
│    ↓                                        │
│  Docker DNS Server (127.0.0.11:53)         │
│    ↓                                        │
│  Resolves: ai-engine → 172.17.0.2          │
│    ↓                                        │
│  Connected to ai-engine container!         │
│    ↓                                        │
│  ✅ Prediction returned                     │
│                                             │
└─────────────────────────────────────────────┘
```

---

## 🔍 API Endpoint Changes

### Frankfurter API Update

The new `api.frankfurter.dev/v1` endpoint:

**Live Spot Rates**:

```
OLD: https://api.frankfurter.app/latest?from=EUR&to=USD
NEW: https://api.frankfurter.dev/v1/latest?from=EUR&to=USD
```

**Historical Candles**:

```
OLD: https://api.frankfurter.app/2024-01-01..?from=EUR&to=USD
NEW: https://api.frankfurter.dev/v1/2024-01-01..?from=EUR&to=USD
```

✅ URL patterns are identical, just domain and `/v1/` added

---

## 📋 Verification Checklist

Run these after deployment:

- [ ] `curl http://localhost:4000/health` returns 200 OK
- [ ] `docker logs backend_node` contains NO "ECONNREFUSED" or "172.18"
- [ ] `docker logs ai_brain` shows NO errors
- [ ] `curl http://localhost:8000/health` responds
- [ ] Prediction endpoint returns 200 (not 502)
- [ ] Check that AI Engine logs show successful Frankfurter API calls

---

## 🆘 Troubleshooting

### Still Getting 502 Bad Gateway?

**Check 1**: Verify containers are running

```bash
docker ps | grep -E "backend|ai-engine"
# Should show both containers running
```

**Check 2**: Verify .env was updated

```bash
grep "AI_ENGINE_URL" core-backend/.env
# Should show: AI_ENGINE_URL="http://ai-engine:8000"
```

**Check 3**: Verify new Docker image built

```bash
docker image inspect trading-backend:latest | grep -i "TIMESTAMP\|Created"
# Should be recent (after your changes)
```

**Check 4**: Check for IP-based connections in logs

```bash
docker logs backend_node | grep -i "172.18\|econnrefused"
# Should return NOTHING
```

---

### Frankfurter API Still 301 Error?

**Check 1**: Verify AI Engine rebuilt

```bash
docker image inspect trading-ai-engine:latest | grep "Created"
# Should be recent
```

**Check 2**: Check AI Engine uses new endpoint

```bash
docker exec ai_brain grep -r "frankfurter" app/
# Should show: https://api.frankfurter.dev/v1
```

**Check 3**: Test API directly

```bash
curl -v https://api.frankfurter.dev/v1/latest?from=EUR&to=USD
# Should return 200 OK with rates JSON
```

---

## 📊 Summary of Changes

| Component      | File                   | Change                | Impact               |
| -------------- | ---------------------- | --------------------- | -------------------- |
| AI Engine API  | `collector.py` line 61 | `app` → `dev/v1`      | Fixes 301 redirect   |
| Backend Config | `.env`                 | Added `AI_ENGINE_URL` | Uses Docker DNS      |
| Backend Config | `.env.example`         | Updated URL           | Better documentation |
| Backend Config | `secrets.ts`           | Already correct       | No rebuild needed    |

---

## ✨ Expected Result After Fix

✅ **Backend**: Successfully starts and connects to AI Engine  
✅ **AI Engine**: Successfully fetches from Frankfurter API  
✅ **API Responses**: Return 200 OK with ML predictions  
✅ **Logs**: Clean operation, zero connection errors

---

## 🎯 Key Concepts

### Why Service Names Work

Docker Compose creates an internal DNS server that automatically resolves service names to container IPs. This survives container restarts without requiring manual IP updates.

### Why Hardcoded IPs Fail

Docker assigns IPs dynamically. If a container restarts, it gets a new IP. Hardcoded IPs in source code become stale and cause ECONNREFUSED errors.

### Why API Migrations Matter

Old endpoints may return 301 redirects or be shutdown. Always check for API deprecation notices and migrate to new endpoints promptly.

---

## 🚀 Ready to Deploy!

All fixes have been applied and documented. Simply follow the deployment steps above and your 502 errors should be resolved.

**Estimated fix time**: < 15 minutes (includes rebuild + verification)
