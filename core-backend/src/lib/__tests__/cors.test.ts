import {
  allowedOrigins,
  corsOptions,
  isAllowedCorsOrigin,
  privateNetworkMiddleware,
} from "../../config/cors";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import cors from "cors";
import type { AddressInfo } from "net";
import type { Server } from "http";

describe("CORS policy", () => {
  it("test_cors_rejects_unconfigured_tunnel_origins", () => {
    // Dev Tunnels issue `*.devtunnels.ms` hostnames to anyone who asks, so a
    // suffix match is equivalent to reflecting every origin on the internet.
    expect(
      isAllowedCorsOrigin("https://b3lrfrj9-4000.uks1.devtunnels.ms"),
    ).toBe(false);
    expect(isAllowedCorsOrigin("https://abc.attacker.devtunnels.ms")).toBe(
      false,
    );
    expect(
      isAllowedCorsOrigin("https://abc.tunnels.api.visualstudio.com"),
    ).toBe(false);
    expect(allowedOrigins).not.toContain("https://*.devtunnels.ms");
    expect(allowedOrigins).not.toContain("https://*.uks1.devtunnels.ms");
  });

  it("test_cors_accepts_tunnel_origin_only_when_explicitly_registered", async () => {
    const tunnel = "https://b3lrfrj9-3000.uks1.devtunnels.ms";
    vi.resetModules();
    process.env.CORS_ALLOWED_TUNNEL_ORIGINS = tunnel;
    try {
      const mod = await import("../../config/cors");
      expect(mod.allowedOrigins).toContain(tunnel);
      expect(mod.isAllowedCorsOrigin(tunnel)).toBe(true);
      // Sharing the same registrable domain must not grant anything.
      expect(mod.isAllowedCorsOrigin("https://attacker-3000.uks1.devtunnels.ms")).toBe(
        false,
      );
    } finally {
      delete process.env.CORS_ALLOWED_TUNNEL_ORIGINS;
      vi.resetModules();
    }
  });

  it("test_cors_rejects_unknown_origin", () => {
    expect(isAllowedCorsOrigin("https://evil.example.test")).toBe(false);
    expect(isAllowedCorsOrigin("http://b3lrfrj9-4000.uks1.devtunnels.ms")).toBe(
      false,
    );
    // Prefix confusion: must not be treated as the localhost allowlist entry.
    expect(isAllowedCorsOrigin("http://localhost:3000.evil.example")).toBe(false);
  });

  it("test_socket_cors_matches_http_cors", () => {
    const resolver = corsOptions.origin as (
      origin: string,
      callback: (error: Error | null, allowed?: boolean) => void,
    ) => void;
    const result = (origin: string) =>
      new Promise<boolean>((resolve, reject) =>
        resolver(origin, (error, allowed) =>
          error ? reject(error) : resolve(allowed === true),
        ),
      );

    // Allowlisted origin resolves true; an unlisted tunnel resolves false.
    return Promise.all([
      expect(result("http://localhost:3000")).resolves.toBe(true),
      expect(result("https://b3lrfrj9-4000.uks1.devtunnels.ms")).resolves.toBe(
        false,
      ),
    ]);
  });

  it("test_private_network_header_present", () => {
    const headers: Record<string, string> = {};
    const req = {
      header: (name: string) =>
        name === "Access-Control-Request-Private-Network" ? "true" : undefined,
    };
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };

    privateNetworkMiddleware(req as never, res as never, () => undefined);

    expect(headers["Access-Control-Allow-Private-Network"]).toBe("true");
  });

  it("test_cors_denies_unknown_origin_without_throwing", () => {
    const resolver = corsOptions.origin as (
      origin: string,
      callback: (error: Error | null, allowed?: boolean) => void,
    ) => void;

    // Denying (no headers) keeps the real request status visible; throwing used
    // to surface as a 500 from the global error handler.
    const denied = new Promise<boolean>((resolve, reject) =>
      resolver("https://evil.example.test", (error, allowed) =>
        error ? reject(error) : resolve(allowed === true),
      ),
    );

    return expect(denied).resolves.toBe(false);
  });
});

/**
 * Real preflight/response contract over a live HTTP listener (no mocked
 * middleware, no stubbed headers) — this is the exact browser handshake a
 * tunnel client performs against :4000.
 */
describe("CORS preflight over HTTP", () => {
  const app = express();
  app.use(privateNetworkMiddleware);
  app.use(cors(corsOptions));
  app.get("/api/v1/ping", (_req, res) => {
    res.json({ ok: true });
  });

  let server: Server;
  let base: string;

  const start = async (): Promise<void> => {
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  };

  const stop = (): Promise<void> =>
    new Promise((resolve) => server.close(() => resolve()));

  it("answers an allowlisted preflight with a reflected origin + credentials", async () => {
    await start();
    try {
      const origin = "http://localhost:3000";
      const res = await fetch(`${base}/api/v1/ping`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization",
          "Access-Control-Request-Private-Network": "true",
        },
      });

      expect(res.status).toBe(204);
      // Reflected, never "*" — a wildcard is illegal with credentials.
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        "content-type",
      );
      expect(res.headers.get("access-control-allow-private-network")).toBe("true");
      expect(res.headers.get("access-control-max-age")).toBe("86400");
    } finally {
      await stop();
    }
  });

  it("sends CORS headers on the actual response for an allowed origin", async () => {
    await start();
    try {
      const origin = "http://localhost:3000";
      const res = await fetch(`${base}/api/v1/ping`, { headers: { Origin: origin } });

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await stop();
    }
  });

  it("sends NO CORS headers for an unlisted tunnel preflight", async () => {
    await start();
    try {
      const res = await fetch(`${base}/api/v1/ping`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://b3lrfrj9-3000.uks1.devtunnels.ms",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization",
          "Access-Control-Request-Private-Network": "true",
        },
      });

      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    } finally {
      await stop();
    }
  });

  it("omits CORS headers for a disallowed origin (browser blocks the read)", async () => {
    await start();
    try {
      const res = await fetch(`${base}/api/v1/ping`, {
        headers: { Origin: "https://evil.example.test" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await stop();
    }
  });
});