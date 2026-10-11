import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * poAuthManager shells out to the Python refresher (no Node browser). These
 * tests mock `child_process` + `fs` + `poAlert` so the whole orchestration,
 * parsing, circuit-breaker, challenge interlock and health-snapshot surface is
 * verified WITHOUT a browser, network, SSID or real alerts.
 */

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

const existsMock = vi.hoisted(() => vi.fn());
vi.mock("fs", () => ({
  existsSync: existsMock,
  readFileSync: vi.fn(() => "{}"),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

const secretsMock = vi.hoisted(() => {
  const value: Record<string, unknown> = {
    POCKET_BRIDGE_PYTHON: "",
    POCKET_BRIDGE_HOST: "127.0.0.1",
    POCKET_BRIDGE_PORT: 8788,
    PO_EMAIL: "",
    PO_PASSWORD: "",
    PO_EMAIL_FILE: "",
    PO_PASSWORD_FILE: "",
    PO_EMAIL_LOGIN: "false",
    PO_LOGIN_TIMEOUT: 45,
    PO_AUTH_NODE_TRIGGER: "false",
    PO_TOS_CONSENT: "true",
    PO_HEALTH_ADMIN_KEY: "",
    PO_ALERT_EMAIL: "",
  };
  return { value };
});
vi.mock("../../config/secrets", () => ({
  secrets: secretsMock.value,
  default: secretsMock.value,
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const poAlertMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/poAlert", () => ({ poAlert: poAlertMock }));

import { PoAuthManager, maskSecret } from "../../services/poAuthManager";

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function mockSpawnOnce(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): void {
  spawnMock.mockImplementation(() => {
    const proc = fakeProc();
    process.nextTick(() => {
      if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
      proc.emit("close", opts.code ?? 0);
    });
    return proc;
  });
}

/** The env the refresher was actually spawned with. */
function lastSpawnEnv(): Record<string, string | undefined> {
  return spawnMock.mock.calls[0][2].env;
}

const manager = PoAuthManager.getInstance();

beforeEach(() => {
  spawnMock.mockReset();
  poAlertMock.mockReset();
  existsMock.mockReset();
  existsMock.mockImplementation(
    (p: string) =>
      String(p).endsWith("refresh_ssid.py") ||
      String(p).endsWith("po_session.json"),
  );
  secretsMock.value.PO_EMAIL = "";
  secretsMock.value.PO_PASSWORD = "";
  secretsMock.value.PO_EMAIL_FILE = "";
  secretsMock.value.PO_PASSWORD_FILE = "";
  secretsMock.value.PO_EMAIL_LOGIN = "false";
  secretsMock.value.PO_AUTH_NODE_TRIGGER = "false";
  secretsMock.value.PO_TOS_CONSENT = "true";
  secretsMock.value.POCKET_BRIDGE_PYTHON = "";
  manager.resetBreaker("test setup");
});

describe("credential fallback posture", () => {
  it("is unavailable by default (opt-in required)", () => {
    expect(manager.isCredentialFallbackAvailable()).toBe(false);
  });

  it("is unavailable when the flag is on but a half is missing", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "true";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "";
    expect(manager.isCredentialFallbackAvailable()).toBe(false);
  });

  it("is available when enabled AND fully configured AND consent recorded", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "1";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    expect(manager.isCredentialFallbackAvailable()).toBe(true);
  });

  it("is unavailable without the recorded written ToS consent ([482])", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "1";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    secretsMock.value.PO_TOS_CONSENT = "";
    expect(manager.isCredentialFallbackAvailable()).toBe(false);
    expect(manager.hasTosConsent()).toBe(false);
  });

  it("snapshot masks the email and never leaks the password", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "true";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    const snap = manager.buildSnapshot();
    expect(snap.credentialFallback.available).toBe(true);
    expect(snap.credentialFallback.tosConsent).toBe(true);
    expect(snap.credentialFallback.emailMasked).toBe("tra***");
    expect(JSON.stringify(snap)).not.toContain("s3cret");
    expect(JSON.stringify(snap)).not.toContain("trader@example.com");
  });
});

describe("refresh orchestration", () => {
  it("parses REFRESH_METHOD=credential_login from the refresher output", async () => {
    mockSpawnOnce({
      stdout:
        "LOGIN_ATTEMPTED=1\n" +
        "captured ssid=abc*** after 2.0s\n" +
        "REFRESH_METHOD=credential_login\n" +
        "SUCCESS: updated po_session.json and .env\n",
      code: 0,
    });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(true);
    expect(result.method).toBe("credential_login");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(String(cmd).length).toBeGreaterThan(0);
    expect(String(args[0])).toMatch(/refresh_ssid\.py$/);
  });

  it("defaults to the session tier on a clean exit with no method token", async () => {
    mockSpawnOnce({ stdout: "captured ssid=abc*** after 1.0s\n", code: 0 });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(true);
    expect(result.method).toBe("session");
  });

  it("reports SESSION_EXPIRED as a failed refresh", async () => {
    mockSpawnOnce({
      stderr:
        "FAILURE: no auth frame captured\n" +
        "SESSION_EXPIRED — re-run capture_session.py\n",
      code: 1,
    });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
    expect(result.error).toContain("SESSION_EXPIRED");
  });

  it("degrades cleanly when the refresher script is missing", async () => {
    existsMock.mockReturnValue(false);
    const result = await manager.refresh("test");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("records the last outcome on the snapshot", async () => {
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\nSUCCESS: updated\n", code: 0 });
    await manager.refresh("startup");
    const snap = manager.buildSnapshot();
    expect(snap.refresh.lastOk).toBe(true);
    expect(snap.refresh.lastMethod).toBe("session");
    expect(snap.refresh.lastReason).toBe("startup");
    expect(snap.refresh.lastAt).not.toBeNull();
  });
});

describe("credential isolation ([480] — only the refresher sees them)", () => {
  it("withoutPoCredentials strips every PO credential var", () => {
    const base: Record<string, string | undefined> = {
      PO_EMAIL: "a@b.c",
      PO_PASSWORD: "pw",
      PO_EMAIL_LOGIN: "true",
      PO_LOGIN_TIMEOUT: "45",
      PO_TOS_CONSENT: "true",
      PATH: "/usr/bin",
    };
    const out = manager.withoutPoCredentials(base);
    expect(out.PO_EMAIL).toBeUndefined();
    expect(out.PO_PASSWORD).toBeUndefined();
    expect(out.PO_EMAIL_LOGIN).toBeUndefined();
    expect(out.PO_TOS_CONSENT).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("the refresher spawn env carries the credential vars", async () => {
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\nSUCCESS\n", code: 0 });
    await manager.refresh("test");
    const env = lastSpawnEnv();
    expect(env.PO_EMAIL).toBe("trader@example.com");
    expect(env.PO_PASSWORD).toBe("s3cret");
  });

  it("credentials travel via spawn env, never argv", async () => {
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\n", code: 0 });
    await manager.refresh("test");
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(String(args).includes("s3cret")).toBe(false);
    expect(String(args).includes("trader@example.com")).toBe(false);
    // The ONLY credential channel is the child env.
    expect(opts.env.PO_PASSWORD).toBe("s3cret");
    expect(opts.env.PO_EMAIL).toBe("trader@example.com");
  });
});

describe("circuit breaker ([480])", () => {
  it("opens after 3 consecutive failed logins, blocks auto-refresh, alerts, human resets", async () => {
    for (let i = 1; i <= 3; i += 1) {
      mockSpawnOnce({
        stdout: "LOGIN_ATTEMPTED=1\n",
        stderr: `FAILURE: login attempt ${i} failed\n`,
        code: 1,
      });
      await manager.refresh(`login-fail-${i}`);
    }
    const snap = manager.buildSnapshot();
    expect(snap.circuit.consecutiveLoginFailures).toBe(3);
    expect(snap.circuit.open).toBe(true);
    expect(snap.circuit.reason).toBe("max_login_failures");
    expect(poAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "critical" }),
    );

    // AUTO path refuses while the circuit is open.
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "true";
    const beforeCircuitBlock = spawnMock.mock.calls.length;
    await manager.maybeAutoRefresh("relay_session_expired");
    expect(spawnMock.mock.calls.length).toBe(beforeCircuitBlock);

    // A HUMAN reset is required.
    manager.resetBreaker("operator");
    expect(manager.buildSnapshot().circuit.open).toBe(false);
    expect(manager.buildSnapshot().circuit.consecutiveLoginFailures).toBe(0);
  });

  it("does not open the circuit on session-tier failures (no login attempted)", async () => {
    for (let i = 0; i < 5; i += 1) {
      mockSpawnOnce({
        stderr: "SESSION_EXPIRED — re-run capture_session.py\n",
        code: 1,
      });
      await manager.refresh("session-fail");
    }
    const snap = manager.buildSnapshot();
    expect(snap.circuit.open).toBe(false);
    expect(snap.circuit.consecutiveLoginFailures).toBe(0);
  });

  it("a successful credential_login closes the circuit", async () => {
    for (let i = 0; i < 3; i += 1) {
      mockSpawnOnce({ stdout: "LOGIN_ATTEMPTED=1\n", stderr: "fail\n", code: 1 });
      await manager.refresh("f");
    }
    expect(manager.buildSnapshot().circuit.open).toBe(true);
    mockSpawnOnce({
      stdout:
        "LOGIN_ATTEMPTED=1\nREFRESH_METHOD=credential_login\nSUCCESS\n",
      code: 0,
    });
    await manager.refresh("f");
    const snap = manager.buildSnapshot();
    expect(snap.circuit.open).toBe(false);
    expect(snap.circuit.consecutiveLoginFailures).toBe(0);
  });
});

describe("challenge interlock ([480] — captcha/2FA, never retry)", () => {
  it("detects CHALLENGE_DETECTED=captcha, halts auto-refresh, alerts, human resets", async () => {
    mockSpawnOnce({
      stdout: "LOGIN_ATTEMPTED=1\nCHALLENGE_DETECTED=captcha\n",
      stderr: "SELF_HEALING_STOPPED — automated login halted\n",
      code: 3,
    });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("challenge");

    const snap = manager.buildSnapshot();
    expect(snap.circuit.challengeDetected).toBe(true);
    expect(snap.circuit.open).toBe(true);
    expect(snap.circuit.reason).toBe("captcha_or_2fa");
    expect(poAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "critical" }),
    );

    // NEVER auto-retried.
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "true";
    const beforeChallengeBlock = spawnMock.mock.calls.length;
    await manager.maybeAutoRefresh("relay_session_expired");
    expect(spawnMock.mock.calls.length).toBe(beforeChallengeBlock);

    // Even a later session-tier OK must not silently clear the interlock.
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\nSUCCESS\n", code: 0 });
    await manager.refresh("manual-check");
    expect(manager.buildSnapshot().circuit.challengeDetected).toBe(true);
    expect(manager.buildSnapshot().circuit.open).toBe(true);

    // Human reset after a manual login clears it.
    manager.resetBreaker("operator after manual login");
    expect(manager.buildSnapshot().circuit.challengeDetected).toBe(false);
  });
});

describe("exponential backoff ([480])", () => {
  it("skips auto-refresh until backoff elapses; force bypasses", async () => {
    mockSpawnOnce({ stderr: "fail\n", code: 1 });
    await manager.refresh("fail");
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "true";
    const before = spawnMock.mock.calls.length;
    await manager.maybeAutoRefresh("relay_session_expired");
    expect(spawnMock.mock.calls.length).toBe(before); // backed off
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\n", code: 0 });
    await manager.maybeAutoRefresh("relay_session_expired", { force: true });
    expect(spawnMock.mock.calls.length).toBe(before + 1);
  });

  it("reports an increasing backoff on the snapshot", async () => {
    mockSpawnOnce({ stderr: "fail\n", code: 1 });
    await manager.refresh("fail");
    const first = manager.buildSnapshot().circuit.backoffMs;
    expect(first).toBeGreaterThanOrEqual(60_000);
    mockSpawnOnce({ stderr: "fail\n", code: 1 });
    await manager.refresh("fail2");
    expect(manager.buildSnapshot().circuit.backoffMs).toBeGreaterThan(first);
  });
});

describe("auth-failure auto trigger", () => {
  it("is a no-op unless PO_AUTH_NODE_TRIGGER is enabled", async () => {
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "false";
    await manager.maybeAutoRefresh("relay_session_expired");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("triggers a refresh when explicitly enabled", async () => {
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "true";
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\n", code: 0 });
    await manager.maybeAutoRefresh("relay_session_expired", { force: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("maskSecret", () => {
  it("keeps only the leading characters", () => {
    expect(maskSecret("trader@example.com", 3)).toBe("tra***");
    expect(maskSecret("", 3)).toBe("");
  });
});