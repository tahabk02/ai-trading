/**
 * HOST-AGNOSTIC ENDPOINT RESOLUTION (loopback / CORS / tunnel regressions).
 *
 * The browser must ONLY ever talk to the origin that served the page. Every
 * backend address is resolved SERVER-SIDE by the Next.js rewrites, where the
 * browser's hostname and the tunnel's exposed ports are irrelevant.
 *
 * The regression these lock down: a non-local hostname used to be rewritten
 * into an absolute `https://<hostname>:4000` API URL and a
 * `-3000. → -4000.` WebSocket URL. A Dev Tunnel terminates TLS on 443 only, so
 * `:4000` on that host is not forwarded → ERR_CONNECTION_REFUSED, on top of
 * being cross-origin (so CORS applied too). The WS variant additionally
 * required a SECOND tunnel to be running.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("@/utils/getBaseUrl");

/** Simulate a browser served from `origin`, then load a FRESH module. */
async function servedFrom(origin: string): Promise<Mod> {
  const url = new URL(origin);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      hostname: url.hostname,
      protocol: url.protocol,
      port: url.port,
      origin: url.origin,
    },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  vi.resetModules();
  return import("@/utils/getBaseUrl");
}

function unsetsWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

afterEach(() => {
  unsetsWindow();
  vi.unstubAllEnvs();
});

const ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://b3lrfrj9-3000.uks1.devtunnels.ms",
  "https://another-id-3001.westus2.devtunnels.ms",
  "http://91.99.71.111:3000",
  "https://trading.example.com",
];

describe("browser resolution is same-origin for EVERY hostname", () => {
  it.each(ORIGINS)("API stays relative on %s", async (origin) => {
    const m = await servedFrom(origin);
    expect(m.getApiBaseUrl()).toBe("/api/v1");
  });

  it.each(ORIGINS)("AI engine stays relative on %s", async (origin) => {
    const m = await servedFrom(origin);
    expect(m.getAiEngineUrl()).toBe("/ai");
  });

  it.each(ORIGINS)("WebSocket stays on the page origin for %s", async (origin) => {
    const m = await servedFrom(origin);
    expect(m.getWsUrl()).toBe(new URL(origin).origin);
  });
});

describe("no browser-visible backend port or loopback reference", () => {
  it.each(ORIGINS)("never points at the backend port on %s", async (origin) => {
    const m = await servedFrom(origin);
    for (const value of [m.getApiBaseUrl(), m.getWsUrl(), m.getAiEngineUrl()]) {
      // The backend's own port must never appear in a browser-visible URL.
      expect(value).not.toMatch(/:4000/);
      expect(value).not.toMatch(/:8000/);
    }
  });

  it.each(ORIGINS)("API and AI resolve host-free on %s", async (origin) => {
    const m = await servedFrom(origin);
    // A relative path carries NO host at all, so there is nothing for a
    // tunnel/LB to refuse and nothing for CORS to police.
    for (const value of [m.getApiBaseUrl(), m.getAiEngineUrl()]) {
      expect(value.startsWith("/")).toBe(true);
      expect(value).not.toMatch(/^https?:/);
      expect(value).not.toMatch(/localhost/);
    }
  });

  it("does not point the socket at the backend loopback port", async () => {
    const m = await servedFrom("http://localhost:3000");
    // The socket base is the PAGE origin (proxied by the rewrite), not the
    // backend's localhost:4000.
    expect(m.getWsUrl()).toBe("http://localhost:3000");
    expect(m.getWsUrl()).not.toMatch(/:4000/);
  });

  it("never derives a sibling -4000 tunnel host", async () => {
    // The old behaviour rewrote the origin's port segment, requiring a second
    // tunnel that usually was not running.
    const m = await servedFrom("https://abc-3000.uks1.devtunnels.ms");
    expect(m.getWsUrl()).not.toContain("-4000.");
  });

  it("is a same-origin path, so no CORS preflight is required", async () => {
    const m = await servedFrom("https://abc-3000.uks1.devtunnels.ms");
    const api = m.getApiBaseUrl();
    const pageOrigin = "https://abc-3000.uks1.devtunnels.ms";
    // Relative ⇒ resolved against the page origin ⇒ identical origin.
    expect(new URL(api, pageOrigin).origin).toBe(pageOrigin);
  });
});

describe("explicit env overrides still win", () => {
  it("honours NEXT_PUBLIC_API_URL when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com/api/v1");
    const m = await servedFrom("https://app.example.com");
    expect(m.getApiBaseUrl()).toBe("https://api.example.com/api/v1");
  });

  it("honours NEXT_PUBLIC_SOCKET_URL when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", "https://api.example.com");
    const m = await servedFrom("https://app.example.com");
    expect(m.getWsUrl()).toBe("https://api.example.com");
  });
});

describe("a dead tunnel override is ignored, not obeyed", () => {
  it("falls back to same-origin when the override host is not the page host", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://OLD-ID-3000.uks1.devtunnels.ms/api/v1");
    const m = await servedFrom("https://NEW-ID-3000.uks1.devtunnels.ms");
    expect(m.getApiBaseUrl()).toBe("/api/v1");
    expect(m.isStaleTunnelOverride("https://OLD-ID-3000.uks1.devtunnels.ms/api/v1")).toBe(
      true,
    );
  });

  it("honours the override when the page really is served from it", async () => {
    const same = "https://SAME-3000.uks1.devtunnels.ms/api/v1";
    vi.stubEnv("NEXT_PUBLIC_API_URL", same);
    const m = await servedFrom("https://SAME-3000.uks1.devtunnels.ms");
    expect(m.getApiBaseUrl()).toBe(same);
  });
});

describe("server-side resolution stays absolute", () => {
  it("uses loopback when there is no window (SSR / build)", async () => {
    unsetsWindow();
    vi.resetModules();
    const m = await import("@/utils/getBaseUrl");
    expect(m.getApiBaseUrl()).toBe("http://localhost:4000/api/v1");
    expect(m.getWsUrl()).toBe("http://localhost:4000");
    expect(m.getAiEngineUrl()).toBe("http://localhost:8000/api/v1");
    expect(m.isRemoteTunnel()).toBe(false);
  });
});
