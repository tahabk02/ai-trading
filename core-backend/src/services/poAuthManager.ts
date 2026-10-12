/**
 * poAuthManager.ts — Pocket Option SSID SELF-HEALING ORCHESTRATOR (thin layer)
 *
 * ARCHITECTURE (why this is intentionally small):
 * The actual SSID capture/refresh is a Playwright job that ALREADY lives on the
 * Python side (`pocket-bridge/session/refresh_ssid.py`), reusing the very same
 * interpreter/venv the bridge itself runs in. This backend module does NOT
 * drive a browser — it owns the observable posture, the guarded trigger, and
 * the safety interlocks.
 *
 * PART 43.6 [480] credential posture (audited): the PO_EMAIL/PO_PASSWORD/
 * PO_TOS_CONSENT values are forwarded to the REFRESHER child ONLY — never to
 * the bridge, never to a request handler, logs, /health, or process args.
 * See `withoutPoCredentials()`.
 *
 * RECOVERY TIERS (implemented in refresh_ssid.py):
 *   - SESSION (preferred): reuse `po_session.json` headlessly. No credentials.
 *   - CREDENTIAL LOGIN (last resort): requires PO_EMAIL_LOGIN=1 + PO_EMAIL +
 *     PO_PASSWORD + a recorded written PO_EMAIL_TOS_CONSENT (PART 43.6 [482]).
 *
 * SAFETY INTERLOCKS (PART 43.6 [480]):
 *   - CIRCUIT BREAKER: 3 consecutive failed credential logins open the circuit
 *     (auto-refresh halts, an alert fires, a human must reset);
 *   - CHALLENGE INTERLOCK: a captcha/2FA signal halts auto-login FOREVER until
 *     a human resets (never auto-retried);
 *   - EXPONENTIAL BACKOFF (60s base, 2×, capped at 30 min) replaces the old
 *     fixed 120 s auto-trigger window.
 *   - The refresh/reset POST routes are gated (PO_HEALTH_ADMIN_KEY or
 *     loopback-only); GET /health/po-auth stays read-only.
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { poAlert } from "./poAlert";

export type PoAuthRefreshMethod = "session" | "credential_login" | "none";
export type PoAuthCircuitReason = "max_login_failures" | "captcha_or_2fa" | null;

export interface PoAuthRefreshResult {
  ok: boolean;
  method: PoAuthRefreshMethod;
  durationMs: number;
  reason: string;
  error?: string;
}

export interface PoAuthSnapshot {
  credentialFallback: {
    enabled: boolean;
    configured: boolean;
    available: boolean;
    tosConsent: boolean;
    emailMasked: string | null;
  };
  session: {
    filePresent: boolean;
    ageDays: number | null;
  };
  refreshScript: {
    present: boolean;
    path: string;
    python: string;
  };
  refresh: {
    inFlight: boolean;
    lastAt: string | null;
    lastOk: boolean | null;
    lastMethod: PoAuthRefreshMethod | null;
    lastReason: string | null;
    lastError: string | null;
  };
  circuit: {
    open: boolean;
    reason: PoAuthCircuitReason;
    consecutiveLoginFailures: number;
    challengeDetected: boolean;
    autoRetryAt: string | null;
    backoffMs: number;
  };
  nodeTriggerEnabled: boolean;
  timestamp: string;
}

const REFRESH_TIMEOUT_MS = 180_000;
/** PART 43.6 [480] — exponential backoff, not a fixed 120 s window. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
/** 3 consecutive failed LOGINS stop auto-retry and require a human. */
const MAX_CONSECUTIVE_LOGIN_FAILURES = 3;
const METHOD_RE = /REFRESH_METHOD=(session|credential_login)\b/;
const CHALLENGE_RE = /CHALLENGE_DETECTED=(captcha|2fa|unknown)\b/i;
const LOGIN_ATTEMPTED_RE = /LOGIN_ATTEMPTED=1\b/;

function asBool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

