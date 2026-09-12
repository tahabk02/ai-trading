# Quick Reference - Frontend API URL Fix

## Files Modified (5 total)

### ✅ 1. `client-app/src/services/api.ts` (Lines 1-6)

**Remove the local `getApiBaseUrl()` function and import it:**

```typescript
import axios, {
  AxiosInstance,
  AxiosError,
  InternalAxiosRequestConfig,
} from "axios";
import { getApiBaseUrl } from "@/utils/getBaseUrl";

// Then create axios instance as usual:
const api: AxiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  // ... rest of config
});
```

---

### ✅ 2. `client-app/src/utils/getBaseUrl.ts` (Three functions)

#### `getApiBaseUrl()`:

```typescript
export function getApiBaseUrl(): string {
  // 1. Honor explicit env var if set at build time
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    // 2. PRODUCTION: Auto-detect non-localhost and use absolute URL
    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol;
      const port = 4000;
      return `${protocol}//${hostname}:${port}/api/v1`;
    }

    // 3. LOCAL DEV & DEV TUNNELS: Use relative paths with rewrites
    return "/api/v1";
  }

  // 4. Server-side rendering
  return "http://localhost:4000/api/v1";
}
```

#### `getWsUrl()`:

```typescript
export function getWsUrl(): string {
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const port = 4000;
      return `${protocol}//${hostname}:${port}`;
    }

    return "/";
  }

  return "http://localhost:4000";
}
```

#### `getAiEngineUrl()`:

```typescript
export function getAiEngineUrl(): string {
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_AI_ENGINE_URL
  ) {
    return process.env.NEXT_PUBLIC_AI_ENGINE_URL;
  }

  if (isBrowser) {
    const hostname = window.location.hostname;

    if (!isLocalHost(hostname)) {
      const protocol = window.location.protocol;
      const port = 8000;
      return `${protocol}//${hostname}:${port}/api/v1`;
    }

    return "/ai";
  }

  return "http://localhost:8000/api/v1";
}
```

---

### ✅ 3. `client-app/next.config.js`

**Simplified rewrites (no env var dependencies):**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:4000/api/:path*",
      },
      {
        source: "/socket.io/:path*",
        destination: "http://localhost:4000/socket.io/:path*",
      },
      { source: "/ai/:path*", destination: "http://localhost:8000/:path*" },
      { source: "/health", destination: "http://localhost:4000/health" },
    ];
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

module.exports = nextConfig;
```

---

### ✅ 4. `client-app/.env.local`

**Reset for local development:**

```env
# Local development environment
# Leave commented out to use automatic detection
# NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
# NEXT_PUBLIC_WS_URL=http://localhost:4000
# NEXT_PUBLIC_AI_ENGINE_URL=http://localhost:8000/api/v1
```

---

### ✅ 5. `client-app/.env.production`

**Already correct (no changes needed):**

```env
# Production environment variables
# These are injected during the build process and embedded in the Next.js bundle
NEXT_PUBLIC_API_URL=http://91.99.71.111:4000/api/v1
NEXT_PUBLIC_WS_URL=http://91.99.71.111:4000
NEXT_PUBLIC_AI_ENGINE_URL=http://91.99.71.111:8000/api/v1
```

---

## How to Rebuild & Deploy

### Step 1: Test Locally

```bash
cd client-app

# Install deps
npm install

# Run dev server
npm run dev

# Visit http://localhost:3000
# Open DevTools → Network tab
# Check that API requests go to /api/v1 (relative path, not localhost:4000)
```

### Step 2: Build Production Image

```bash
cd client-app

# Build without cache (forces fresh build)
docker build --no-cache -t trading-app-frontend:latest .
```

### Step 3: Deploy to Production Server

```bash
# On 91.99.71.111

# Stop old container
docker stop frontend 2>/dev/null || true
docker rm frontend 2>/dev/null || true

# Start new container
docker run -d --name frontend -p 3000:3000 trading-app-frontend:latest

# Verify it's running
docker logs frontend

# Test with curl
curl http://localhost:3000
```

### Step 4: Verify in Browser

1. Open http://91.99.71.111:3000
2. Open DevTools → **Network** tab
3. Make an API call (e.g., click a button that fetches data)
4. Verify the request URL is: `http://91.99.71.111:4000/api/v1/...`
5. Verify the response status is `200 OK` (not `failed - Connection Refused`)

---

## Expected Behavior After Fix

### ✅ Local Development (localhost:3000)

- Browser requests: `/api/v1/...` (relative)
- Actual request: `http://localhost:4000/api/v1/...` (via Next.js rewrite)

### ✅ Production (91.99.71.111:3000)

- Browser requests: `http://91.99.71.111:4000/api/v1/...` (absolute)
- No CORS errors
- No `localhost:4000` fallback

### ✅ Dev Tunnels (\*.devtunnels.ms:3000)

- Browser requests: `/api/v1/...` (relative)
- Actual request: Tunneled through Dev Tunnel proxy to backend

---

## Troubleshooting

**Q: Still seeing `http://localhost:4000` in Network tab?**

- [ ] Clear browser cache (`Ctrl+Shift+Del`)
- [ ] Rebuild Docker image with `--no-cache`
- [ ] Verify container restarted: `docker ps | grep frontend`

**Q: Getting `ERR_CONNECTION_REFUSED`?**

- [ ] Check backend is running on 91.99.71.111:4000
- [ ] Check firewall allows port 4000: `telnet 91.99.71.111 4000`
- [ ] Check CORS headers if needed

**Q: WebSocket connection failing?**

- [ ] Uses same hostname detection as API
- [ ] For localhost: relative path `/` → rewrites to `localhost:4000`
- [ ] For production: `ws://91.99.71.111:4000`

---

## Summary

| Component    | Before                                 | After                                           |
| ------------ | -------------------------------------- | ----------------------------------------------- |
| Fallback URL | ❌ `http://localhost:4000` (hardcoded) | ✅ Auto-detected from hostname                  |
| Production   | ❌ Broken (tries localhost)            | ✅ `http://91.99.71.111:4000`                   |
| Local dev    | ✅ Relative paths                      | ✅ Relative paths (unchanged)                   |
| Dev Tunnels  | ⚠️ Inconsistent                        | ✅ Relative paths (fixed)                       |
| Env vars     | Optional (build-time)                  | Optional (build-time, auto-detect browser-side) |

**Key Insight**: The browser-side code now intelligently detects whether it's running on a local hostname (localhost, 127.0.0.1, private ranges) or a remote hostname (production IP, dev tunnel, etc.) and constructs the appropriate URL. No more hardcoded fallbacks!
