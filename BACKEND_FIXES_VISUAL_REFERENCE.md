# Backend Critical Fixes - Visual Reference Card

## 🎯 THE FIXES AT A GLANCE

```
┌─────────────────────────────────────────────────────────────────┐
│ BUG #1: Prisma Query Engine Not Found                          │
├─────────────────────────────────────────────────────────────────┤
│ ❌ BEFORE                                                         │
│    generator client {                                            │
│      provider = "prisma-client-js"                             │
│    }                                                             │
│                                                                 │
│ ✅ AFTER                                                          │
│    generator client {                                            │
│      provider      = "prisma-client-js"                        │
│      binaryTargets = ["native", "linux-musl-openssl-3.0.x"]  │
│    }                                                             │
│                                                                 │
│ 📍 FILE: core-backend/prisma/schema.prisma                    │
│ 🎯 ADDED: binaryTargets line                                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ BUG #2: AI Engine Connection Refused (502 Gateway)             │
├─────────────────────────────────────────────────────────────────┤
│ ❌ BEFORE                                                         │
│    AI_ENGINE_URL: process.env.AI_ENGINE_URL ||                 │
│                   "http://localhost:8000",                     │
│                                                                 │
│ ✅ AFTER                                                          │
│    AI_ENGINE_URL: process.env.AI_ENGINE_URL ||                 │
│                   "http://ai-engine:8000",                    │
│                                                                 │
│ 📍 FILE: core-backend/src/config/secrets.ts (Line 46)         │
│ 🎯 CHANGED: localhost → ai-engine                             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ BUG #3: Redundant Fallback (Code Cleanup)                      │
├─────────────────────────────────────────────────────────────────┤
│ ❌ BEFORE                                                         │
│    const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(      │
│      secrets.AI_ENGINE_URL || "http://localhost:8000",         │
│    );                                                            │
│                                                                 │
│ ✅ AFTER                                                          │
│    const AI_ENGINE_PREDICT_URL = buildAiEnginePredictUrl(      │
│      secrets.AI_ENGINE_URL,                                    │
│    );                                                            │
│                                                                 │
│ 📍 FILE: core-backend/src/controllers/signal.controller.ts     │
│ 🎯 REMOVED: || "http://localhost:8000" fallback               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 DEPLOYMENT IN 3 STEPS

```bash
# STEP 1: Build
cd core-backend
docker build --no-cache -t trading-backend:latest .

# STEP 2: Restart
docker-compose down
docker-compose up -d

# STEP 3: Verify
curl http://localhost:4000/health  # Should return 200 OK
```

**Total Time: < 5 minutes** ⏱️

---

## 🔄 HOW IT WORKS

### BEFORE (Broken)

```
Client Browser
    ↓
Backend (localhost inside Docker)
    ↓
Tries to connect to: http://localhost:8000
    ↓ ❌
Inside Docker, localhost = the container itself
AI Engine is a DIFFERENT container
    ↓ ❌
ECONNREFUSED (Connection Refused)
    ↓
502 Bad Gateway error
```

### AFTER (Fixed)

```
Client Browser
    ↓
Backend (ai-engine service inside Docker)
    ↓
Connects to: http://ai-engine:8000
    ↓ ✅
Docker DNS resolves ai-engine → Container IP
    ↓ ✅
Reaches AI Engine container
    ↓ ✅
200 OK response with predictions
```

---

## 📋 FILES CHANGED

| File                   | Line | Old Value                | New Value             |
| ---------------------- | ---- | ------------------------ | --------------------- |
| `schema.prisma`        | 2    | `provider = "..."`       | Added `binaryTargets` |
| `secrets.ts`           | 46   | `localhost:8000`         | `ai-engine:8000`      |
| `signal.controller.ts` | 81   | `...or "localhost:8000"` | Removed fallback      |

---

## ✅ VALIDATION TESTS

Run these after deployment to confirm fixes:

```bash
# Test 1: Prisma loaded successfully
docker logs backend_node | grep -i "prisma"
✅ Should show: No errors, no "Query Engine not found"

# Test 2: AI Engine connection works
docker exec backend_node nslookup ai-engine
✅ Should resolve to an IP address

# Test 3: Backend is responsive
curl http://localhost:4000/health
✅ Should return: 200 OK

# Test 4: API works end-to-end
curl -X POST http://localhost:4000/api/v1/predict \
  -H "Content-Type: application/json" \
  -d '{"symbol":"EURUSD","candles":[],"live_price":1.0850}'
