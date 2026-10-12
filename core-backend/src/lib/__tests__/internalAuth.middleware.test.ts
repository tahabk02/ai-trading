/**
 * internalAuth.middleware.test.ts — PART 44.1 [503]
 *
 * Proves the two internal-surface guards:
 *   • requireAiEngineKey (POST /signals/receive) — shared secret, 401/403.
 *   • requireAdminKey    (GET /audit/execution-logs) — admin key, 401/403.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const secretsMock = vi.hoisted(() => ({
  value: {
    AI_ENGINE_API_KEY: "real-service-key",
    PO_HEALTH_ADMIN_KEY: "real-admin-key",
    PO_HEALTH_HOSTED: false as boolean,
  },
}));
vi.mock("../../config/secrets", () => ({ secrets: secretsMock.value }));
vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  requireAiEngineKey,
  requireAdminKey,
} from "../../middlewares/internalAuth.middleware";

type JsonBody = Record<string, unknown>;

function makeReq(headers: Record<string, string> = {}, ip = "127.0.0.1") {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ip,
    socket: { remoteAddress: ip },
    get: (name: string) => lower[String(name).toLowerCase()],
  } as unknown as Request;
}

function capture() {
  const calls: { code: number; body: JsonBody }[] = [];
  let statusCode = 200;
  const res = {
    statusCode,
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: JsonBody) {
      calls.push({ code: statusCode, body });
      return res;
    },
  } as unknown as Response;
  return { res, calls };
}

function run(
  guard: (req: Request, res: Response, next: () => void) => void,
  req: Request,
) {
  const { res, calls } = capture();
  let nexted = false;
  guard(req, res, () => {
    nexted = true;
  });
  return { nexted, calls };
}

describe("requireAiEngineKey — POST /signals/receive [503]", () => {
  beforeEach(() => {
    secretsMock.value.AI_ENGINE_API_KEY = "real-service-key";
  });

  it("401 when the key is configured but absent", () => {
    const { nexted, calls } = run(requireAiEngineKey, makeReq());
    expect(nexted).toBe(false);
    expect(calls[0].code).toBe(401);
  });

  it("403 when the key is configured but wrong", () => {
    const { nexted, calls } = run(
      requireAiEngineKey,
      makeReq({ "x-api-key": "nope" }),
    );
    expect(nexted).toBe(false);
    expect(calls[0].code).toBe(403);
  });

  it("passes with the correct key", () => {
    const { nexted, calls } = run(
      requireAiEngineKey,
      makeReq({ "x-api-key": "real-service-key" }),
    );
    expect(nexted).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("fails closed (503) in production when the secret is unconfigured", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    secretsMock.value.AI_ENGINE_API_KEY = "";
    try {
      const { nexted, calls } = run(requireAiEngineKey, makeReq());
      expect(nexted).toBe(false);
      expect(calls[0].code).toBe(503);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("allows the dev default key in non-production (loopback convenience)", () => {
    secretsMock.value.AI_ENGINE_API_KEY = "dev-internal-service-key";
    const { nexted } = run(requireAiEngineKey, makeReq());
    expect(nexted).toBe(true);
  });
});

describe("requireAdminKey — GET /audit/execution-logs [503]", () => {
  beforeEach(() => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "real-admin-key";
    secretsMock.value.PO_HEALTH_HOSTED = false;
  });

  afterEach(() => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "real-admin-key";
    secretsMock.value.PO_HEALTH_HOSTED = false;
  });

  it("401 when the admin key is configured but absent", () => {
    const { nexted, calls } = run(requireAdminKey, makeReq());
    expect(nexted).toBe(false);
    expect(calls[0].code).toBe(401);
  });

  it("403 when the admin key is configured but wrong", () => {
    const { nexted, calls } = run(
      requireAdminKey,
      makeReq({ "x-po-admin-key": "nope" }),
    );
    expect(nexted).toBe(false);
    expect(calls[0].code).toBe(403);
  });

  it("passes with the correct admin key", () => {
    const { nexted } = run(
      requireAdminKey,
      makeReq({ "x-po-admin-key": "real-admin-key" }),
    );
    expect(nexted).toBe(true);
  });

  it("404 (disabled) when hosted and no key is configured", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "";
    secretsMock.value.PO_HEALTH_HOSTED = true;
    const { nexted, calls } = run(requireAdminKey, makeReq());
    expect(nexted).toBe(false);
    expect(calls[0].code).toBe(404);
  });

  it("passes loopback in dev when no key is configured", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "";
    secretsMock.value.PO_HEALTH_HOSTED = false;
    const { nexted } = run(requireAdminKey, makeReq({}, "127.0.0.1"));
    expect(nexted).toBe(true);
  });

  it("403 for a remote caller in dev when no key is configured", () => {
    secretsMock.value.PO_HEALTH_ADMIN_KEY = "";
    secretsMock.value.PO_HEALTH_HOSTED = false;
    const { nexted, calls } = run(requireAdminKey, makeReq({}, "203.0.113.9"));
    expect(nexted).toBe(false);
    expect(calls[0].code).toBe(403);
  });
});
