/**
 * DURABLE SIGNAL STREAM (Redis Streams) — the at-least-once half of the
 * transport. Pub/Sub remains the HOT half and is unchanged.
 *
 * WHY THIS EXISTS ALONGSIDE PUBSUB
 * ─────────────────────────────────
 * Pub/Sub is fire-and-forget: Redis holds no history, so a signal published
 * while the subscriber is restarting, reconnecting, or briefly disconnected is
 * gone permanently. For a binary-options product a silently LOST 98% signal is
 * a real financial loss — the operator's terminal simply never showed a verdict
 * that genuinely fired, with no error anywhere to explain why.
 *
 * Redis Streams give the missing guarantee: entries are appended to a log and
 * acknowledged only after the consumer has durably persisted them. Delivery is
 * therefore AT LEAST ONCE, and a consumer that dies mid-batch resumes from its
 * PEL (pending entries list) via XAUTOCLAIM instead of starting blind.
 *
 * The division of labour is deliberate:
 *   • HOT  (sub-millisecond, best-effort) — `websocketService.broadcastLiveQuantSignal`
 *     pushes the verdict to connected sockets the instant it is computed. If no
 *     one is connected, nothing is lost: the operator was not watching.
 *   • DURABLE (at-least-once) — the same signal is XADDed to a stream and
 *     persisted to the database by a consumer group. If WE crash, the record
 *     survives and is written when the consumer returns.
 *
 * Both halves are therefore complementary, not redundant: the hot path serves
 * latency, the stream serves durability.
 *
 * OPERATIONAL RULES
 * ─────────────────
 *  • Publishing must NEVER be able to slow or fail the hot path. `publishDurableSignal`
 *    is fire-and-forget with a swallowed error, and it short-circuits entirely
 *    once Redis has proven unreachable.
 *  • At-least-once means the handler MUST be idempotent: it will see the same
 *    entry again if it fails after persisting but before XACK. A unique index on
 *    the source signal id is what makes replay safe.
 *  • BLOCK is used on XREADGROUP so the consumer idles without polling. The read
 *    timeout must exceed the BLOCK timeout or ioredis surfaces a spurious
 *    "Connection is closed" on idle.
 */

import { logger } from "../utils/logger";
import secrets from "../config/secrets";

/** Append-only log of signals awaiting durable persistence. */
export const SIGNAL_STREAM_KEY = "trading_signals:stream";
/** Consumer group — every core-backend instance joins this one group. */
export const SIGNAL_STREAM_GROUP = "core-persist";
/** BLOCK window for XREADGROUP. The socket read timeout must exceed this. */
const READ_BLOCK_MS = 5_000;
/** How many entries one XREADGROUP may return. */
const READ_COUNT = 50;
/** Cap on reclaimed PEL entries per start-up, so a huge backlog cannot stall boot. */
const RECLAIM_MIN_IDLE_MS = 30_000;
const RECLAIM_COUNT = 100;

type StreamEntry = [id: string, fields: string[]];

/**
 * Minimal surface of the ioredis client this module needs. Declared
 * structurally so the tests can supply a fake without a real Redis, and so a
 * future client swap is caught by the compiler rather than at runtime.
 */
export interface StreamRedis {
  xadd(key: string, id: string, ...args: string[]): Promise<string>;
  xgroup(
    verb: string,
    key: string,
    group: string,
    id: string,
    mkstream: string,
  ): Promise<string>;
  xreadgroup(
    ...args: Array<string | number>
  ): Promise<unknown>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  xautoclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: string | number,
    start: string,
    countKeyword: string,
    count: string | number,
  ): Promise<unknown>;
}

let client: StreamRedis | null = null;
/** Once Redis has failed we stop trying — no retry storm in the hot path. */
let disabled = false;
let consuming = false;
let consumerName = `core-${process.pid}`;

async function connect(): Promise<StreamRedis | null> {
  if (disabled) return null;
  if (client) return client;
  try {
    const { Redis } = await import("ioredis");
    const options = {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5_000,
      // Must outlive BLOCK, or ioredis tears the socket down while XREADGROUP
      // is parked and the read rejects instead of returning null.
      commandTimeout: READ_BLOCK_MS + 5_000,
    };
    const redis = (
      secrets.REDIS_URL
        ? new Redis(secrets.REDIS_URL, options)
        : new Redis({
            host: secrets.REDIS_HOST,
            port: secrets.REDIS_PORT,
            password: secrets.REDIS_PASSWORD || undefined,
            ...options,
          })
    ) as unknown as StreamRedis & {
      connect: () => Promise<void>;
      quit: () => Promise<void>;
      on: (e: string, cb: (...a: unknown[]) => void) => void;
    };
    redis.on("error", () => {
      /* silent — handled at the call site */
    });
    await redis.connect();
    client = redis;
    logger.info("[SignalStream] Redis connected for durable signals");
    return client;
  } catch (err) {
    disabled = true;
    logger.warn(
      "[SignalStream] Redis unavailable — durable signal log disabled " +
        "(the hot socket path is unaffected)",
      { error: (err as Error).message },
    );
    return null;
  }
}

