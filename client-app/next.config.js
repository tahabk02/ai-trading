/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Rewrites for Local Development Only ──
  // In production, the frontend code (getBaseUrl.ts) detects the server hostname
  // and constructs absolute URLs directly (e.g., http://91.99.71.111:4000/api/v1).
  // These rewrites are only needed for localhost development where both frontend
  // and backend are accessible on different ports (3000, 4000, 8000).
  //
  // Strategy:
  // - Localhost dev: Next.js rewrites proxy requests to localhost:4000/8000
  // - Production: Browser-side code detects hostname and uses absolute URLs
  // - Dev Tunnels: Browser-side code uses relative paths with rewrites
  async rewrites() {
    return [
      // 1. Core Backend REST API
      {
        source: "/api/:path*",
        destination: "http://localhost:4000/api/:path*",
      },

      // 2. Core Backend Socket.IO
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
