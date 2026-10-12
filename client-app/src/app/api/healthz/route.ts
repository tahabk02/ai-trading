/**
 * GET /api/healthz — LOCAL liveness probe for the client-app container.
 *
 * Answered by Next.js itself, never proxied (see the LOCAL_PATHS reservation in
 * `client-app/server.js`). It deliberately reports ONLY that this Next process
 * is serving requests.
 *
 * Why it must NOT probe the upstreams: this endpoint is the Docker HEALTHCHECK
 * target for the client-app. If it depended on core-backend / ai-engine, a slow
 * or restarting backend would mark the FRONTEND unhealthy, and compose would
 * restart the frontend — taking the whole UI down because a dependency
 * blipped. Dependency readiness is enforced by `depends_on: service_healthy`,
 * and upstream liveness is observed through `/health` (which IS proxied).
 */
import { NextResponse } from "next/server";

// Never statically optimised: this must reflect the CURRENT process, not a
// value frozen at build time.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: "ok",
      service: "client-app",
      runtime: "next-server-proxy",
      uptime_s: Math.floor(process.uptime()),
    },
    {
      // Proxies and orchestrators poll this constantly; never let it cache.
      headers: { "cache-control": "no-store, must-revalidate" },
    },
  );
}
