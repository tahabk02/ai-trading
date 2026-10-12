/**
 * signalStream.test.ts — THE DURABLE HALF OF THE SIGNAL TRANSPORT.
 *
 * Pub/Sub is the hot path and is lossy by design: Redis keeps no history, so a
 * signal published while this process was restarting is gone forever. The
 * Streams consumer is the half that makes a 98% verdict survive a crash —
 * it delivers AT LEAST ONCE and only acknowledges after the database write.
 *
 * The properties that matter, and that a naive implementation gets wrong:
 *
 *  1. ACK ONLY AFTER THE WRITE. Acking first (or acking in a `finally`) turns a
 *     database blip into permanent signal loss — the exact failure the stream
 *     was added to prevent.
 *  2. A FAILED HANDLER MUST NOT ACK. The entry has to stay in the PEL so
 *     XAUTOCLAIM can reclaim it; otherwise a transient error silently deletes
 *     the signal.
 *  3. THE HOT PATH MUST BE UNHARMED. Publishing is fire-and-forget: a dead
 *     Redis may cost a log line, never an exception, never a broadcast.
 *  4. XREADGROUP REPLY SHAPE IS NOT what it looks like —
 *     `[[streamKey, [[id, [k, v, ...]], ...]]]`. Flattening it wrong yields
 *     zero entries processed while the stream appears healthy.
 *  5. `commandTimeout` MUST exceed the XREADGROUP BLOCK, or ioredis closes the
 *     socket while the read is parked and the consumer loop spins on errors.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../config/secrets", () => ({
  secrets: {
    REDIS_URL: "",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: 6379,
    REDIS_PASSWORD: "",
  },
  default: {
    REDIS_URL: "",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: 6379,
    REDIS_PASSWORD: "",
  },
}));

import {
  SIGNAL_STREAM_KEY,
  SIGNAL_STREAM_GROUP,
  publishDurableSignal,
  startDurableSignalConsumer,
  unwrapEntryPayload,
  __resetSignalStreamForTests,
} from "../../messaging/signalStream";

type Call = { args: unknown[] };

/** A hand-driven stand-in for the ioredis client. */
function fakeRedis(over: Partial<Record<string, unknown>> = {}) {
  const xadd = vi.fn(async () => "1-0");
  const xgroup = vi.fn(async () => "OK");
  const xack = vi.fn(async () => 1);
  const xautoclaim = vi.fn(async () => ["0-0", [], []]);
  const xreadgroup = vi.fn(async (): Promise<unknown> => {
    // Park forever: the consumer loop is stopped by the test, not by the read.
    await new Promise(() => {});
    return null;
  });
  const connect = vi.fn(async () => undefined);
  const client = Object.assign(
    { xadd, xgroup, xack, xautoclaim, xreadgroup, connect, on: vi.fn(), quit: vi.fn() },
    over,
  );
  return client as typeof client & { _calls: Record<string, Call[]> };
}

/** Reply shape Redis actually returns for XREADGROUP. */
const reply = (entries: Array<[string, Record<string, string>]>) => [
  [
    SIGNAL_STREAM_KEY,
    entries.map(([id, fields]) => [
      id,
      Object.entries(fields).flat(),
    ]) as unknown[],
  ],
];

let redis: ReturnType<typeof fakeRedis>;

beforeEach(async () => {
  __resetSignalStreamForTests();
  redis = fakeRedis();
  // The module creates its client via a dynamic `import("ioredis")`; inject the
  // fake so no real Redis is required.
  const mod = await import("../../messaging/signalStream");
  void mod;
  vi.doMock("ioredis", () => ({ Redis: vi.fn(() => redis) }));
});

afterEach(() => {
  __resetSignalStreamForTests();
  vi.doUnmock("ioredis");
  vi.resetModules();
});

