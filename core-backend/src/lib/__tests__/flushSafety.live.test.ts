import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CacheService } from "../../services/cache.service";

const REDIS = "redis://localhost:6379";

function mkRedis() {
  // Lazy require so the test file stays importable without a live Redis.
  const { Redis } = require("ioredis");
  return new Redis(REDIS, { maxRetriesPerRequest: 1, commandTimeout: 5000, retryStrategy: () => null });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRedis(redis: any, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await redis.ping();
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

/** Skip cleanly when no Redis is reachable, so the suite stays portable. */
async function redisOrSkip() {
  const redis = mkRedis();
  redis.on("error", () => undefined);
  if (!(await waitForRedis(redis))) {
    await redis.quit().catch(() => undefined);
    return null;
  }
  return redis;
}

describe("start-up cache flush does not destroy durable data", () => {
  let redis: any;

  beforeAll(async () => {
    redis = await redisOrSkip();
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit().catch(() => undefined);
    }
  });

  it("leaves the durable signal stream and its consumer group intact", async () => {
    if (!redis) return; // no live Redis: nothing to assert against

    // Must use the REAL production key, not a test double: the protection is
    // prefix-based, so a key named "test:flush_safety:stream" is correctly NOT
    // protected and would make this assertion meaningless.
    const KEY = "trading_signals:test:flush_safety";
    const GROUP = "test-flush-group";

    await redis.del(KEY);
    await redis.xgroup("CREATE", KEY, GROUP, "0", "MKSTREAM");
    await redis.xadd(KEY, "*", "payload", JSON.stringify({ symbol: "EUR/USD" }));

    const before = await redis.xlen(KEY);
    expect(before).toBeGreaterThan(0);

    const svc = CacheService.getInstance();
    await svc.connect();

    // Guard against a VACUOUS pass: if CacheService silently fell back to the
    // in-memory store it never touches Redis at all, so the assertions below
    // would hold no matter what flushAll did.
    expect(svc.isConnected()).toBe(true);

    await svc.flushAll();
    await svc.flushByPrefix("otc_forex_");

    // The regression: FLUSHALL used to wipe the stream here, silently
    // discarding every signal not yet written to Postgres.
    const after = await redis.xlen(KEY);
    expect(after).toBe(before);

    const groups = await redis.xinfo("GROUPS", KEY);
    expect(groups.map((g: string[]) => g[1])).toContain(GROUP);

    await redis.del(KEY);
  }, 20000);
});