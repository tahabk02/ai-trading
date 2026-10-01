/**
 * Endpoint resolution — the "dead Dev Tunnel" class of failure.
 *
 * A reissued or expired Dev Tunnel left a dead host in `.env.local`, and because
 * the env override had the highest priority it beat every other rule: every
 * `/api/v1/*` request failed with ERR_NAME_NOT_RESOLVED and the socket.io
 * handshake targeted a `wss://` host that no longer exists.
 *
 * Contract under test:
 *  - a tunnel override is honoured ONLY when the page is served from that tunnel
 *  - a stale tunnel override is ignored (and the app resolves locally/inline)
 *  - a non-tunnel override (localhost) is always honoured
 *  - relative paths and non-absolute values are never treated as stale hosts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const DEAD_TUNNEL_API = "https://b3lrfrj9-4000.uks1.devtunnels.ms/api/v1";
const DEAD_TUNNEL_WS = "https://b3lrfrj9-4000.uks1.devtunnels.ms";

/**
 * The suite runs under `environment: "node"`, so there is no real `window`.
 * The resolvers snapshot `typeof window !== "undefined"` at MODULE LOAD, so the
 * stub must be installed BEFORE the dynamic import (hence resetModules + import).
 */
function mockLocation(hostname: string, origin?: string): void {
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      hostname,
      origin: origin ?? `https://${hostname}`,
      protocol: hostname.includes("localhost") ? "http:" : "https:",
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
  };
}

function clearWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

const ENV_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_WS_URL",
  "NEXT_PUBLIC_SOCKET_URL",
  "NEXT_PUBLIC_AI_ENGINE_URL",
] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  setEnv({});
  clearWindow();
  vi.resetModules();
});

async function loadResolvers() {
  vi.resetModules();
  return {
    getBaseUrl: await import("@/utils/getBaseUrl"),
    config: await import("@/utils/config"),
  };
}

describe("isStaleTunnelOverride", () => {
  it("flags a dead tunnel host while the page is local", async () => {
    mockLocation("localhost");
    const { getBaseUrl } = await loadResolvers();
    expect(getBaseUrl.isStaleTunnelOverride(DEAD_TUNNEL_API)).toBe(true);
    expect(getBaseUrl.isStaleTunnelOverride(DEAD_TUNNEL_WS)).toBe(true);
  });

  it("accepts the tunnel when the page is actually served from it", async () => {
    mockLocation(
      "b3lrfrj9-4000.uks1.devtunnels.ms",
      "https://b3lrfrj9-4000.uks1.devtunnels.ms",
    );
    const { getBaseUrl } = await loadResolvers();
    expect(getBaseUrl.isStaleTunnelOverride(DEAD_TUNNEL_WS)).toBe(false);
  });

  it("flags a tunnel id that no longer matches the live frontend tunnel", async () => {
    mockLocation(
      "2n0ksl75-3000.uks1.devtunnels.ms",
      "https://2n0ksl75-3000.uks1.devtunnels.ms",
    );
    const { getBaseUrl } = await loadResolvers();
    expect(getBaseUrl.isStaleTunnelOverride(DEAD_TUNNEL_WS)).toBe(true);
  });

  it("never flags localhost/relative/non-absolute values", async () => {
    mockLocation("localhost");
    const { getBaseUrl } = await loadResolvers();
    expect(getBaseUrl.isStaleTunnelOverride("http://localhost:4000/api/v1")).toBe(
      false,
    );
    expect(getBaseUrl.isStaleTunnelOverride("/api/v1")).toBe(false);
    expect(getBaseUrl.isStaleTunnelOverride("")).toBe(false);
    expect(getBaseUrl.isStaleTunnelOverride(undefined)).toBe(false);
  });
});

describe("local resolution with a dead tunnel still in .env.local", () => {
  it("resolves the API to a same-origin path, not the dead host", async () => {
    mockLocation("localhost");
    setEnv({
      NEXT_PUBLIC_API_URL: DEAD_TUNNEL_API,
      NEXT_PUBLIC_WS_URL: DEAD_TUNNEL_WS,
      NEXT_PUBLIC_SOCKET_URL: DEAD_TUNNEL_WS,
      NEXT_PUBLIC_AI_ENGINE_URL:
        "https://b3lrfrj9-8000.uks1.devtunnels.ms/api/v1",
    });
    const { getBaseUrl } = await loadResolvers();
    expect(getBaseUrl.getApiBaseUrl()).not.toContain("devtunnels.ms");
    expect(getBaseUrl.getWsUrl()).not.toContain("devtunnels.ms");
    expect(getBaseUrl.getAiEngineUrl()).not.toContain("devtunnels.ms");
  });

  it("keeps config.ts in agreement with getBaseUrl.ts", async () => {
    mockLocation("localhost");
    setEnv({
      NEXT_PUBLIC_API_URL: DEAD_TUNNEL_API,
      NEXT_PUBLIC_WS_URL: DEAD_TUNNEL_WS,
    });
    const { config } = await loadResolvers();
    expect(config.urls.API_URL).not.toContain("devtunnels.ms");
    expect(config.urls.WS_URL).not.toContain("devtunnels.ms");
  });
});

