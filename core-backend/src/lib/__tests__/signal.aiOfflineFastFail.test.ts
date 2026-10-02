/**
 * PART 32.5a [262] — a dead AI Engine must fail fast, not burn the retry ladder.
 *
 * THE BUG THIS PINS: `isTransientAiFailure` matched every error with no HTTP
 * response, which included ECONNREFUSED. With :8000 down that meant 3 attempts
 * plus 500ms/1000ms of backoff — measured at 12,280ms of stall on every single
 * page load, because /predict is called on mount. Worse, each attempt held a
 * socket from a shared agent capped at maxSockets: 16, so ~25 concurrently
 * queued requests reproduced the observed 300s page load.
 *
 * A refused connection is not a transient state to ride out: nothing is
 * listening on the port. An engine that is genuinely *starting up* already has
 * its socket bound and answers 503, which IS still retried.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import axios from "axios";

import {
  isTransientAiFailure,
  postWithRetry,
  classifyAiEngineFailure,
} from "../../controllers/signal.controller";

/** Build an axios-shaped transport error with no HTTP response. */
function transportError(code: string): unknown {
  const err = new Error(`Request failed with error code ${code}`) as any;
  err.isAxiosError = true;
  err.code = code;
  err.request = {};
  err.response = undefined;
  err.config = {};
  err.toJSON = () => ({ code });
  return err;
}

/** Build an axios-shaped error carrying an upstream HTTP status. */
function httpError(status: number): unknown {
  const err = new Error(`Request failed with status code ${status}`) as any;
  err.isAxiosError = true;
  err.response = { status, statusText: "", data: {}, headers: {}, config: {} };
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PART 32.5a [262] — definitive connection failures are never retried", () => {
  it.each([
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
  ])("%s is definitive: not transient, so no retry is attempted", (code) => {
    expect(isTransientAiFailure(transportError(code))).toBe(false);
  });

  it.each(["ECONNABORTED", "ETIMEDOUT"])(
    "%s is genuinely transient (engine up but slow): still retried",
    (code) => {
      expect(isTransientAiFailure(transportError(code))).toBe(true);
    },
  );

  it.each([429, 500, 502, 503])("HTTP %i is transient and still retried", (status) => {
    expect(isTransientAiFailure(httpError(status))).toBe(true);
  });

  it.each([400, 401, 404, 422])("HTTP %i is permanent and never retried", (status) => {
    expect(isTransientAiFailure(httpError(status))).toBe(false);
  });

  it("a no-response error with no recognizable code still retries", () => {
    expect(isTransientAiFailure(transportError("SOMETHING_ELSE"))).toBe(true);
  });

  it("classifies a refusal as 'unreachable' so the UI can show an offline state", () => {
    const classified = classifyAiEngineFailure(transportError("ECONNREFUSED"));
    expect(classified.kind).toBe("unreachable");
    expect(classified.code).toBe("ECONNREFUSED");
    // This detail string is what the page surfaces, so it must name the port.
    expect(classified.detail).toMatch(/8000/);
    expect(classified.detail).toMatch(/not up/i);
  });
});

describe("PART 32.5a [262] — retry ladder does no work for a dead engine", () => {
  it("makes exactly ONE attempt against a refused connection", async () => {
    const post = vi.spyOn(axios, "post").mockRejectedValue(transportError("ECONNREFUSED"));
    await expect(postWithRetry("http://127.0.0.1:8000/x", {}, {})).rejects.toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1); // was 3
  });

  it("still retries a 503, because that engine is bound and booting", async () => {
    const post = vi.spyOn(axios, "post").mockRejectedValue(httpError(503));
    await expect(
      postWithRetry("http://127.0.0.1:8000/x", {}, {}, 3),
    ).rejects.toBeTruthy();
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("a refused connection resolves with no backoff sleep at all", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.spyOn(axios, "post").mockRejectedValue(transportError("ECONNREFUSED"));
      const p = postWithRetry("http://127.0.0.1:8000/x", {}, {}, 3);
      // Attach the rejection handler synchronously so the settle below is not
      // reported as an unhandled rejection.
      const settled = expect(p).rejects.toBeTruthy();
      // Any backoff would leave this pending until the clock advanced.
      await vi.advanceTimersByTimeAsync(0);
      await settled;
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});