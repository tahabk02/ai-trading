import {
  allowedOrigins,
  corsOptions,
  isAllowedCorsOrigin,
  privateNetworkMiddleware,
} from "../../config/cors";
import { describe, expect, it } from "vitest";

describe("CORS policy", () => {
  it("test_cors_allows_devtunnels_origin", () => {
    expect(
      isAllowedCorsOrigin("https://b3lrfrj9-4000.uks1.devtunnels.ms"),
    ).toBe(true);
    expect(allowedOrigins).toContain("https://*.devtunnels.ms");
  });

  it("test_cors_rejects_unknown_origin", () => {
    expect(isAllowedCorsOrigin("https://evil.example.test")).toBe(false);
    expect(isAllowedCorsOrigin("http://b3lrfrj9-4000.uks1.devtunnels.ms")).toBe(
      false,
    );
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

    return expect(
      result("https://b3lrfrj9-4000.uks1.devtunnels.ms"),
    ).resolves.toBe(true);
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
});
