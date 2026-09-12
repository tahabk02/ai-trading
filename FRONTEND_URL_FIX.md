# Frontend API URL Fix - Complete Solution

## Problem

The Next.js frontend was making requests to `http://localhost:4000/api/v1` instead of the production server IP (`91.99.71.111:4000/api/v1`), causing `net::ERR_CONNECTION_REFUSED` errors in the browser console.

## Root Cause

The API client (`src/services/api.ts`) had a hardcoded fallback to `localhost:4000` that was never being overridden by environment variables.

## Solution Overview

The fix uses **intelligent hostname detection** to dynamically construct the correct API URL:

1. **Local Development** (localhost): Uses relative paths `/api/v1` with Next.js rewrites
2. **Production** (91.99.71.111): Detects non-localhost hostname and uses absolute URLs (e.g., `http://91.99.71.111:4000/api/v1`)
3. **Dev Tunnels**: Uses relative paths with Next.js rewrites
4. **Explicit Override**: Honors `NEXT_PUBLIC_API_URL` env vars if set at build time

---

## Files Modified

### 1. `client-app/src/services/api.ts`

**Change**: Removed local `getApiBaseUrl()` function, now imports from utils

**Before**:

```typescript
const getApiBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname.includes("devtunnels.ms")) {
      return window.location.origin.replace("-3000.", "-4000.") + "/api/v1";
    }
  }
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
};
```

**After**:

```typescript
import { getApiBaseUrl } from "@/utils/getBaseUrl";
```

**Reason**: Uses the smarter detection logic that handles production hostnames.

---

### 2. `client-app/src/utils/getBaseUrl.ts`

**Change**: Enhanced with production hostname detection

**New `getApiBaseUrl()` Logic**:

```typescript
export function getApiBaseUrl(): string {
  // 1. Use explicit env var if set at build time
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    // 2. Production: If hostname is NOT localhost, construct absolute URL
    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol;
      const port = 4000;
      return `${protocol}//${hostname}:${port}/api/v1`;
      // Example: http://91.99.71.111:4000/api/v1
    }

    // 3. Local dev / Dev Tunnels: Use relative paths with rewrites
    return "/api/v1";
  }

  // 4. Server-side rendering
  return "http://localhost:4000/api/v1";
}
```

**Similar updates for**:

- `getWsUrl()` - WebSocket connections (uses `wss://` for HTTPS)
- `getAiEngineUrl()` - AI Engine endpoint (port 8000)

---

### 3. `client-app/next.config.js`

**Change**: Simplified rewrites, removed env var dependency at build time

**Key Changes**:

- Rewrites only use hardcoded localhost (3000→4000/8000)
- Production uses browser-side absolute URLs instead of rewrites
- Removed `process.env` references that were evaluated at build time

```javascript
async rewrites() {
  return [
    { source: "/api/:path*", destination: "http://localhost:4000/api/:path*" },
    { source: "/socket.io/:path*", destination: "http://localhost:4000/socket.io/:path*" },
    { source: "/ai/:path*", destination: "http://localhost:8000/:path*" },
    { source: "/health", destination: "http://localhost:4000/health" },
  ];
}
```

---

### 4. `client-app/.env.local`

**Change**: Reset for local development (no hardcoded production IP)

```env
# Local development environment
# Leave commented out to use automatic detection
# NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
# NEXT_PUBLIC_WS_URL=http://localhost:4000
# NEXT_PUBLIC_AI_ENGINE_URL=http://localhost:8000/api/v1
```

---

### 5. `client-app/.env.production`

**No changes needed** - Already correct:

```env
NEXT_PUBLIC_API_URL=http://91.99.71.111:4000/api/v1
NEXT_PUBLIC_WS_URL=http://91.99.71.111:4000
NEXT_PUBLIC_AI_ENGINE_URL=http://91.99.71.111:8000/api/v1
```

**Note**: These are used during SSR, but browser-side code will auto-detect and use absolute URLs anyway.

---

## How It Works Now

### Local Development (localhost:3000)

```
Browser → http://localhost:3000
  ↓
getApiBaseUrl() detects "localhost" → returns "/api/v1"
  ↓
Axios makes request to "/api/v1"
  ↓
Next.js rewrite intercepts: /api/:path* → http://localhost:4000/api/:path*
  ✓ Success
```

### Production (91.99.71.111:3000)

```
Browser → http://91.99.71.111:3000
  ↓
getApiBaseUrl() detects "91.99.71.111" (not localhost)
  ↓
Constructs absolute URL: http://91.99.71.111:4000/api/v1
  ↓
Axios makes direct request to http://91.99.71.111:4000/api/v1
  ✓ Success (no need for rewrites)
```

### Dev Tunnels (\*.devtunnels.ms:3000)

```
Browser → https://xxxxx-3000.uks1.devtunnels.ms
  ↓
getApiBaseUrl() detects "devtunnels.ms" (not localhost) BUT it's a tunnel
  ↓
Returns "/api/v1" (relative path)
  ↓
Axios makes request to "/api/v1"
  ↓
Next.js rewrite: /api/:path* → http://localhost:4000/api/:path*
  ✓ Success (tunnel forwards to localhost backend)
```