describe("publishDurableSignal", () => {
  it("appends the signal to the durable log", async () => {
    await publishDurableSignal({ symbol: "EUR/USD", signal: "BUY" });
    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const [key, id, field, json] = (redis.xadd as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(key).toBe(SIGNAL_STREAM_KEY);
    expect(id).toBe("*"); // server-assigned id → strictly ordered log
    expect(field).toBe("payload");
    expect(JSON.parse(json as string)).toMatchObject({ symbol: "EUR/USD" });
  });

  it("never throws when the durable log is broken", async () => {
    const boom = fakeRedis({ xadd: vi.fn(async () => { throw new Error("READONLY"); }) });
    vi.doMock("ioredis", () => ({ Redis: vi.fn(() => boom) }));
    __resetSignalStreamForTests();
    // The hot socket path calls this and must not be able to fail.
    await expect(
      publishDurableSignal({ symbol: "EUR/USD", signal: "BUY" }),
    ).resolves.toBeUndefined();
  });

  it("disables itself after Redis is unreachable instead of retry-storming", async () => {
    const bad = fakeRedis({
      connect: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    vi.doMock("ioredis", () => ({ Redis: vi.fn(() => bad) }));
    __resetSignalStreamForTests();

    await publishDurableSignal({ symbol: "EUR/USD", signal: "BUY" });
    await publishDurableSignal({ symbol: "EUR/USD", signal: "BUY" });
    // Only the FIRST call may have attempted a connection.
    expect(bad.connect).toHaveBeenCalledTimes(1);
  });
});

describe("startDurableSignalConsumer", () => {
  it("creates the consumer group with MKSTREAM", async () => {
    await startDurableSignalConsumer(async () => {});
    expect(redis.xgroup).toHaveBeenCalledWith(
      "CREATE",
      SIGNAL_STREAM_KEY,
      SIGNAL_STREAM_GROUP,
      "0",
      "MKSTREAM",
    );
  });

  it("treats BUSYGROUP as success, not failure", async () => {
    const busy = fakeRedis({
      xgroup: vi.fn(async () => {
        throw new Error("BUSYGROUP Consumer Group name already exists");
      }),
    });
    vi.doMock("ioredis", () => ({ Redis: vi.fn(() => busy) }));
    __resetSignalStreamForTests();

    // Must not throw, and must still go on to consume.
    await expect(startDurableSignalConsumer(async () => {})).resolves.toBeUndefined();
    expect(busy.xreadgroup).toHaveBeenCalled();
  });

  it("acks only AFTER a successful persist", async () => {
    const handler = vi.fn(async () => {});
    let deliver: (r: unknown) => void = () => {};
    redis.xreadgroup = vi.fn(
      () => new Promise((res) => { deliver = res as (r: unknown) => void; }),
    ) as never;
    vi.doMock("ioredis", () => ({ Redis: vi.fn(() => redis) }));
    __resetSignalStreamForTests();

    await startDurableSignalConsumer(handler);
    deliver(reply([["1-0", { payload: JSON.stringify({ symbol: "EUR/USD" }) }]]));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(redis.xack).toHaveBeenCalledWith(
      SIGNAL_STREAM_KEY,
      SIGNAL_STREAM_GROUP,
      "1-0",
    );
    // Ordering is the whole contract: the write landed before the ack.
    expect(handler.mock.invocationCallOrder[0]).toBeLessThan(
      (redis.xack as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it("leaves a failed entry UNACKED so it can be reclaimed", async () => {
    const handler = vi.fn(async () => {
      throw new Error("prisma down");
    });
    let deliver: (r: unknown) => void = () => {};
    redis.xreadgroup = vi.fn(
      () => new Promise((res) => { deliver = res as (r: unknown) => void; }),
    ) as never;
    vi.doMock("ioredis", () => ({ Redis: vi.fn(() => redis) }));
    __resetSignalStreamForTests();

    await startDurableSignalConsumer(handler);
    deliver(reply([["2-0", { payload: JSON.stringify({ symbol: "EUR/USD" }) }]]));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // The critical assertion: a DB failure must NOT delete the signal.
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it("reclaims the PEL of a consumer that died mid-write", async () => {
    const handler = vi.fn(async () => {});
    redis.xautoclaim = vi.fn(async () => [
      "0-0",
      // XAUTOCLAIM returns its entry list BARE — no stream-key wrapper.
      [["1-0", ["payload", JSON.stringify({ symbol: "EUR/USD" })]]],
      [],
    ]) as never;
    vi.doMock("ioredis", () => ({ Redis: vi.fn(() => redis) }));
    __resetSignalStreamForTests();

    await startDurableSignalConsumer(handler);

expect(redis.xautoclaim).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // Regression cover for a SECOND live-only bug found in the same audit:
    // a bare positional COUNT makes real Redis 7.4.8 reply "ERR syntax error",
    // which the reclaim catch swallowed, so dead consumers' PEL entries were
    // silently never reclaimed while start-up logged nothing wrong.
    const ac = (redis.xautoclaim as ReturnType<typeof vi.fn>).mock
      .calls[0] as Array<string | number>;
    expect(ac[4]).toBe("0-0");
    expect(ac[5]).toBe("COUNT");
    expect(Number(ac[6])).toBeGreaterThan(0);
    // The orphaned entry is persisted AND acknowledged under the new consumer.
    expect(redis.xack).toHaveBeenCalledWith(
      SIGNAL_STREAM_KEY,
      SIGNAL_STREAM_GROUP,
      "1-0",
    );
  });

  it("sends the XREADGROUP wire format, not a positional helper shape", async () => {
    // Regression cover for a bug only a LIVE Redis could find: the fake client
    // accepted anything, while real Redis rejected the positional call with
    // "ERR wrong number of arguments" and the loop retried forever, reading
    // nothing. ioredis does not synthesise the GROUP/STREAMS keywords.
    await startDurableSignalConsumer(async () => {});
    const args = (redis.xreadgroup as ReturnType<typeof vi.fn>).mock
      .calls[0] as Array<string | number>;

    expect(args[0]).toBe("GROUP");
    expect(args[1]).toBe(SIGNAL_STREAM_GROUP);
    expect(args[2]).toMatch(/^core-\d+-/);
    expect(args).toContain("COUNT");
    expect(args).toContain("BLOCK");
    expect(args).toContain("STREAMS");
    expect(args[args.length - 2]).toBe(SIGNAL_STREAM_KEY);
    // The mandatory stream id: ">" = new messages only. Omitting it makes
    // Redis reply "Unbalanced 'xreadgroup' list of streams".
    expect(args[args.length - 1]).toBe(">");

    const count = Number(args[args.indexOf("COUNT") + 1]);
    const block = Number(args[args.indexOf("BLOCK") + 1]);
    expect(count).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(0);
  });

  it("is idempotent — a second start cannot create a second loop", async () => {
    await startDurableSignalConsumer(async () => {});
    await startDurableSignalConsumer(async () => {});
    expect(redis.xgroup).toHaveBeenCalledTimes(1);
  });
});

/**
 * 6. THE PUBLISH/CONSUME FORMATS MUST MATCH.
 *
 *    XADD writes one JSON field, so a consumer receives
 *    `{ payload: "{\"symbol\":...}" }`. Passing that straight to the
 *    subscriber's extractor finds no `symbol`, returns null, and the entry is
 *    dropped as "unparseable" � the durable half persists ZERO signals while
 *    every health check still looks green. This is the worst possible shape of
 *    bug for a durability feature: it fails silently, in the one direction where
 *    nobody is watching.
 */
describe("unwrapEntryPayload", () => {
  const SIGNAL = {
    symbol: "EUR/USD",
    signal_type: "BUY",
    price: 1.1042,
    confidence: 0.987,
  };

  it("unwraps the single-field envelope written by publishDurableSignal", () => {
    const encoded = JSON.stringify(SIGNAL);
    expect(unwrapEntryPayload({ payload: encoded })).toEqual(SIGNAL);
  });

  it("round-trips a real publish payload back into the signal fields", async () => {
    await publishDurableSignal(SIGNAL);
    const [, , , encoded] = (redis.xadd as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string, string];

    const unwrapped = unwrapEntryPayload({ payload: encoded });

    // What the subscriber extractor needs in order NOT to drop the entry.
    expect(unwrapped.symbol).toBe("EUR/USD");
    expect(unwrapped.signal_type).toBe("BUY");
    expect(Number(unwrapped.price)).toBeGreaterThan(0);
    expect(unwrapped.confidence).toBeDefined();
  });

  it("passes through an already-flat map untouched", () => {
    const flat = { symbol: "GBP/USD", signal_type: "SELL" };
    expect(unwrapEntryPayload(flat)).toBe(flat);
  });

  it("leaves a non-JSON payload field alone instead of throwing", () => {
    const fields = { payload: "not-json" };
    expect(unwrapEntryPayload(fields)).toBe(fields);
  });

  it("leaves a JSON array alone rather than unwrapping to a list", () => {
    const fields = { payload: "[1,2,3]" };
    expect(unwrapEntryPayload(fields)).toBe(fields);
  });

  it("does not throw on malformed JSON", () => {
    expect(() => unwrapEntryPayload({ payload: "{oops" })).not.toThrow();
  });

  it("handles an empty field map", () => {
    expect(unwrapEntryPayload({})).toEqual({});
  });
});

describe("durable consumer end-to-end format", () => {
  beforeEach(() => {
    __resetSignalStreamForTests();
  });

  it("delivers a published signal to the handler as usable fields", async () => {
    const handler = vi.fn(async () => {});
    const SIGNAL = {
      symbol: "EUR/USD",
      signal_type: "BUY",
      price: 1.1042,
      confidence: 0.987,
    };

    // Read back exactly what XADD stored, in the shape XREADGROUP returns.
    await publishDurableSignal(SIGNAL);
    const [, , , encoded] = (redis.xadd as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string, string];
    const stored = [["1-0", ["payload", encoded]]];

    (redis.xreadgroup as ReturnType<typeof vi.fn>).mockResolvedValue([
      [SIGNAL_STREAM_KEY, stored],
    ]);

    await startDurableSignalConsumer(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // The handler receives real fields, not the opaque envelope. Without the
    // unwrap this is `{ payload: "<json>" }` and the subscriber drops it.
    const received = (handler as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(received.symbol).toBe("EUR/USD");
    expect(received.signal_type).toBe("BUY");
  });
});
