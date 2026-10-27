import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  secrets: { AUTH_REQUIRED: false },
  verifyToken: vi.fn(),
}));

vi.mock("../../config/secrets", () => ({ secrets: state.secrets }));
vi.mock("../../services/auth.service", () => ({
  authService: { verifyToken: state.verifyToken },
}));

import {
  authMiddleware,
  requireUserAuth,
} from "../../middlewares/auth.middleware";

function req(headers: Record<string, string> = {}) {
  return { headers } as any;
}
function res() {
  const out: any = {};
  out.status = vi.fn(() => out);
  out.json = vi.fn(() => out);
  return out;
}

beforeEach(() => {
  state.secrets.AUTH_REQUIRED = false;
  state.verifyToken.mockReset();
});

describe("authMiddleware", () => {
  it("normalizes the signed userId claim onto req.user.id", () => {
    state.verifyToken.mockReturnValue({ userId: "usr_1", email: "a@b.c" });
    const request = req({ authorization: "Bearer token" });
    const next = vi.fn();

    authMiddleware(request, res(), next);

    expect(request.user.id).toBe("usr_1");
    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts id/sub claims and rejects an unusable payload", () => {
    state.verifyToken.mockReturnValue({ id: "usr_2" });
    const request = req({ authorization: "Bearer token" });
    authMiddleware(request, res(), vi.fn());
    expect(request.user.id).toBe("usr_2");

    const rejected = res();
    state.verifyToken.mockReturnValue({ email: "no-id@example.com" });
    authMiddleware(req({ authorization: "Bearer token" }), rejected, vi.fn());
    expect(rejected.status).toHaveBeenCalledWith(401);
  });
});

describe("requireUserAuth", () => {
  it("permits the legacy local default only when auth is not required", () => {
    const next = vi.fn();
    requireUserAuth(req(), res(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed with no bearer token in production", () => {
    state.secrets.AUTH_REQUIRED = true;
    const response = res();
    const next = vi.fn();

    requireUserAuth(req(), response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("always verifies a supplied token, even when auth is optional", () => {
    const response = res();
    const next = vi.fn();
    state.verifyToken.mockReturnValue(null);

    requireUserAuth(req({ authorization: "Bearer bad" }), response, next);

    expect(state.verifyToken).toHaveBeenCalledWith("bad");
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