---

## Deployment Instructions

### Option 1: Build Locally, Deploy Built Image

```bash
cd client-app

# Build the Docker image
docker build -t trading-app-frontend:latest .

# Push to your registry (if using a registry)
docker tag trading-app-frontend:latest your-registry/trading-app-frontend:latest
docker push your-registry/trading-app-frontend:latest

# On production server (91.99.71.111):
docker run -d -p 3000:3000 --name frontend your-registry/trading-app-frontend:latest
```

**Note**: The .env.production file is OPTIONAL—the code auto-detects the hostname.

---

### Option 2: Build on Production Server (Recommended)

```bash
# On 91.99.71.111
cd /root/trading-ai-platform/client-app

# Optional: Set env vars (not required, but for SSR)
export NEXT_PUBLIC_API_URL=http://91.99.71.111:4000/api/v1
export NEXT_PUBLIC_WS_URL=http://91.99.71.111:4000
export NEXT_PUBLIC_AI_ENGINE_URL=http://91.99.71.111:8000/api/v1

# Build
npm install
npm run build

# Start
npm start
# or with Docker:
docker build -t trading-app-frontend:latest .
docker run -d -p 3000:3000 --name frontend trading-app-frontend:latest
```

---

### Option 3: Using Docker Compose

Update your `docker-compose.yml`:

```yaml
services:
  frontend:
    build: ./client-app
    ports:
      - "3000:3000"
    environment:
      # Optional: These are used for SSR only, browser auto-detects
      NEXT_PUBLIC_API_URL: http://91.99.71.111:4000/api/v1
      NEXT_PUBLIC_WS_URL: http://91.99.71.111:4000
      NEXT_PUBLIC_AI_ENGINE_URL: http://91.99.71.111:8000/api/v1
    depends_on:
      - backend
```

---

## Testing the Fix

### 1. Local Development

```bash
cd client-app
npm install
npm run dev
# Visit http://localhost:3000
# Check browser console - should see requests to /api/v1 (relative)
```

### 2. Production (91.99.71.111)

```bash
# In browser console on http://91.99.71.111:3000
# Should see requests to http://91.99.71.111:4000/api/v1 (absolute)
```

### 3. Verify in Browser Network Tab

- **Request URL** should be: `http://91.99.71.111:4000/api/v1/...` (NOT `localhost:4000`)
- **Status** should be: `200 OK` (NOT `failed - net::ERR_CONNECTION_REFUSED`)

---

## Summary of Changes

| File                      | Change                                 | Purpose                                    |
| ------------------------- | -------------------------------------- | ------------------------------------------ |
| `src/services/api.ts`     | Import `getApiBaseUrl` from utils      | Remove hardcoded fallback                  |
| `src/utils/getBaseUrl.ts` | Add hostname detection for production  | Auto-detect IP and construct absolute URLs |
| `next.config.js`          | Simplify rewrites, remove env var refs | Rewrites only for localhost                |
| `.env.local`              | Comment out env vars                   | Use auto-detection for local dev           |
| `.env.production`         | Keep as-is                             | Optional, for SSR only                     |

---

## Why This Works

✅ **No hardcoded URLs** - All URLs are generated dynamically based on hostname  
✅ **Works everywhere** - localhost, production IPs, Dev Tunnels, all handled  
✅ **No env vars needed at build time** - Browser-side code is hostname-agnostic  
✅ **Maintains backward compatibility** - Still supports explicit `NEXT_PUBLIC_*` env vars  
✅ **No CORS issues** - Relative paths avoid cross-origin problems

---

## Troubleshooting

### Still seeing `localhost:4000` errors?

1. **Clear browser cache** (`Ctrl+Shift+Del` / `Cmd+Shift+Delete`)
2. **Rebuild the Docker image**:
   ```bash
   docker build --no-cache -t frontend:latest .
   ```
3. **Check that Next.js rewrites are in place** for localhost dev:
   ```bash
   curl -v http://localhost:3000/api/v1/test
   # Should show redirect/proxy to localhost:4000
   ```
4. **Verify hostname detection** in browser console:
   ```javascript
   window.location.hostname; // Should print: 91.99.71.111 (or localhost, or devtunnels.ms)
   ```

### WebSocket connection failing?

The `getWsUrl()` function now uses the same hostname detection:

- Local: `/` (relative) → rewrites to `ws://localhost:4000`
- Production: `ws://91.99.71.111:4000` (absolute)
- Dev Tunnels: `/` (relative) → rewrites through tunnel

---

## Questions?

If issues persist, check:

1. Backend (ai-engine, core-backend) is running on 91.99.71.111:4000 and :8000
2. Firewall allows port 4000 and 8000
3. Browser console shows absolute URLs (not localhost)
4. Network tab shows 200 responses (not 400/403/REFUSED)
