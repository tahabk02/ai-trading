import { describe, expect, it, vi, afterEach } from "vitest";

async function loadCors(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return await import("../../config/cors");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CORS policy", () => {
  it("allows the local frontend origins", async () => {
    const { isAllowedCorsOrigin } = await loadCors({});
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  // [351] regression: Dev Tunnels subdomains are handed out to anyone who asks,
  // so a suffix match + credentials:true lets an arbitrary site read
  // authenticated responses. An unconfigured tunnel must be refused.
  it("refuses an arbitrary devtunnels origin (no wildcard reflection)", async () => {
    const { isAllowedCorsOrigin, allowedOrigins } = await loadCors({});
    expect(isAllowedCorsOrigin("https://abc.attacker.devtunnels.ms")).toBe(false);
    expect(isAllowedCorsOrigin("https://b3lrfrj9-4000.uks1.devtunnels.ms")).toBe(
      false,
    );
    expect(isAllowedCorsOrigin("https://x-1.anything.tunnels.api.visualstudio.com")).toBe(
      false,
    );
    // the wildcard must not even be advertised as allowed
    expect(allowedOrigins).not.toContain("https://*.devtunnels.ms");
    expect(allowedOrigins).not.toContain("https://*.uks1.devtunnels.ms");
  });

  it("refuses other lookalikes and unknown origins", async () => {
    const { isAllowedCorsOrigin } = await loadCors({});
    expect(isAllowedCorsOrigin("https://evil.example.test")).toBe(false);
    expect(isAllowedCorsOrigin("null")).toBe(false);
    expect(isAllowedCorsOrigin("file://")).toBe(false);
    // plaintext downgrade of an allowed-looking host
    expect(isAllowedCorsOrigin("http://b3lrfrj9-4000.uks1.devtunnels.ms")).toBe(
      false,
    );
    // suffix confusion: allowlist entry as a prefix of the attacker's host
    expect(isAllowedCorsOrigin("http://localhost:3000.evil.example")).toBe(false);
  });

  it("allows an explicitly registered tunnel origin", async () => {
    const { isAllowedCorsOrigin, allowedOrigins } = await loadCors({
      CORS_ALLOWED_TUNNEL_ORIGINS:
        "https://b3lrfrj9-4000.uks1.devtunnels.ms",
    });
    expect(isAllowedCorsOrigin("https://b3lrfrj9-4000.uks1.devtunnels.ms")).toBe(
      true,
    );
    expect(allowedOrigins).toContain(
      "https://b3lrfrj9-4000.uks1.devtunnels.ms",
    );
    // a different tunnel is still refused
    expect(isAllowedCorsOrigin("https://abc.attacker.devtunnels.ms")).toBe(false);
  });

  it("normalises configured origins and ignores unusable entries", async () => {
    const { allowedOrigins } = await loadCors({
      // a bare `*` used to be advertised here while being silently ignored
      CORS_ORIGIN: "*,https://trade.example.com/some/path/,not a url",
    });
    expect(allowedOrigins).toContain("https://trade.example.com");
    expect(allowedOrigins).not.toContain("*");
  });

  it("socket.io and http CORS cannot drift", async () => {
    const { corsOptions } = await loadCors({
      CORS_ALLOWED_TUNNEL_ORIGINS: "https://b3lrfrj9-4000.uks1.devtunnels.ms",
    });
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

    await expect(
      result("https://b3lrfrj9-4000.uks1.devtunnels.ms"),
    ).resolves.toBe(true);
    // and the socket engine refuses the same origin http refuses
    await expect(result("https://abc.attacker.devtunnels.ms")).rejects.toThrow(
      /not allowed by CORS/,
    );
  });

  it("allows credentialed CORS only for allowlisted origins", async () => {
    const { corsOptions, corsOriginResolver } = await loadCors({});
    expect(corsOptions.credentials).toBe(true);
    // no Origin header (curl, health probe, SSR) is not a CORS failure
    const noOrigin = await new Promise<boolean>((resolve) =>
      corsOriginResolver(undefined, (_e, allow) => resolve(allow === true)),
    );
    expect(noOrigin).toBe(true);
  });

  it("private network header present", async () => {
    const { privateNetworkMiddleware } = await loadCors({});
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
});