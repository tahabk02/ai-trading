/**
 * pocketOptionBridge.service.ts — POCKET OPTION LIVE FEED (SSOT) BRIDGE CLIENT
 *
 * 100% REAL DATA. ZERO SYNTHETIC. ZERO FABRICATED PRICES.
 *
 * The Python `pocket-bridge` service connects to Pocket Option with the SSID
 * session cookie, subscribes to raw live ticks, aggregates them into strict
 * M20 (20-second) candles with a last-valid-price hold, and relays everything
 * to this backend over a local WebSocket. This class is the backend-side
 * WebSocket *client* that:
 *
 *   1. AUTO-SPAWNS the Python bridge process via `child_process.spawn`,
 *      capturing and piping stdout/stderr directly to the console so
 *      Python import errors, exit codes, and stack traces are immediately
 *      visible instead of failing silently.
 *   2. Connects to ws://<POCKET_BRIDGE_HOST>:<POCKET_BRIDGE_PORT>
 *      (the Python relay) with automatic reconnect.
 *   3. Implements a CIRCUIT BREAKER with rate-limited retry to completely
 *      stop the spam of continuous "ECONNREFUSED" errors when the bridge
 *      is down — falling back smoothly to live micro-ticks without crashing
 *      the terminal.
 *   4. On a `tick` frame → folds the genuine price into the existing
 *      broadcast → buffer → candle → signal pipeline via
 *      `tickIngestion.ingestTick()` (the same path as Alpaca WS + HTTP poll).
 *   5. On a `candle` frame → forwards the M20 OHLC so the signal engine and
 *      chart stay aligned to the live M20 vector.
 *   6. On a `status` frame → surfaces a clean ONLINE / DEGRADED / awaiting_ssid
 *      state to Socket.IO clients. Never fabricates prices when no SSID is set.
 *   7. READINESS HANDSHAKE — the relay broadcasts a `ready` frame only once the
 *      PO client is authenticated AND the authoritative asset list is loaded.
 *      Subscribes are staged (poArmedByClient) and held until that frame arrives,
 *      so Node never races Python's startup by pushing a subscribe while
 *      active_assets() is still uninitialized.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, join } from "path";
import WebSocket from "ws";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { tickIngestionService } from "./tickIngestion.service";
import { liveTickSignalDispatcher } from "./liveTickSignal.dispatch";
import { forexDataService } from "./forexData.service";
import { realtimeTickBuffer } from "./realtimeTickBuffer.service";
import { websocketService } from "./websocket.service";
import { symbolRegistry } from "./symbolRegistry.service";

// ─── Bridge Process Constants ───
const BRIDGE_PYTHON_MODULE = "pocket_bridge.main";
const BRIDGE_CWD = resolve(__dirname, "../../../pocket-bridge");
const BRIDGE_STARTUP_TIMEOUT_MS = 15_000;
const BRIDGE_HEALTH_CHECK_INTERVAL_MS = 30_000;

// ─── Circuit Breaker Constants ───
const CB_FAILURE_THRESHOLD = 5;
const CB_RESET_TIMEOUT_MS = 60_000;
const CB_MIN_RECONNECT_MS = 2_000;
const CB_MAX_RECONNECT_MS = 60_000;
const CB_RATE_LIMIT_WINDOW_MS = 30_000;
const CB_MAX_ATTEMPTS_PER_WINDOW = 4;

// Max wait for the relay's `ready` (assets-initialised) frame once connected
// before the staged subscribes are flushed anyway — bounded fallback so an
// awaiting_ssid / silent relay never hangs the handshake, never a hard sleep.
const READINESS_FALLBACK_MS = 5_000;

// ── Feed Heartbeat Constants ──
// The Python bridge emits a `heartbeat` frame every 5s. A gap longer than
// HEARTBEAT_STALE_MS means the feed is dead even if the WS transport is still
// up — the client is told `disconnected` (never fabricated live).
const HEARTBEAT_STALE_MS = 12_000;
const FEED_STATUS_WATCHDOG_MS = 5_000;

type FeedStatus =
  | "live"
  | "stalled"
  | "disconnected"
  | "awaiting_ssid"
  | "auth_failed"
  | "degraded";

interface BridgeTickFrame {
  symbol: string;
  asset: string;
  price: number;
  ts_ms: number;
  ts_utc: number;
  /** Monotonic emit counter stamped by the relay (drop detection). */
  seq?: number;
  /** Strict classification stamped by the bridge ("forex"|"otc"|"crypto"). */
  asset_type?: string;
}

interface BridgeCandleFrame {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
  ts_utc: number;
  /** Exact bucket-close ms boundary of the candle (mirrors the bridge ts_ms). */
  ts_ms?: number;
  /** Strict classification stamped by the bridge ("forex"|"otc"|"crypto"). */
  asset_type?: string;
}