describe("healthy local configuration", () => {
  it("honours explicit localhost overrides", async () => {
    mockLocation("localhost");
    setEnv({
      NEXT_PUBLIC_API_URL: "http://localhost:4000/api/v1",
      NEXT_PUBLIC_WS_URL: "http://localhost:4000",
    });
    const { getBaseUrl } = await loadResolvers();
    expect(getBaseUrl.getApiBaseUrl()).toBe("http://localhost:4000/api/v1");
    expect(getBaseUrl.getWsUrl()).toBe("http://localhost:4000");
  });

  it("falls back to relative paths when nothing is set", async () => {
    mockLocation("localhost");
    setEnv({});
    const { getBaseUrl, config } = await loadResolvers();
    expect(getBaseUrl.getApiBaseUrl()).toBe("/api/v1");
    expect(getBaseUrl.getAiEngineUrl()).toBe("/ai");
    expect(config.urls.API_URL).toBe("/api/v1");
    expect(config.urls.WS_URL).toBe("/");
  });
});

/**
 * REGRESSION GUARD: `ReferenceError: process is not defined at getApiBaseUrl`.
 *
 * In a real client bundle `process` is not an undefined VALUE, it is an
 * UNDECLARED identifier, and it throws on dereference. Optional chaining does
 * not save it — `process?.env` throws exactly like `process.env`; only
 * `typeof process === "undefined"` short-circuits safely.
 *
 * This cannot be exercised by deleting `globalThis.process` inside vitest:
 * the worker thread's IPC transport depends on that exact binding, so
 * removing it kills the runner (ERR_IPC_CHANNEL_CLOSED) instead of producing a
 * clean assertion failure. The contract is therefore locked in two safe ways:
 * a static source contract below, and a bundle check that no `process.env`
 * survives into the client chunks after `next build`.
 */
describe("process.env access contract", () => {
  const readSource = (rel: string): string => {
    const path = new URL(`../../utils/${rel}`, import.meta.url);
    return readFileSync(fileURLToPath(path), "utf8");
  };

  /** Strip comments so documentation prose is not mistaken for real code. */
  const codeOf = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("guards the one file that dereferences process", () => {
    // getBaseUrl.ts owns the only `process.env` read in the app; config.ts
    // delegates to readPublicEnv and therefore must contain no direct access
    // (asserted separately below).
    const code = codeOf(readSource("getBaseUrl.ts"));
    expect(code).toMatch(/if\s*\(\s*typeof process === "undefined"\s*\)/);

    // The guard must come BEFORE any dereference, otherwise it is decoration.
    const guardAt = code.indexOf('typeof process === "undefined"');
    const firstRead = code.search(/[^.\w]process\.env/);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstRead).toBeGreaterThan(guardAt);
  });

  it("never uses the un-inlinable access forms", () => {
    for (const file of ["getBaseUrl.ts", "config.ts"]) {
      const code = codeOf(readSource(file));
      // `process.env?.X` and `process?.env` both defeat DefinePlugin inlining
      // AND both throw in the browser when `process` is undeclared.
      expect(code, `${file} must not use process.env?.`).not.toMatch(
        /process\.env\s*\?\./,
      );
      expect(code, `${file} must not use process?.env`).not.toMatch(
        /process\?\.env/,
      );
      // A dynamic key lookup cannot be inlined either.
      expect(code, `${file} must not use dynamic process.env keys`).not.toMatch(
        /process\.env\s*\[/,
      );
    }
  });

  it("reads env only through readPublicEnv", () => {
    // config.ts previously dereferenced process.env directly at module load.
    const configCode = codeOf(readSource("config.ts"));
    const direct = configCode.match(/process\.env\.[A-Z_]+/g) ?? [];
    expect(direct, "config.ts must not read process.env directly").toHaveLength(
      0,
    );
  });

  it("readPublicEnv degrades to undefined for unknown keys and missing values", async () => {
    const { getBaseUrl } = await loadResolvers();
    setEnv({});
    expect(
      getBaseUrl.readPublicEnv("NEXT_PUBLIC_API_URL"),
    ).toBeUndefined();
    expect(
      getBaseUrl.readPublicEnv(
        "NEXT_PUBLIC_NOT_A_KEY" as Parameters<
          typeof getBaseUrl.readPublicEnv
        >[0],
      ),
    ).toBeUndefined();
  });
});