/** Flattens a bare `[[id, [k, v, k, v]], ...]` entry list. */
function parseEntryList(
  entries: unknown,
): Array<{ id: string; payload: Record<string, string> }> {
  if (!Array.isArray(entries)) return [];
  const out: Array<{ id: string; payload: Record<string, string> }> = [];
  for (const entry of entries as StreamEntry[]) {
    if (!Array.isArray(entry)) continue;
    const [id, flat] = entry;
    const payload: Record<string, string> = {};
    for (let i = 0; i < (flat?.length ?? 0); i += 2) {
      payload[flat[i]] = flat[i + 1];
    }
    out.push({ id, payload });
  }
  return out;
}

/**
 * Flattens an XREADGROUP reply — `[[streamKey, [[id, [k, v, ...]], ...]]]`.
 * The stream-key wrapper is present here and ONLY here: XAUTOCLAIM returns its
 * entry list bare, which is an easy and silent way to process zero messages.
 */
function parseEntries(reply: unknown): Array<{ id: string; payload: Record<string, string> }> {
  if (!Array.isArray(reply)) return [];
  const out: Array<{ id: string; payload: Record<string, string> }> = [];
  for (const stream of reply) {
    if (!Array.isArray(stream)) continue;
    out.push(...parseEntryList(stream[1]));
  }
  return out;
}

/**
 * Append one signal to the durable log. NEVER throws and never awaits on
 * behalf of the caller — the hot broadcast must not inherit Redis latency.
 */
export async function publishDurableSignal(
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const redis = await connect();
    if (!redis) return;
    // One JSON field keeps the entry schema-free: the consumer's extractor
    // already tolerates symbol/signal_type/price/confidence aliases.
    await redis.xadd(
      SIGNAL_STREAM_KEY,
      "*",
      "payload",
      JSON.stringify(payload),
    );
  } catch (err) {
    // A failed durable append must never propagate into the socket path.
    logger.warn("[SignalStream] durable append failed (hot path unaffected)", {
      error: (err as Error).message,
    });
  }
}

async function ensureGroup(redis: StreamRedis): Promise<void> {
  try {
    await redis.xgroup("CREATE", SIGNAL_STREAM_KEY, SIGNAL_STREAM_GROUP, "0", "MKSTREAM");
  } catch (err) {
    // BUSYGROUP simply means another instance won the race — that is success.
    const msg = (err as Error).message ?? "";
    if (!/BUSYGROUP/i.test(msg)) throw err;
  }
}

/**
 * Unwraps the single-field envelope written by `publishDurableSignal`.
 *
 * XADD stores `payload` -> JSON.stringify(signal), so a raw stream field map
 * looks like `{ payload: "{\"symbol\":\"EUR/USD\",...}" }`. Handing that map
 * straight to a consumer that looks for `symbol`/`signal_type` finds nothing
 * and the entry is dropped as unparseable — i.e. the durable half of the
 * transport silently persists ZERO signals while looking healthy.
 *
 * Unwrapping here (rather than in the subscriber) keeps every consumer of this
 * stream correct by construction and gives the mismatch a single tested home.
 * A map that already has the signal fields at the top level is passed through
 * untouched, so a future multi-field entry format keeps working.
 */
export function unwrapEntryPayload(
  fields: Record<string, string>,
): Record<string, unknown> {
  const encoded = fields?.payload;
  if (typeof encoded !== "string" || !encoded) return fields;

  // Only unwrap when the envelope really is the envelope. A hand-written
  // entry whose `payload` field is not a JSON object is left alone so the
  // consumer's own validation can report it.
  const trimmed = encoded.trim();
  if (!trimmed.startsWith("{")) return fields;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON after all — fall through and let the consumer decide.
  }
  return fields;
}