/** Mask a secret to its first `head` characters — never a full value. */
export function maskSecret(value: string | undefined, head = 3): string {
  const s = String(value || "");
  if (!s) return "";
  return s.length <= head ? `${s[0] || ""}***` : `${s.slice(0, head)}***`;
}

export class PoAuthManager {
  private static instance: PoAuthManager;

  private readonly bridgeDir: string;
  private readonly refreshScriptPath: string;
  private readonly sessionPath: string;
  private readonly pythonPath: string;

  private inFlight = false;
  private lastRefreshAt = 0;
  private lastOk: boolean | null = null;
  private lastMethod: PoAuthRefreshMethod | null = null;
  private lastReason: string | null = null;
  private lastError: string | null = null;

  // ── Circuit breaker / interlock state (PART 43.6 [480]) ──
  private consecutiveLoginFailures = 0;
  private consecutiveRefreshFailures = 0;
  private circuitOpen = false;
  private circuitReason: PoAuthCircuitReason = null;
  private challengeDetected = false;
  private lastAttemptAt = 0;

  private constructor() {
    this.bridgeDir = resolve(__dirname, "../../../pocket-bridge");
    this.refreshScriptPath = join(this.bridgeDir, "session", "refresh_ssid.py");
    this.sessionPath = join(this.bridgeDir, "session", "po_session.json");
    this.pythonPath = PoAuthManager.resolvePython(this.bridgeDir);
  }

  public static getInstance(): PoAuthManager {
    if (!PoAuthManager.instance) {
      PoAuthManager.instance = new PoAuthManager();
    }
    return PoAuthManager.instance;
  }

  private static resolvePython(bridgeDir: string): string {
    if (secrets.POCKET_BRIDGE_PYTHON && secrets.POCKET_BRIDGE_PYTHON.trim()) {
      return secrets.POCKET_BRIDGE_PYTHON.trim();
    }
    const repoRoot = resolve(bridgeDir, "..");
    const candidates = [
      join(repoRoot, ".venv-1", "Scripts", "python.exe"),
      join(repoRoot, ".venv-1", "bin", "python"),
      join(bridgeDir, ".venv", "Scripts", "python.exe"),
      join(bridgeDir, ".venv", "bin", "python"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return process.platform === "win32" ? "python" : "python3";
  }

  /**
   * The credential enV is only usable when ALL gates pass: opted-in
   * (PO_EMAIL_LOGIN), both halves present, AND the written Pocket Option
   * answer on automated login recorded (PO_TOS_CONSENT, PART 43.6 [482]).
   */
  public isCredentialFallbackAvailable(): boolean {
    const configured = Boolean(
      (secrets.PO_EMAIL || "").trim() && (secrets.PO_PASSWORD || "").trim(),
    );
    return configured && asBool(secrets.PO_EMAIL_LOGIN) && this.hasTosConsent();
  }

  /** PART 43.6 [482] — gates the credential tier: no recorded consent, no login. */
  public hasTosConsent(): boolean {
    const v = (secrets.PO_TOS_CONSENT || "").trim();
    return v !== "" && asBool(v);
  }

  /**
   * Copy of `base` with the PO credential vars REMOVED. The bridge is spawned
   * with this so a credential configured at the backend layer never reaches a
   * process that does not need it (PART 43.6 [480]).
   */
  public withoutPoCredentials(
    base: Record<string, string | undefined> = process.env,
  ): Record<string, string | undefined> {
    const copy: Record<string, string | undefined> = { ...base };
    delete copy.PO_EMAIL;
    delete copy.PO_PASSWORD;
    delete copy.PO_EMAIL_LOGIN;
    delete copy.PO_LOGIN_TIMEOUT;
    delete copy.PO_TOS_CONSENT;
    return copy;
  }

  /** The ONLY child that receives the credential is `refresh_ssid.py`. */
  private credentialEnv(): Record<string, string> {
    return {
      PO_EMAIL: secrets.PO_EMAIL || "",
      PO_PASSWORD: secrets.PO_PASSWORD || "",
      PO_EMAIL_LOGIN: secrets.PO_EMAIL_LOGIN || "false",
      PO_LOGIN_TIMEOUT: String(secrets.PO_LOGIN_TIMEOUT || 45),
      PO_TOS_CONSENT: secrets.PO_TOS_CONSENT || "",
    };
  }

  private sessionAgeDays(): number | null {
    if (!existsSync(this.sessionPath)) return null;
    try {
      const metaPath = join(this.bridgeDir, "session", "po_session.meta.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
          captured_at?: string;
        };
        if (meta.captured_at) {
          const ms = Date.parse(meta.captured_at);
          if (Number.isFinite(ms)) {
            return Math.max(0, (Date.now() - ms) / 86_400_000);
          }
        }
      }
      const ageMs = Date.now() - statSync(this.sessionPath).mtimeMs;
      return Math.max(0, ageMs / 86_400_000);
    } catch {
      return null;
    }
  }

  private currentBackoffMs(): number {
    const exp = Math.min(this.consecutiveRefreshFailures, 5);
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exp);
  }