/**
 * Coerce any bridge numeric field to a finite number, accepting BOTH the new
 * number frames and the legacy exact-string ("1.15255") frames. This is the
 * zero-drop contract boundary: a string price must never be silently dropped
 * by a naive `typeof x === "number"` check. Returns null when not a usable
 * positive-or-any finite number (sign caller-side for positivity).
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Circuit breaker states: CLOSED = normal, OPEN = failing, HALF_OPEN = probing */
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class PocketOptionBridgeService {
  private static instance: PocketOptionBridgeService;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private connected = false;
  /** True between an 'error' event and its guaranteed 'close' — prevents the
   *  same failed attempt from being counted twice (error + close) and double
   *  fast-forwarding the backoff / tripping the circuit breaker on one drop. */
  private wsErrorSeen = false;
  private lastStatus: "ONLINE" | "DEGRADED" | "awaiting_ssid" | "idle" = "idle";
  /** Raw relay status string ("connected" | "stalled" | "awaiting_ssid" |
   *  "connection_error" | "session_expired" ...) — the precise source for the
   *  feed-status mapping (DEGRADED collapses several relay states). */
  private lastRelayStatus = "idle";
  /** Epoch ms of the last relay `heartbeat` frame (0 = never). */
  private lastHeartbeatAt = 0;
  /** Last feed_status actually broadcast — the watchdog only emits on change. */
  private lastBroadcastFeedStatus: FeedStatus | null = null;
  private feedStatusTimer: NodeJS.Timeout | null = null;
  private readonly url: string;

  /** Symbols a browser/client explicitly asked the relay to arm this session.
   *  Re-pushed on every relay (re)connect so the handshake survives transport
   *  drops without waiting for the next browser subscribe event. */
  private poArmedByClient: Set<string> = new Set();

  /** True only once the relay has broadcast its `ready` frame — meaning the PO
   *  client is authenticated AND the authoritative asset list is loaded. Until
   *  this is set, staged subscribes stay held so we never race Python's init
   *  (active_assets() "Uninitialized ... not initialized yet" transient). */
  private assetsReady = false;
  private readyFallbackTimer: NodeJS.Timeout | null = null;

  // ── Auto-Spawn Process State ──
  private bridgeProcess: ChildProcess | null = null;
  private bridgeAutoSpawn: boolean;
  private bridgePythonPath: string;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private processReady = false;

  /**
   * Set to true when the bridge enters a PERMANENT, non-recoverable degraded
   * state — e.g. the Python dependency `BinaryOptionsToolsV2` is missing or
   * broken, or the bridge fails to launch because the interpreter/module is
   * absent. Reconnecting can never fix these, so we STOP the auto-restart loop
   * and surface a clean actionable status instead. The rest of the platform
   * keeps running normally (no live PO ticks until the env is fixed).
   */
  private permanentlyDegraded = false;

  // ── Circuit Breaker State ──
  private circuitState: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  /** Timestamp-based rate limiter for reconnect attempts */
  private reconnectAttempts: number[] = [];

  private constructor() {
    this.url = `ws://${secrets.POCKET_BRIDGE_HOST}:${secrets.POCKET_BRIDGE_PORT}`;
    this.reconnectDelayMs = secrets.POCKET_BRIDGE_RECONNECT_MS || 5000;
    this.bridgeAutoSpawn = secrets.POCKET_BRIDGE_AUTO_SPAWN !== "false";
    this.bridgePythonPath =
      secrets.POCKET_BRIDGE_PYTHON || this.resolveProjectPython();
  }

  public static getInstance(): PocketOptionBridgeService {
    if (!PocketOptionBridgeService.instance) {
      PocketOptionBridgeService.instance = new PocketOptionBridgeService();
    }
    return PocketOptionBridgeService.instance;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getStatus(): "ONLINE" | "DEGRADED" | "awaiting_ssid" | "idle" {
    return this.lastStatus;
  }

  /**
   * FORCE INITIAL TICK HANDSHAKE — push an ACTIVE subscription for a symbol to
   * the Python relay the moment a browser client (Socket.IO "subscribe" room
   * join) subscribes to it.
   *
   * The bridge arms a dedicated Pocket Option tick reader for the symbol —
   * even completely outside its static startup set — and replies with a
   * `subscribed` confirmation carrying its held price + candles. The backend
   * folds that confirmed price into the real-time ring immediately, so the
   * "WAITING FOR REAL-TIME TICK" lock clears on the handshake itself instead
   * of idling until the first fresh tick frame arrives on a quiet tape.
   */
  public requestSymbolSubscription(symbol: string): void {
    const normalized = forexDataService.toCanonicalSymbol(symbol || "");
    if (!normalized) {
      logger.debug(
        "[PO Bridge] Ignoring subscription push for unresolvable symbol",
        {
          symbol,
        },
      );
      return;
    }
    this.poArmedByClient.add(normalized);
    // Gate on the relay's `ready` frame (assets initialised) — do NOT race
    // Python's startup: flushStagedSubscriptions only sends once assetsReady.
    this.flushStagedSubscriptions();
  }

  public requestSymbolUnsubscription(symbol: string): void {
    const normalized = forexDataService.toCanonicalSymbol(symbol || "");
    if (!normalized) return;
    this.poArmedByClient.delete(normalized);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: "unsubscribe", payload: { symbol: normalized } }),
    );
  }

  /** Push every staged symbol to the relay — but ONLY once the bridge is ready
   *  (assets loaded), so an early subscribe can never hit the "Uninitialized"
   *  active_assets() error on the Python side. */
  private flushStagedSubscriptions(): void {
    if (!this.assetsReady) return;
    for (const symbol of this.poArmedByClient) {
      this.sendSubscribeFrame(symbol);
    }
  }

  /** Bounded fallback (5s) so a relay that never broadcasts `ready` (e.g. no
   *  SSID → awaiting_ssid) still gets its staged subscribes instead of hanging
   *  the handshake forever. The ready frame normally wins and clears this. */
  private armReadinessFallback(): void {
    if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
    this.readyFallbackTimer = setTimeout(() => {
      this.readyFallbackTimer = null;
      if (this.assetsReady) return;
      this.assetsReady = true;
      logger.info(
        "[PO Bridge] Readiness fallback elapsed — flushing staged subscribes",
      );
      this.flushStagedSubscriptions();
    }, READINESS_FALLBACK_MS);
  }

  private sendSubscribeFrame(symbol: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.debug(
        "[PO Bridge] Relay not connected — subscription staged for next connect",
        { symbol },
      );
      return;
    }
    this.ws.send(JSON.stringify({ type: "subscribe", payload: { symbol } }));
    logger.info("[PO Bridge] Subscription push sent to relay", { symbol });
  }

  /** Start the bridge process (if auto-spawn enabled) and connect the WS client. */
  public start(): void {
    // ── STARTUP SSID VALIDITY CHECK (mission [1]) ──
    // Surface the SSID state explicitly at boot: an empty/whitespace SSID is a
    // VALID "awaiting_ssid" configuration (the bridge will never fabricate),
    // but operators must see it clearly instead of hunting for why live PO
    // ticks never arrive. An SSID is never forged or validated beyond
    // presence — the bridge/server probes the live session itself.
    const ssid = secrets.POCKET_OPTION_SSID || "";
    const ssidPresent = typeof ssid === "string" && ssid.trim().length > 0;
    if (!ssidPresent) {
      logger.warn(
        "[PO Bridge] POCKET_OPTION_SSID is not set — running in awaiting_ssid state (real PO live ticks disabled; no fabricated prices). Set POCKET_OPTION_SSID to enable the PO SSOT tier.",
      );
    } else {
      logger.info(
        "[PO Bridge] POCKET_OPTION_SSID is configured — PO SSOT tier enabled",
        {
          ssidLength: ssid.length,
          ssidPrefix: `${ssid.slice(0, 8)}…`,
        },
      );
    }

    if (this.bridgeAutoSpawn) {
      this.spawnBridgeProcess();
    }
    if (this.ws) return;
    this.startFeedStatusWatchdog();
    this.connect();
  }

  /** Stop the WS client, kill the bridge process, and cancel any pending reconnect. */
  public stop(): void {
    if (this.feedStatusTimer) {
      clearInterval(this.feedStatusTimer);
      this.feedStatusTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.readyFallbackTimer) {
      clearTimeout(this.readyFallbackTimer);
      this.readyFallbackTimer = null;
    }
    this.assetsReady = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.connected = false;
    this.killBridgeProcess();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AUTO-SPAWN PYTHON BRIDGE PROCESS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Prefer the project's own virtualenv interpreter (`.venv-1` at the repo
   * root) so the spawned bridge runs with the SAME Python that has
   * `BinaryOptionsToolsV2` installed. This is much more reliable than hunting a
   * system `python`/`py` on PATH, which may be a different interpreter (or a
   * WindowsApps store-alias stub) lacking the required packages. Falls back to
   * `findPython()` only when no venv interpreter exists.
   */
  private resolveProjectPython(): string {
    // `pocket-bridge/` is a direct child of the repo root (which holds the
    // `.venv-1` virtualenv), so one level up from BRIDGE_CWD is the root.
    const repoRoot = resolve(BRIDGE_CWD, "..");
    const exe =
      process.platform === "win32"
        ? join(repoRoot, ".venv-1", "Scripts", "python.exe")
        : join(repoRoot, ".venv-1", "bin", "python");
    if (existsSync(exe)) {
      logger.info("[PO Bridge] Using project virtualenv interpreter", { exe });
      return exe;
    }
    return this.findPython();
  }

  private findPython(): string {
    const candidates = ["python", "python3", "py"];
    for (const cmd of candidates) {
      try {
        // Resolve the command to its ABSOLUTE path. On Windows a bare name
        // like "python" often points to the WindowsApps store-alias stub which
        // child_process.spawn (unlike a shell) cannot launch directly → ENOENT.
        // `where`/`which` returns the real .exe path so spawn works reliably.
        const resolved = execSync(
          process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`,
          { stdio: "pipe", timeout: 5000 },
        )
          .toString()
          .trim()
          .split(/\r?\n/)[0];
        // Prefer a concrete .exe/.cmd/.bat result over a WindowsApps alias.
        const lines = resolved ? [resolved] : [];
        const exe = lines.find((l) => /\.exe$/i.test(l)) || lines[0];
        if (exe) return exe;
      } catch {
        continue;
      }
    }
    return "python";
  }

  private spawnBridgeProcess(): void {
    if (this.bridgeProcess) {
      logger.debug("[PO Bridge] Python bridge process already running");
      return;
    }

    // ── PERMANENT-DEGRADATION GUARD ──
    // Once the bridge is marked permanently degraded (missing dependency, bad
    // interpreter, missing module) we stop trying to spawn it — retrying a
    // broken environment never succeeds and only spams errors.
    if (this.permanentlyDegraded) {
      logger.debug(
        "[PO Bridge] Bridge is permanently degraded — skipping auto-spawn",
      );
      return;
    }

    const bridgeDir = existsSync(BRIDGE_CWD)
      ? BRIDGE_CWD
      : resolve(__dirname, "../../pocket-bridge");

    if (!existsSync(bridgeDir)) {
      logger.error("[PO Bridge] pocket-bridge directory not found", {
        tried: bridgeDir,
      });
      return;
    }

    // Verify the Python module exists
    const moduleFile = join(bridgeDir, "pocket_bridge", "__init__.py");
    if (!existsSync(moduleFile)) {
      logger.warn(
        "[PO Bridge] pocket_bridge module not found, skipping auto-spawn",
        {
          tried: moduleFile,
        },
      );
      return;
    }

    logger.info("[PO Bridge] Spawning Python bridge process", {
      python: this.bridgePythonPath,
      cwd: bridgeDir,
      module: BRIDGE_PYTHON_MODULE,
    });

    try {
      this.bridgeProcess = spawn(
        this.bridgePythonPath,
        ["-m", BRIDGE_PYTHON_MODULE],
        {
          cwd: bridgeDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            // Force the spawned bridge to bind the EXACT relay socket the WS
            // client connects to — otherwise a user override of
            // POCKET_BRIDGE_HOST/PORT would silently desync the two sides and
            // re-trigger ECONNREFUSED against a bridge bound to the default.
            POCKET_BRIDGE_HOST: secrets.POCKET_BRIDGE_HOST,
            POCKET_BRIDGE_PORT: String(secrets.POCKET_BRIDGE_PORT),
            // Forward the live session cookie so a bridge spawned by the
            // backend goes live immediately (not stuck in awaiting_ssid) when
            // the SSID is configured at the backend layer.
            POCKET_OPTION_SSID: secrets.POCKET_OPTION_SSID || "",
          },
        },
      );
    } catch (err) {
      logger.error("[PO Bridge] Failed to spawn Python bridge process", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.bridgeProcess = null;
      return;
    }

    const pid = this.bridgeProcess.pid;
    logger.info("[PO Bridge] Python bridge process spawned", { pid });

    // ── Pipe stdout directly to console ──
    this.bridgeProcess.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().trim();
      if (lines) {
        console.log(`[PO-Bridge-PY ${pid}] stdout: ${lines}`);
      }
    });

    // ── Pipe stderr directly to console (Python errors, import errors, stack traces) ──
    this.bridgeProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.trim();
      if (lines) {
        console.error(`[PO-Bridge-PY ${pid}] stderr: ${lines}`);
      }
      // Detect a PERMANENT failure (missing Python dependency / interpreter) in
      // the bridge's stderr. Reconnecting cannot install a missing package, so
      // we mark the bridge permanently degraded, surface a clean status, and
      // let the process exit WITHOUT triggering the restart loop. The rest of
      // the server keeps running (no live PO ticks until the env is fixed).
      if (
        !this.permanentlyDegraded &&
        /(ModuleNotFoundError|ImportError|No module named)/i.test(text) &&
        /(BinaryOptionsToolsV2|pocket_bridge)/i.test(text)
      ) {
        const hint =
          "BinaryOptionsToolsV2 (or a pocket_bridge module) is missing/broken. " +
          "Install it in the .venv-1 virtualenv via " +
          "`pip install -r pocket-bridge\\requirements.txt` and re-start. " +
          "Run `pocket-bridge\\verify_env.py` to pre-flight.";
        logger.error(
          "[PO Bridge] Python dependency unavailable — bridge permanently degraded (%s). %s",
          text.trim().split(/\r?\n/)[0],
          hint,
        );
        this.markPermanentlyDegraded(hint);
        // No spawn/restart is scheduled here — the exit handler below observes
        // permanentlyDegraded and stays quiet (no restart loop, no server crash).
      }
    });

    // ── Handle process exit with exit code ──
    this.bridgeProcess.on("exit", (code, signal) => {
      this.bridgeProcess = null;
      this.processReady = false;

      if (signal === "SIGTERM" || signal === "SIGINT") {
        logger.info("[PO Bridge] Python bridge process terminated cleanly", {
          pid,
          signal,
        });
        return;
      }

      logger.error("[PO Bridge] Python bridge process exited unexpectedly", {
        pid,
        exitCode: code,
        signal,
      });

      // Auto-restart on unexpected exit ONLY if the failure is potentially
      // recoverable. Once permanentlyDegraded is set (missing dependency, bad
      // interpreter) retrying can never help — stay quiet and let the platform
      // keep running in a clean DEGRADED state.
      if (this.permanentlyDegraded) {
        logger.warn(
          "[PO Bridge] Bridge is permanently degraded — not scheduling a restart (%s)",
          this.lastStatus,
        );
        return;
      }

      if (this.bridgeAutoSpawn && code !== 0) {
        logger.info("[PO Bridge] Scheduling bridge process restart in 5s", {
          pid,
          exitCode: code,
        });
        setTimeout(() => {
          if (this.bridgeAutoSpawn && !this.permanentlyDegraded) {
            this.spawnBridgeProcess();
          }
        }, 5_000);
      }
    });

    // ── Handle process error (e.g. ENOENT, spawn failure) ──
    this.bridgeProcess.on("error", (err) => {
      logger.error("[PO Bridge] Python bridge process error", {
        error: err.message,
        code: (err as NodeJS.ErrnoException).code,
      });
      this.bridgeProcess = null;
      this.processReady = false;
      // A spawn error such as ENOENT (interpreter not found) is permanent —
      // mark degraded so we don't retry readonly.
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        /spawn/i.test(err.message)
      ) {
        this.markPermanentlyDegraded(
          `Python interpreter unavailable (${err.message}). Configure ` +
            "POCKET_BRIDGE_PYTHON to the .venv-1 python.exe or ensure a python " +
            "interpreter is on PATH.",
        );
      }
    });

    // Mark as ready after a brief startup window
    setTimeout(() => {
      this.processReady = true;
    }, BRIDGE_STARTUP_TIMEOUT_MS);

    // ── Periodic health check: is the Python process still alive? ──
    this.healthCheckTimer = setInterval(() => {
      if (this.permanentlyDegraded) {
        // Stop probing a permanently-broken environment.
        clearInterval(this.healthCheckTimer!);
        this.healthCheckTimer = null;
        return;
      }
      if (this.bridgeProcess && !this.bridgeProcess.killed) {
        return; // Still alive
      }
      if (this.bridgeAutoSpawn) {
        logger.warn(
          "[PO Bridge] Bridge process health check failed — restarting",
        );
        this.spawnBridgeProcess();
      }
    }, BRIDGE_HEALTH_CHECK_INTERVAL_MS);
  }

  /** Mark the bridge permanently degraded + surface a clean status to the UI. */
  private markPermanentlyDegraded(reason: string): void {
    if (this.permanentlyDegraded) return;
    this.permanentlyDegraded = true;
    this.lastStatus = "DEGRADED";
    logger.error(
      "[PO Bridge] Bridge permanently degraded: %s. Live Pocket Option ticks " +
        "will not flow until the environment is fixed; the rest of the platform " +
        "continues to run normally.",
      reason,
    );
  }

  private killBridgeProcess(): void {
    if (!this.bridgeProcess) return;
    try {
      this.bridgeProcess.kill("SIGTERM");
      logger.info("[PO Bridge] Sent SIGTERM to Python bridge process", {
        pid: this.bridgeProcess.pid,
      });
    } catch {
      // Already dead
    }
    this.bridgeProcess = null;
    this.processReady = false;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CIRCUIT BREAKER — prevents ECONNREFUSED spam
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Check if a reconnect attempt is allowed under the circuit breaker and
   * rate limiter. Returns `true` if the connection attempt should proceed.
   */
  private shouldAttemptReconnect(): boolean {
    const now = Date.now();

    // ── Circuit OPEN: check if reset timeout has elapsed ──
    if (this.circuitState === "OPEN") {
      if (now - this.circuitOpenedAt >= CB_RESET_TIMEOUT_MS) {
        this.circuitState = "HALF_OPEN";
        logger.info(
          "[PO Bridge] Circuit breaker entering HALF_OPEN — allowing probe",
        );
        return true;
      }
      return false; // Still open, suppress reconnect
    }

    // ── Rate limiter: max N attempts per window ──
    this.reconnectAttempts = this.reconnectAttempts.filter(
      (t) => now - t < CB_RATE_LIMIT_WINDOW_MS,
    );
    if (this.reconnectAttempts.length >= CB_MAX_ATTEMPTS_PER_WINDOW) {
      logger.debug(
        "[PO Bridge] Rate limiter: suppressing reconnect (%d/%d in window)",
        {
          attempts: this.reconnectAttempts.length,
          max: CB_MAX_ATTEMPTS_PER_WINDOW,
        },
      );
      return false;
    }

    return true;
  }

  private recordReconnectSuccess(): void {
    // Reset circuit breaker on successful connection
    this.consecutiveFailures = 0;
    this.circuitState = "CLOSED";
    this.reconnectAttempts = [];
    this.reconnectDelayMs = CB_MIN_RECONNECT_MS;
  }

  private recordReconnectFailure(): void {
    this.consecutiveFailures++;
    this.reconnectAttempts.push(Date.now());

    if (this.circuitState === "HALF_OPEN") {
      // Probe failed — re-open the circuit
      this.circuitState = "OPEN";
      this.circuitOpenedAt = Date.now();
      logger.warn(
        "[PO Bridge] Circuit breaker: HALF_OPEN probe failed — re-opening circuit",
        {
          consecutiveFailures: this.consecutiveFailures,
        },
      );
    } else if (this.consecutiveFailures >= CB_FAILURE_THRESHOLD) {
      this.circuitState = "OPEN";
      this.circuitOpenedAt = Date.now();
      logger.warn(
        "[PO Bridge] Circuit breaker: OPEN after %d consecutive failures",
        { consecutiveFailures: this.consecutiveFailures },
      );
    }

    // Exponential backoff within bounds
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 1.5,
      CB_MAX_RECONNECT_MS,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  WEBSOCKET CONNECTION
  // ════════════════════════════════════════════════════════════════════════

  private connect(): void {
    if (!this.shouldAttemptReconnect()) {
      // Schedule next allowed attempt
      this.scheduleReconnect();
      return;
    }

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      logger.error("[PO Bridge] Failed to create WebSocket", {
        url: this.url,
        error: err instanceof Error ? err.message : String(err),
      });
      this.recordReconnectFailure();
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.lastStatus = "ONLINE";
      this.wsErrorSeen = false;
      this.recordReconnectSuccess();
      logger.info("[PO Bridge] Connected to Pocket Option relay", {
        url: this.url,
      });
      this.broadcastFeedStatusIfChanged();
      // Reset readiness: a freshly (re)connected relay may still be loading its
      // assets. Re-arm every staged symbol once the `ready` frame arrives (or
      // the bounded fallback expires) — never before, to avoid racing init.
      this.assetsReady = false;
      if (this.poArmedByClient.size > 0) {
        this.armReadinessFallback();
      }
    });

    this.ws.on("message", (data) => this.onMessage(data));

    this.ws.on("close", () => {
      // Only the CLOSE event records the failure + schedules the reconnect —
      // exactly once, even when an 'error' preceded it (wsErrorSeen). The dead
      // socket is released immediately so a stale 'close' after a reconnect
      // can never re-enter this handler.
      this.connected = false;
      this.assetsReady = false;
      if (this.readyFallbackTimer) {
        clearTimeout(this.readyFallbackTimer);
        this.readyFallbackTimer = null;
      }
      if (this.lastStatus === "ONLINE") {
        this.lastStatus = "DEGRADED";
      }
      const failed = !this.wsErrorSeen;
      this.wsErrorSeen = false;
      this.ws?.removeAllListeners();
      this.ws = null;
      if (failed) {
        this.recordReconnectFailure();
      }
      this.broadcastFeedStatusIfChanged();
      logger.warn(
        "[PO Bridge] Relay connection closed — scheduling reconnect",
        {
          delayMs: this.reconnectDelayMs,
          circuitState: this.circuitState,
        },
      );
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.connected = false;
      if (this.lastStatus === "ONLINE") {
        this.lastStatus = "DEGRADED";
      }

      const msg = err instanceof Error ? err.message : String(err);

      // Rate-limit error logging to prevent terminal spam
      if (this.circuitState !== "OPEN") {
        logger.warn("[PO Bridge] Relay connection error", { error: msg });
      } else {
        logger.debug(
          "[PO Bridge] Relay error (suppressed by circuit breaker)",
          {
            error: msg,
          },
        );
      }

      // Set the dedup guard and forcibly release the dead socket so ws emits
      // its guaranteed 'close' exactly once — the single accounting point for
      // this failed attempt. Nothing is recorded or scheduled here.
      this.wsErrorSeen = true;
      try {
        this.ws?.terminate();
      } catch {
        /* noop */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // A fresh socket is created every attempt; drop any leftover reference
      // (with listeners already removed by the close handler) so connect()
      // always starts from a clean slate.
      this.wsErrorSeen = false;
      this.connected = false;
      this.ws = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MESSAGE HANDLING
  // ════════════════════════════════════════════════════════════════════════

  private onMessage(data: WebSocket.RawData): void {
    let frame: {
      type?: string;
      payload?: unknown;
    };
    try {
      frame = JSON.parse(data.toString());
    } catch {
      logger.debug("[PO Bridge] Ignoring non-JSON relay message");
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    switch (frame.type) {
      case "tick":
        this.handleTick(frame.payload as BridgeTickFrame);
        break;
      case "candle":
        this.handleCandle(frame.payload as BridgeCandleFrame);
        break;
      case "status":
        this.handleStatus(frame.payload as { status?: string; error?: string });
        break;
      case "ready":
        this.handleReady(frame.payload as { assets?: unknown[] });
        break;
      case "heartbeat":
        this.handleHeartbeat(frame.payload as Record<string, unknown>);
        break;
      case "subscribed":
        this.handleSubscribed(frame.payload as Record<string, unknown>);
        break;
      case "snapshot":
        this.handleSnapshot(frame.payload as unknown);
        break;
      default:
        break;
    }
  }

  private handleTick(tick: BridgeTickFrame): void {
    if (!tick || !tick.symbol) return;
    const price = toFiniteNumber(tick.price);
    if (price === null || price <= 0) {
      logger.debug("[PO Bridge] Rejected non-finite tick price", {
        symbol: tick.symbol,
        price: tick.price,
      });
      return;
    }
    // Forward the PO server timestamp so the candle buffer and tick stream
    // align exactly with Pocket Option's own chart grid — zero divergence.
    const tsMs = toFiniteNumber(tick.ts_ms);
    const poTimestamp =
      tsMs !== null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
    // TEMPORARY LATENCY DIAGNOSTICS: the relay decorates every frame with its
    // monotonic `seq` and a `ts_utc` emission stamp. Capture the local
    // backend reception instant here and forward all three so the browser-probe
    // can decompose broker→bridge→backend→browser latency + detect seq drops.
    const receivedUtcMs = Date.now();
    tickIngestionService.ingestTick(
      tick.symbol,
      price,
      "pocket_option",
      poTimestamp,
      tick.asset_type,
      {
        seq: toFiniteNumber(tick.seq) ?? undefined,
        tsUtc: toFiniteNumber(tick.ts_utc) ?? undefined,
        receivedUtcMs,
      },
    );
  }

  private handleCandle(candle: BridgeCandleFrame): void {
    if (!candle || typeof candle.symbol !== "string" || !candle.symbol) return;
    try {
      this.emitM20Candle(candle);
    } catch (err) {
      logger.debug("[PO Bridge] emitM20Candle failed", {
        symbol: candle.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Relay broadcast `ready` — the PO client is authenticated and the asset
   *  list is loaded. This is the go-ahead to release every staged subscribe. */
  private handleReady(payload?: { assets?: unknown[] }): void {
    if (Array.isArray(payload?.assets) && payload.assets.length > 0) {
      symbolRegistry.replaceFromBridgeAssets(payload.assets);
    }
    if (this.readyFallbackTimer) {
      clearTimeout(this.readyFallbackTimer);
      this.readyFallbackTimer = null;
    }
    if (!this.assetsReady) {
      this.assetsReady = true;
      logger.info(
        "[PO Bridge] Relay ready (assets initialised) — flushing staged subscribes",
      );
      this.flushStagedSubscriptions();
    }
  }

  private handleStatus(payload: { status?: string; error?: string }): void {
    const status = payload?.status || "idle";
    this.lastRelayStatus = status;
    logger.info("[PO Bridge] Status from relay", {
      status,
      error: payload?.error,
    });

    if (status === "awaiting_ssid") {
      this.lastStatus = "awaiting_ssid";
      this.broadcastFeedStatusIfChanged();
      return;
    }
    if (status === "connected") {
      this.lastStatus = "ONLINE";
      this.broadcastFeedStatusIfChanged();
      return;
    }
    if (
      status === "connection_error" ||
      status === "disconnected" ||
      status === "stopped" ||
      status === "stalled"
    ) {
      this.lastStatus = "DEGRADED";
      this.broadcastFeedStatusIfChanged();
      return;
    }
    if (status === "session_expired") {
      this.lastStatus = "DEGRADED";
      this.broadcastFeedStatusIfChanged();
      return;
    }
  }

  /** Relay `heartbeat` — the 5s liveness probe. Recorded for the heartbeat-age
   *  rule and used to re-derive + push the authoritative feed_status. */
  private handleHeartbeat(payload: Record<string, unknown>): void {
    this.lastHeartbeatAt = Date.now();
    if (
      typeof payload?.status === "string" &&
      payload.status !== this.lastRelayStatus
    ) {
      this.lastRelayStatus = payload.status;
      if (payload.status === "connected") this.lastStatus = "ONLINE";
      else if (payload.status === "awaiting_ssid")
        this.lastStatus = "awaiting_ssid";
      else if (
        payload.status === "connection_error" ||
        payload.status === "disconnected" ||
        payload.status === "stalled"
      ) {
        this.lastStatus = "DEGRADED";
      }
    }
    this.broadcastFeedStatusIfChanged();
  }

  /** Map current bridge state → the mission feed-status contract. 100% real:
   *  grounded on the raw relay status + heartbeat age, never fabricated. */
  private computeFeedStatus(): FeedStatus {
    if (this.permanentlyDegraded) return "degraded";
    if (
      this.lastHeartbeatAt > 0 &&
      Date.now() - this.lastHeartbeatAt > HEARTBEAT_STALE_MS
    ) {
      return "disconnected";
    }
    if (this.lastRelayStatus === "awaiting_ssid") return "awaiting_ssid";
    if (this.lastRelayStatus === "session_expired") return "auth_failed";
    if (this.lastRelayStatus === "stalled") return "stalled";
    if (this.lastStatus === "ONLINE" || this.connected) return "live";
    if (this.lastStatus === "DEGRADED") return "degraded";
    if (this.lastStatus === "awaiting_ssid") return "awaiting_ssid";
    return "awaiting_ssid";
  }

  /**
   * Snapshot of the CURRENT feed-status state (MASTER MISSION part 2) — used to
   * emit `feed_status` to a freshly-connected socket immediately. Read-only:
   * never mutates the bridge state machine.
   */
  public getCurrentFeedStatus(): {
    status: FeedStatus;
    lastHeartbeatTs?: number;
    heartbeatAgeMs: number;
  } {
    return {
      status: this.computeFeedStatus(),
      lastHeartbeatTs:
        this.lastHeartbeatAt > 0 ? this.lastHeartbeatAt : undefined,
      heartbeatAgeMs:
        this.lastHeartbeatAt > 0 ? Date.now() - this.lastHeartbeatAt : 0,
    };
  }

  /** Emit feed_status to all Socket.IO clients only when the value changed. */
  private broadcastFeedStatusIfChanged(): void {
    const status = this.computeFeedStatus();
    if (status === this.lastBroadcastFeedStatus) return;
    this.lastBroadcastFeedStatus = status;
    const ageMs =
      this.lastHeartbeatAt > 0 ? Date.now() - this.lastHeartbeatAt : 0;
    websocketService.broadcastFeedStatus(status, {
      lastHeartbeatTs:
        this.lastHeartbeatAt > 0 ? this.lastHeartbeatAt : undefined,
      heartbeatAgeMs: ageMs,
    });
  }

  /** Watchdog: re-derive feed_status on the heartbeat-age rule so a silent
   *  relay (transport up, heartbeats dead) flips to `disconnected` without
   *  waiting for an event. */
  private startFeedStatusWatchdog(): void {
    if (this.feedStatusTimer) return;
    this.feedStatusTimer = setInterval(() => {
      this.broadcastFeedStatusIfChanged();
    }, FEED_STATUS_WATCHDOG_MS);
  }

  private handleSubscribed(payload: Record<string, unknown>): void {
    if (!payload || typeof payload.symbol !== "string" || !payload.symbol)
      return;
    const status =
      typeof payload.status === "string" ? payload.status : "subscribed";
    const norm = forexDataService.toCanonicalSymbol(payload.symbol);
    if (!norm) return;

    if (status === "awaiting_ssid" || status === "subscribe_error") {
      logger.warn("[PO Bridge] Subscription NOT armed", {
        symbol: norm,
        status,
        error: typeof payload.error === "string" ? payload.error : undefined,
      });
      return;
    }

    const heldPrice = toFiniteNumber(payload.last_valid_price);
    if (heldPrice !== null && heldPrice > 0) {
      // Seed the SSOT + real-tick ring from the bridge's held real PO print so
      // the freshness gate and the client's "WAITING FOR REAL-TIME TICK" lock
      // clear INSTANTLY on the handshake (no waiting on a quiet tape).
      forexDataService.setPocketOptionPrice(norm, heldPrice);
      realtimeTickBuffer.append(norm, heldPrice);
      liveTickSignalDispatcher.enqueue(norm);
      try {
        forexDataService.appendTick(norm, heldPrice);
      } catch {
        /* non-fatal */
      }
      // One live_tick so the chart + live pane flip armed the moment the
      // handshake lands — a genuine held PO print, never fabricated.
      const heldAtMs = toFiniteNumber(payload.last_valid_at);
      const ts =
        heldAtMs !== null && heldAtMs > 0
          ? new Date(heldAtMs).toISOString()
          : new Date().toISOString();
      websocketService.broadcastLiveTick({
        symbol: norm,
        price: heldPrice,
        timestamp: ts,
      });
    }

    if (Array.isArray(payload.closed_candles)) {
      for (const mc of payload.closed_candles as Array<
        Record<string, unknown>
      >) {
        if (!mc) continue;
        const o = toFiniteNumber(mc.open);
        const h = toFiniteNumber(mc.high);
        const l = toFiniteNumber(mc.low);
        const c = toFiniteNumber(mc.close);
        const t = toFiniteNumber(mc.time);
        if (t === null || o === null || c === null) continue;
        if (o <= 0 || c <= 0) continue;
        forexDataService.ingestPoCandle(
          norm,
          t,
          {
            open: o,
            high: h ?? o,
            low: l ?? o,
            close: c,
          },
          true,
        );
      }
    }

    logger.info("[PO Bridge] Subscription confirmed — live PO stream armed", {
      symbol: norm,
      asset: typeof payload.asset === "string" ? payload.asset : undefined,
      heldPrice,
    });
  }

  private handleSnapshot(payload: unknown): void {
    if (!Array.isArray(payload)) return;
    for (const entry of payload as Array<{
      symbol?: string;
      last_valid_price?: number;
      closed_candles?: Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
      }>;
    }>) {
      if (!entry || typeof entry.symbol !== "string") continue;
      const heldPrice = toFiniteNumber(entry.last_valid_price);
      if (heldPrice === null || heldPrice <= 0) continue;
      const norm = entry.symbol.trim().toUpperCase();
      // Arm the live-quant /tick-signal forwarder (coalesced, no drops).
      liveTickSignalDispatcher.enqueue(norm);
      // Author the PO SSOT price so the whole platform reads the same value.
      forexDataService.setPocketOptionPrice(norm, heldPrice);
      // Seed the real-tick ring so a cold backend / re-joined client gets an
      // instant fresh quote (genuine held PO print — never fabricated).
      realtimeTickBuffer.append(norm, heldPrice);
      // Fold into candle buffer (tick-accumulation for the ML path).
      try {
        forexDataService.appendTick(norm, heldPrice);
      } catch {
        /* non-fatal */
      }
      // Ingest any closed M20 candles from the snapshot so the candle buffer
      // is pre-populated with real PO history — no skeleton bars needed.
      if (Array.isArray(entry.closed_candles)) {
        for (const mc of entry.closed_candles) {
          if (!mc) continue;
          const o = toFiniteNumber(mc.open);
          const h = toFiniteNumber(mc.high);
          const l = toFiniteNumber(mc.low);
          const c = toFiniteNumber(mc.close);
          const t = toFiniteNumber(mc.time);
          if (t === null || o === null || c === null) continue;
          if (o <= 0 || c <= 0) continue;
          forexDataService.ingestPoCandle(
            norm,
            t,
            {
              open: o,
              high: h ?? o,
              low: l ?? o,
              close: c,
            },
            true,
          );
        }
      }
    }
  }

  private emitM20Candle(candle: BridgeCandleFrame): void {
    // Route every PO M20 candle verbatim into the shared candle buffer so the
    // chart, signal engine and prediction pipeline consume the exact same OHLC
    // structure Pocket Option's active feed produces — zero local re-derivation.
    try {
      const o = toFiniteNumber(candle.open);
      const h = toFiniteNumber(candle.high);
      const l = toFiniteNumber(candle.low);
      const c = toFiniteNumber(candle.close);
      const t = toFiniteNumber(candle.time);
      if (o === null || c === null || t === null || o <= 0 || c <= 0) {
        logger.debug("[PO Bridge] Rejected non-finite M20 candle", {
          symbol: candle.symbol,
          time: candle.time,
        });
        return;
      }
      forexDataService.ingestPoCandle(
        candle.symbol,
        t,
        {
          open: o,
          high: h ?? o,
          low: l ?? o,
          close: c,
        },
        candle.closed,
        candle.asset_type,
      );
    } catch (err) {
      logger.debug("[PO Bridge] ingestPoCandle failed", {
        symbol: candle.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const pocketOptionBridgeService =
  PocketOptionBridgeService.getInstance();
export default pocketOptionBridgeService;