async function handle(
  redis: StreamRedis,
  handler: (payload: Record<string, string>, entryId: string) => Promise<void>,
  entry: { id: string; payload: Record<string, string> },
): Promise<void> {
  try {
    // The entry id is passed through as the idempotency key: an at-least-once
    // consumer MUST dedup on it, because a crash between "persisted" and
    // "XACK" replays this exact entry.
    await handler(
      unwrapEntryPayload(entry.payload) as Record<string, string>,
      entry.id,
    );
  } catch (err) {
    // Deliberately NOT acked. The entry stays in the PEL and is reclaimed by
    // XAUTOCLAIM after RECLAIM_MIN_IDLE_MS — at-least-once, so the handler
    // must be idempotent.
    logger.error("[SignalStream] durable persist failed — left pending", {
      id: entry.id,
      error: (err as Error).message,
    });
    return;
  }
  await redis.xack(SIGNAL_STREAM_KEY, SIGNAL_STREAM_GROUP, entry.id);
}

/**
 * Start the durable consumer loop. Idempotent: a second call is a no-op so a
 * reconnect path cannot end up with two loops acking each other's entries.
 *
 * The loop never rejects and never blocks the caller — it is started in the
 * background exactly like the Pub/Sub subscription.
 */
export async function startDurableSignalConsumer(
  handler: (payload: Record<string, string>, entryId: string) => Promise<void>,
): Promise<void> {
  if (consuming) return;
  const redis = await connect();
  if (!redis) return;

  consuming = true;
  consumerName = `core-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await ensureGroup(redis);
  } catch (err) {
    consuming = false;
    logger.warn("[SignalStream] could not create consumer group", {
      error: (err as Error).message,
    });
    return;
  }

  // Reclaim anything a previous incarnation of this consumer was mid-way
  // through persisting when it died. Without this, an entry that failed
  // between "persisted" and "acked" — or simply never reached — would sit in
  // the PEL forever while the group happily reported itself as caught up.
  try {
    // The COUNT keyword is REQUIRED, not optional. Verified against live Redis
    // 7.4.8: passing a bare positional count here yields
    //   "ERR syntax error"
    // and every reclaim attempt was swallowed by the catch below, so a dead
    // consumer's PEL entries were never reclaimed while start-up looked clean.
    const [nextId, reclaimed, _deleted] = (await redis.xautoclaim(
      SIGNAL_STREAM_KEY,
      SIGNAL_STREAM_GROUP,
      consumerName,
      RECLAIM_MIN_IDLE_MS,
      "0-0",
      "COUNT",
      RECLAIM_COUNT,
    )) as [string, unknown[], unknown[]];
    for (const entry of parseEntryList(reclaimed)) {
      await handle(redis, handler, entry);
    }
    if (reclaimed?.length) {
      logger.info("[SignalStream] reclaimed pending durable signals", {
        count: reclaimed.length,
        nextId,
      });
    }
  } catch (err) {
    logger.warn("[SignalStream] PEL reclaim failed", {
      error: (err as Error).message,
    });
  }

  const loop = async (): Promise<void> => {
    while (consuming) {
      try {
        // WIRE FORMAT, NOT A HELPER SHAPE.
        //
        // ioredis does NOT build the GROUP/STREAMS keywords for XREADGROUP — it
        // forwards arguments to the socket and only scans them for a BLOCK
        // token. A positional (group, consumer, streams, count, block) call is
        // therefore malformed on the wire and real Redis rejects it with
        //   "ERR wrong number of arguments for 'xreadgroup' command"
        // which this loop used to swallow into an infinite retry, so the
        // durable consumer read NOTHING while looking healthy. The trailing
        // ">" is the mandatory stream id meaning "deliver new messages"; it is
        // omitted too easily and yields
        //   "ERR Unbalanced 'xreadgroup' list of streams".
        // Both shapes were verified against a live Redis before being adopted.
        const reply = await redis.xreadgroup(
          "GROUP",
          SIGNAL_STREAM_GROUP,
          consumerName,
          "COUNT",
          READ_COUNT,
          "BLOCK",
          READ_BLOCK_MS,
          "STREAMS",
          SIGNAL_STREAM_KEY,
          ">",
        );
        for (const entry of parseEntries(reply)) {
          await handle(redis, handler, entry);
        }
      } catch (err) {
        if (!consuming) return;
        logger.warn("[SignalStream] consumer read failed; retrying", {
          error: (err as Error).message,
        });
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  };

  void loop();
  logger.info("[SignalStream] durable consumer started", {
    group: SIGNAL_STREAM_GROUP,
    consumer: consumerName,
  });
}

/** Test seam: drop the cached client + state. */
export function __resetSignalStreamForTests(): void {
  client = null;
  disabled = false;
  consuming = false;
}