  /** Read-only snapshot of the auth posture for /health. Never mutates state. */
  public buildSnapshot(): PoAuthSnapshot {
    const configured = Boolean(
      (secrets.PO_EMAIL || "").trim() && (secrets.PO_PASSWORD || "").trim(),
    );
    const enabled = asBool(secrets.PO_EMAIL_LOGIN);
    const tosConsent = this.hasTosConsent();
    return {
      credentialFallback: {
        enabled,
        configured,
        available: enabled && configured && tosConsent,
        tosConsent,
        emailMasked: maskSecret(secrets.PO_EMAIL, 3) || null,
      },
      session: {
        filePresent: existsSync(this.sessionPath),
        ageDays: this.sessionAgeDays(),
      },
      refreshScript: {
        present: existsSync(this.refreshScriptPath),
        path: this.refreshScriptPath,
        python: this.pythonPath,
      },
      refresh: {
        inFlight: this.inFlight,
        lastAt:
          this.lastRefreshAt > 0
            ? new Date(this.lastRefreshAt).toISOString()
            : null,
        lastOk: this.lastOk,
        lastMethod: this.lastMethod,
        lastReason: this.lastReason,
        lastError: this.lastError,
      },
      circuit: {
        open: this.circuitOpen,
        reason: this.circuitReason,
        consecutiveLoginFailures: this.consecutiveLoginFailures,
        challengeDetected: this.challengeDetected,
        autoRetryAt:
          this.lastAttemptAt > 0
            ? new Date(this.lastAttemptAt + this.currentBackoffMs()).toISOString()
            : null,
        backoffMs: this.currentBackoffMs(),
      },
      nodeTriggerEnabled: asBool(secrets.PO_AUTH_NODE_TRIGGER),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run `refresh_ssid.py` (session tier, then last-resort credential tier) and
   * record the outcome. Never throws: a spawn failure degrades to
   * `{ ok: false }` so a health probe or an auth-failure hook can never crash
   * the request/ingestion path.
   *
   * This is the MANUAL/operator path (the guarded POST endpoint) — it may run
   * while the circuit is open, which is exactly what "require a human" needs.
   * The AUTO path (`maybeAutoRefresh`) refuses to run while the circuit is
   * open or a challenge interlock is set.
   */
  public async refresh(
    reason = "manual",
    opts?: { humanReset?: boolean },
  ): Promise<PoAuthRefreshResult> {
    if (this.inFlight) {
      return {
        ok: false,
        method: "none",
        durationMs: 0,
        reason,
        error: "refresh already in progress",
      };
    }
    if (!existsSync(this.refreshScriptPath)) {
      const error = `refresh_ssid.py not found at ${this.refreshScriptPath}`;
      logger.warn("[PO Auth] %s", error);
      this.recordLast(false, "none", reason, error);
      return { ok: false, method: "none", durationMs: 0, reason, error };
    }

    if (opts?.humanReset) {
      this.resetBreaker("manual human reset");
    }

    this.inFlight = true;
    const startedAt = Date.now();
    logger.info("[PO Auth] Refreshing SSID via refresh_ssid.py", {
      reason,
      python: this.pythonPath,
      credentialFallback: this.isCredentialFallbackAvailable(),
    });

    try {
      const { code, stdout, stderr } = await this.runScript();
      const durationMs = Date.now() - startedAt;
      const method = this.parseMethod(stdout, code);
      const ok = code === 0;
      const challenge = this.parseChallenge(stdout, stderr);
      const loginAttempted = LOGIN_ATTEMPTED_RE.test(stdout || "");
      const error = ok
        ? undefined
        : this.summariseFailure(stderr || stdout, code, challenge);
      this.applyOutcome({ ok, method, loginAttempted, challenge });
      this.recordLast(ok, method, reason, error, durationMs);
      logger[ok ? "info" : "warn"](
        "[PO Auth] Refresh %s method=%s durationMs=%d%s",
        ok ? "succeeded" : "failed",
        method,
        durationMs,
        error ? ` error=${error}` : "",
      );
      return { ok, method, durationMs, reason, error };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof Error ? err.message : String(err);
      this.recordLast(false, "none", reason, error, durationMs);
      logger.error("[PO Auth] Refresh crashed", { reason, error });
      return { ok: false, method: "none", durationMs, reason, error };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Circuit-breaker + interlock bookkeeping AFTER a refresh attempt.
   * PART 43.6 [480]: 3 consecutive failed credential logins open the circuit;
   * a captcha/2FA challenge halts auto-login permanently until a human reset.
   */
  private applyOutcome(args: {
    ok: boolean;
    method: PoAuthRefreshMethod;
    loginAttempted: boolean;
    challenge: string | null;
  }): void {
    this.lastAttemptAt = Date.now();

    if (args.challenge) {
      this.challengeDetected = true;
      this.circuitOpen = true;
      this.circuitReason = "captcha_or_2fa";
      void poAlert({
        level: "critical",
        title: "[PO Auth] CAPTCHA/2FA — automated login stopped, human required",
        message:
          `The Pocket Option login hit an anti-bot challenge (${args.challenge}). ` +
          "Auto-retry is halted (never retried). After a MANUAL login, reset via " +
          "POST /health/po-auth/reset.",
      });
      return;
    }

    if (args.ok) {
      this.consecutiveRefreshFailures = 0;
      if (args.method === "credential_login") {
        this.consecutiveLoginFailures = 0;
        this.circuitOpen = false;
        this.circuitReason = null;
      } else if (this.circuitReason === "max_login_failures") {
        // A healthy session-tier refresh means the account works again.
        this.consecutiveLoginFailures = 0;
        this.circuitOpen = false;
        this.circuitReason = null;
      }
      return;
    }

    this.consecutiveRefreshFailures += 1;
    if ((args.loginAttempted || args.method === "credential_login") && !args.ok) {
      this.consecutiveLoginFailures += 1;
      if (this.consecutiveLoginFailures >= MAX_CONSECUTIVE_LOGIN_FAILURES) {
        this.circuitOpen = true;
        this.circuitReason = "max_login_failures";
        void poAlert({
          level: "critical",
          title:
            "[PO Auth] 3 consecutive login failures — circuit opened, human reset required",
          message:
            "The last-resort credential login failed 3 times in a row. " +
            "Auto-refresh is halted. Investigate, then reset via " +
            "POST /health/po-auth/reset.",
        });
      }
    }
  }

  /**
   * Best-effort AUTO trigger for the relay's auth-failure event. Refuses to run
   * while the circuit is open or a challenge interlock is set, and backs off
   * exponentially (PART 43.6 [480]) instead of a fixed window.
   * No-op unless PO_AUTH_NODE_TRIGGER is enabled (the Python bridge already
   * handles auth-failure refresh itself). `opts.force` bypasses backoff.
   */
  public async maybeAutoRefresh(
    reason = "auth_failed",
    opts?: { force?: boolean },
  ): Promise<void> {
    if (!asBool(secrets.PO_AUTH_NODE_TRIGGER)) return;
    if (this.circuitOpen || this.challengeDetected) {
      logger.warn(
        "[PO Auth] Auto-refresh blocked by %s",
        this.challengeDetected ? "challenge interlock" : "open circuit breaker",
      );
      return;
    }
    if (this.inFlight) return;
    const sinceLast = Date.now() - this.lastAttemptAt;
    if (!opts?.force && this.lastAttemptAt > 0 && sinceLast < this.currentBackoffMs()) {
      logger.debug("[PO Auth] Auto-refresh skipped (exponential backoff)", {
        sinceLastMs: sinceLast,
        backoffMs: this.currentBackoffMs(),
      });
      return;
    }
    await this.refresh(reason);
  }

  /**
   * HUMAN-ONLY reset. Clears the circuit breaker, the login-failure counter and
   * the challenge interlock after an operator has investigated (POST
   * /health/po-auth/reset, guard-gated). Never called automatically.
   */
  public resetBreaker(reason = "operator reset"): void {
    const wasOpen =
      this.circuitOpen || this.challengeDetected || this.consecutiveLoginFailures > 0;
    this.consecutiveLoginFailures = 0;
    this.consecutiveRefreshFailures = 0;
    this.circuitOpen = false;
    this.circuitReason = null;
    this.challengeDetected = false;
    if (wasOpen) {
      logger.warn("[PO Auth] Circuit breaker manually reset", { reason });
      void poAlert({
        level: "info",
        title: "[PO Auth] Circuit breaker manually reset",
        message: `Operator reset the PO auth circuit breaker (${reason}).`,
      });
    }
  }

  /** Extract the method token from the refresher's stdout (defaults to the
   *  session tier on a clean exit, since that is the only tier that runs by
   *  default). */
  private parseMethod(stdout: string, code: number): PoAuthRefreshMethod {
    const match = METHOD_RE.exec(stdout || "");
    if (match) return match[1] as PoAuthRefreshMethod;
    return code === 0 ? "session" : "none";
  }

  private parseChallenge(stdout: string, stderr: string): string | null {
    const match = CHALLENGE_RE.exec(`${stdout || ""}\n${stderr || ""}`);
    return match ? match[1].toLowerCase() : null;
  }

  /** One concise, secret-free failure line for the snapshot. */
  private summariseFailure(
    output: string,
    code: number,
    challenge: string | null,
  ): string {
    if (challenge) {
      return `anti-bot challenge (${challenge}) — automated login stopped`;
    }
    const text = (output || "").trim();
    if (!text) return `refresh_ssid.py exited with code ${code}`;
    const line =
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || "";
    return line || `refresh_ssid.py exited with code ${code}`;
  }

  private recordLast(
    ok: boolean,
    method: PoAuthRefreshMethod,
    reason: string,
    error?: string,
    _durationMs = 0,
  ): void {
    this.lastRefreshAt = Date.now();
    this.lastOk = ok;
    this.lastMethod = method;
    this.lastReason = reason;
    this.lastError = error ?? null;
  }

  private runScript(): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(this.pythonPath, [this.refreshScriptPath], {
          cwd: this.bridgeDir,
          // Credentials reach the REFRESHER child and NO other child (PART 43.6
          // [480]). Everything else in the parent env is inherited minus the PO
          // credential vars, so a password can never leak into a sibling.
          env: {
            ...this.withoutPoCredentials(),
            ...this.credentialEnv(),
            PYTHONUNBUFFERED: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* best-effort */
        }
        reject(
          new Error(`refresh_ssid.py timed out after ${REFRESH_TIMEOUT_MS}ms`),
        );
      }, REFRESH_TIMEOUT_MS);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}

export const poAuthManager = PoAuthManager.getInstance();