✅ Should return: 200 OK with predictions
❌ Should NOT return: 502 Bad Gateway
```

---

## 🎯 EXPECTED RESULTS

### Before Fix

```
docker logs backend_node
  ❌ Error: Prisma Client could not locate the Query Engine
  ❌ ECONNREFUSED 127.0.0.1:8000
  ❌ Unable to forward to AI Engine

curl http://localhost:4000/api/v1/predict
  ❌ 502 Bad Gateway
```

### After Fix

```
docker logs backend_node
  ✅ Prisma Client generated successfully
  ✅ Server listening on port 4000
  ✅ Forwarding data to AI Engine
  ✅ Prediction received from AI Engine

curl http://localhost:4000/api/v1/predict
  ✅ 200 OK
  ✅ Returns prediction with signal/confidence
```

---

## 🔧 IF SOMETHING GOES WRONG

| Symptom                      | Quick Fix                                              |
| ---------------------------- | ------------------------------------------------------ |
| "Prisma Engine not found"    | `docker build --no-cache`                              |
| "ECONNREFUSED" still in logs | Verify secrets.ts has `ai-engine:8000`                 |
| Changes not taking effect    | Restart: `docker-compose down && docker-compose up -d` |
| AI Engine timeout            | Check: `docker logs ai_brain`                          |

---

## 💾 CONFIGURATION REFERENCE

### Essentials

```yaml
# docker-compose.yml
services:
  ai-engine:
    ports:
      - "8000:8000" # AI Engine port
    networks:
      - radar_network # Same network as backend

  core-backend:
    environment:
      PORT: 4000
      # AI_ENGINE_URL defaults to http://ai-engine:8000
    networks:
      - radar_network # Same network as AI Engine
```

### Override (Optional)

```bash
# If you need a custom AI Engine URL
docker-compose.yml:
  core-backend:
    environment:
      AI_ENGINE_URL: http://custom-host:8000

# Or via .env
AI_ENGINE_URL=http://custom-host:8000
```

---

## 📊 BEFORE vs AFTER

```
╔════════════════════════════════════════════════════════════════════╗
║                         BEFORE FIX                                  ║
╠════════════════════════════════════════════════════════════════════╣
║ Prisma Binary    │ ❌ Missing for Alpine Linux                     ║
║ AI Engine URL    │ ❌ Hardcoded localhost:8000                     ║
║ Docker Network   │ ❌ Can't reach services by name                 ║
║ API Responses    │ ❌ 502 Bad Gateway (AI Engine unreachable)      ║
║ Backend Logs     │ ❌ ECONNREFUSED, Prisma errors                  ║
╠════════════════════════════════════════════════════════════════════╣
║                         AFTER FIX                                   ║
╠════════════════════════════════════════════════════════════════════╣
║ Prisma Binary    │ ✅ linux-musl-openssl-3.0.x included            ║
║ AI Engine URL    │ ✅ Uses Docker service name ai-engine          ║
║ Docker Network   │ ✅ Services resolve by name                     ║
║ API Responses    │ ✅ 200 OK with ML predictions                   ║
║ Backend Logs     │ ✅ Clean startup, AI Engine forwarding works    ║
╚════════════════════════════════════════════════════════════════════╝
```

---

## 🎓 KEY CONCEPTS

### Why Binary Targets Matter

- Alpine Linux uses **musl** C library (not GNU glibc)
- Prisma generates native binaries for database access
- Without correct binary target, Prisma fails at runtime
- Solution: Specify `binaryTargets = ["linux-musl-openssl-3.0.x"]`

### Why Service Names Work in Docker

- Docker Compose creates an internal DNS server
- Service names automatically resolve to container IPs
- No need for hardcoded localhost or IP addresses
- Example: `ai-engine` resolves to its container's IP

### Why localhost Doesn't Work in Docker

- Inside a container, `localhost` = the container itself
- Other containers have different IPs
- Can't use `localhost` to reach another container
- Must use service name or explicit IP address

---

## 📞 SUPPORT CHECKLIST

Before asking for help, verify:

- [ ] Rebuilt with `docker build --no-cache` ✓
- [ ] Restarted with `docker-compose down && docker-compose up -d` ✓
- [ ] Waited 10+ seconds for services to start ✓
- [ ] Checked all three files were updated ✓
- [ ] Verified `ai-engine` service is running: `docker ps` ✓
- [ ] Checked backend logs: `docker logs backend_node` ✓
- [ ] Tested connectivity: `curl http://localhost:4000/health` ✓

---

## 🎉 YOU'RE ALL SET!

All critical bugs have been fixed. Your backend should now:

- ✅ Start without Prisma errors
- ✅ Connect to AI Engine successfully
- ✅ Serve predictions with 200 OK responses
- ✅ Log clean operation (no ECONNREFUSED)

**Deploy with confidence!** 🚀
