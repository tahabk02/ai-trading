/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || "",

  // ── Build-Time Client Env Inlining ──
  // These values are read ONCE at build/config-load time (Node has
  // `process`) and inlined into client bundles so browser code NEVER touches
  // the `process` global at runtime. Client components must reference the
  // static literals `process.env.NEXT_PUBLIC_*` (or import them from
  // src/lib/env.ts) — optional chaining / dynamic keys are NOT inlined.
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
    NEXT_PUBLIC_AI_ENGINE_URL: process.env.NEXT_PUBLIC_AI_ENGINE_URL,
  },

  // ── Trailing-slash normalization ──
  // engine.io-client (socket.io-client) requests "/socket.io/?EIO=4&transport=…"
  // WITH a trailing slash. Next's default trailing-slash redirect answers that
  // with 308 → "/socket.io?EIO=4…", which the browser WebSocket API cannot
  // follow (the upgrade fails outright; XHR polling survives by following it).
  //
  // PRODUCTION ONLY. `server.js` intercepts /api, /socket.io, /ai and /health
  // BEFORE Next ever sees them, so the flag is belt-and-braces there.
  //
  // It must NOT be enabled in development: with it on, path-to-regexp stops
  // matching the dev rewrite `/socket.io/:path*` against the zero-segment and
  // trailing-slash forms, and `/socket.io/?EIO=4&transport=polling` fell
  // through to a 404 — which killed the live feed in dev. Dev relies on the
  // original rewrite behaviour, so the flag is gated on NODE_ENV.
  skipTrailingSlashRedirect: process.env.NODE_ENV === "production",

  // ── PROXYING: RUNTIME IN PROD, BUILD-TIME REWRITES IN DEV ──
  // Production runs `client-app/server.js` (a custom server that resolves its
  // upstreams from the PROCESS ENVIRONMENT ON EVERY REQUEST), so rewrites MUST
  // be empty in a production build:
  //
  //   `rewrites()` runs ONCE at config-load time — during `next build` — and
  //   the expanded destinations are frozen into `.next/routes-manifest.json`.
  //   `npm start` never re-reads `process.env` for them. Therefore
  //   `API_PROXY_URL=http://core-backend:4000` in `docker-compose.prod.yml`
  //   was silently IGNORED, and the build-time fallback
  //   `http://localhost:4000` was baked in instead. Inside the client-app
  //   container `localhost:4000` *is client-app*, so every proxied request
  //   looped back into the Next server and 404'd.
  //
  // DEVELOPMENT is different: `next dev` does NOT boot `server.js` (Next.js
  // cannot attach a custom server to the dev server), so `/api/*`,
  // `/socket.io/*` and `/ai/*` would have no handler at all and every proxied
  // request would 404. That is why these localhost rewrites are kept for dev
  // only. `next build` always runs with NODE_ENV=production, so a production
  // image can never bake them in.
  //
  // If you add a path here, it only ever affects `next dev`. Production
  // routing lives in matchRoute() in server.js.
  async rewrites() {
    if (process.env.NODE_ENV === "production") {
      // Intentionally empty — see above. Proxying is handled at runtime.
      return [];
    }

    // Dev-only: the browser talks exclusively to the Next origin (see
    // src/utils/config.ts) so these are all localhost in development.
    return [
      // 1. Core Backend REST API
      {
        source: "/api/:path*",
        destination: "http://localhost:4000/api/:path*",
      },

      // 2. Core Backend Socket.IO (required — `awaiting_ssid` / feed_status
      //    reach the UI over this path). `:path*` matches the zero-segment
      //    form `/socket.io` that the client actually dials.
      {
        source: "/socket.io/:path*",
        destination: "http://localhost:4000/socket.io/:path*",
      },

      // 3. AI Engine
      {
        source: "/ai/:path*",
        destination: "http://localhost:8000/:path*",
      },

      // 4. Health check
      {
        source: "/health",
        destination: "http://localhost:4000/health",
      },
    ];
  },

  // ── BUILD CHUNK 404 ERADICATION ──
  // The previous static generateBuildId ("alpha-5-pro-production") forced
  // EVERY deployment to share one build ID. After a redeploy, browsers with
  // cached HTML referenced chunk files (layout.css / main-app.js / page.js)
  // from the OLD build whose hashed filenames no longer existed on disk →
  // persistent 404s until a hard refresh.
  //
  // Fix: let Next.js derive a UNIQUE build ID per build. Combined with the
  // `npm run clean` step in package.json (purges .next before every build),
  // the emitted build-manifest, app-build-manifest and RSC payload always
  // reference exactly the chunk files present in THIS deployment.
  // generateBuildId intentionally REMOVED.

  // ── Immutable Asset Caching ──
  // Hashed static chunks are content-addressed → safe to cache forever.
  // HTML must NEVER be cached so clients always receive markup referencing
  // the CURRENT deployment's chunk set.
  //
  // ⚠️ RULE ORDERING IS CRITICAL: Next.js applies the LAST matching header
  // rule. The catch-all "/:path*" (no-store) MUST come FIRST and the more
  // specific "/_next/static/:path*" (immutable) LAST — otherwise hashed
  // chunks inherit no-store, defeating content-addressed caching and
  // producing stale-manifest / chunk-404 mismatches after redeploys.
  async headers() {
    // ── DEVELOPMENT MODE: PERMISSIVE CSP (no script blocking) ──
    // The browser console logs strict Content Security Policy violations
    // (script-src 'none' / blocked inline scripts / blocked eval) that prevent
    // TradingView / Lightweight Charts, WebSocket handlers, and React from
    // executing. In development we explicitly allow inline scripts + eval
    // (required by webpack Fast Refresh and the zero-flash prepaint scripts)
    // plus websocket / HTTP connections to the local backend (localhost:4000/8000)
    // and any chart CDN. This header is applied ONLY to development responses.
    //
    // IMPORTANT: no Cache-Control rules are added here — dev chunks are unhashed
    // (webpack.js, react-refresh.js, main-app.js) and caching them causes stale
    // chunk 404s / broken hot reloading / manifest mismatches.
    if (process.env.NODE_ENV !== "production") {
      return [
        {
          source: "/:path*",
          headers: [
            {
              key: "Content-Security-Policy",
              value: [
                "default-src 'self' http: https: ws: wss: data: blob:",
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data: blob: http: https:",
                "font-src 'self' data: https:",
                "connect-src 'self' http: https: ws: wss:",
                "worker-src 'self' blob:",
                "media-src 'self' data: blob:",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
                "frame-ancestors 'self'",
              ].join("; "),
            },
          ],
        },
      ];
    }

    // Only apply aggressive caching headers in production mode.
    // In development mode, applying custom cache headers causes the browser
    // to cache unhashed development chunks (webpack.js, react-refresh.js, main-app.js),
    // which leads to persistent 404s, broken hot reloading, and manifest mismatches.

    return [
      // 1) Catch-all FIRST — HTML & dynamic routes must never be cached,
      //    so clients always fetch markup referencing THIS build's chunks.
      {
        source: "/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, must-revalidate",
          },
        ],
      },
      // 2) Webpack runtime + React Refresh bootstrap chunks — these are the
      //    exact files browsers request first (webpack.js, react-refresh.js,
      //    main.js). They are content-hashed → immutable-safe.
      {
        source: "/_next/static/chunks/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // 3) All other hashed static assets (CSS, media, fonts).
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // 4) Build manifests must always revalidate so a redeploy instantly
      //    invalidates stale chunk references instead of serving 404s.
      {
        source: "/_next/static/:buildId*/_buildManifest.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, must-revalidate",
          },
        ],
      },
    ];
  },

  // ── Hardened Build Integrity ──
  // No assetPrefix (default "/"), no custom webpack overrides, no experimental
  // flags, no generateBuildId — all of which can desynchronize the emitted
  // build-manifest / app-build-manifest from the chunks actually on disk and
  // cause webpack.js / react-refresh.js / _app.js / main.js 404s.
  //
  // This config is intentionally minimal so Next.js manages chunk emission,
  // manifest generation, and build IDs end-to-end with zero external drift.
};

module.exports = nextConfig;
