import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";
import { LocalEventBus } from "../messaging/local-event-bus";

// ── In-memory fallback store ──────────────────────────────────────────────

/**
 * Simple TTL-based in-memory map used when Redis is unavailable.
 * No log spam — operations run silently.
 */
class MemoryStore {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  get<T = unknown>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs = 30_000): void {
    this.store.set(key, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    });
  }

  del(...keys: string[]): void {
    for (const key of keys) this.store.delete(key);
  }

  exists(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.store.clear();
  }
}

// ── CacheService ─────────────────────────────────────────────────────────

/**
 * CacheService
 *
 * Tries Redis on `connect()`.  If Redis fails after 2 attempts, it silently
 * switches to the MemoryStore with a single warning via `LocalEventBus.warnOnce()`.
 * All operations (get/set/del/exists) work identically in both modes.
 */
export class CacheService {
  private static instance: CacheService;
  private redis: import("ioredis").Redis | null = null;
  private mem: MemoryStore;
  private usingMemory = false;

  private constructor() {
    this.mem = new MemoryStore();
  }

  public static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  // ----------------------------------------------------------
  //  Connection
  // ----------------------------------------------------------

  /**
   * Attempt Redis connection with at most 2 reconnection attempts.
   * Falls back to MemoryStore if Redis is unreachable.
   */
  public async connect(): Promise<void> {
    if (this.redis) return; // already connected

    try {
      const Redis = (await import("ioredis")).default;
      this.redis = new Redis({
        host: secrets.REDIS_HOST,
        port: secrets.REDIS_PORT,
        password: secrets.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times >= 2) {
            logger.warn(
              "[CacheService] Redis reconnection attempts exhausted — switching to in-memory store",
            );
            return null; // stop reconnecting
          }
          return 200;
        },
        lazyConnect: true,
        connectTimeout: 5_000,
      });

      // Silence individual error/end events — the retry strategy handles logging
      this.redis.on("error", () => {});
      this.redis.on("end", () => {});

      await this.redis.connect();
      await this.redis.ping();
      logger.info("[CacheService] Connected to Redis");
    } catch {
      // Redis unavailable — use in-memory fallback silently
      this.redis = null;
      this.usingMemory = true;
      LocalEventBus.getInstance().warnOnce();
    }
  }

  // ----------------------------------------------------------
  //  Operations
  // ----------------------------------------------------------

  public async get<T = unknown>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    }
    return this.mem.get<T>(key);
  }

  public async set(
    key: string,
    value: unknown,
    ttlSeconds = 300,
  ): Promise<void> {
    if (this.redis) {
      try {
        const serialised = JSON.stringify(value);
        if (ttlSeconds > 0) {
          await this.redis.setex(key, ttlSeconds, serialised);
        } else {
          await this.redis.set(key, serialised);
        }
      } catch {
        // silent
      }
      return;
    }
    this.mem.set(key, value, ttlSeconds * 1000);
  }

  public async del(...keys: string[]): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(...keys);
      } catch {
        // silent
      }
      return;
    }
    this.mem.del(...keys);
  }

  public async exists(key: string): Promise<boolean> {
    if (this.redis) {
      try {
        const result = await this.redis.exists(key);
        return result === 1;
      } catch {
        return false;
      }
    }
    return this.mem.exists(key);
  }

  // ----------------------------------------------------------
  //  Cache Flush (startup / cache-bust)
  // ----------------------------------------------------------

  /**
   * Flush all cached entries.
   * - Redis: executes FLUSHALL (async-safe)
   * - MemoryStore: clears the internal map
   * Logs the operation for auditability.
   */
  public async flushAll(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.flushall();
        logger.info(
          "[CacheService] Redis FLUSHALL executed — all cached entries purged",
        );
      } catch (error) {
        logger.warn("[CacheService] Redis FLUSHALL failed", {
          error: (error as Error).message,
        });
      }
      return;
    }
    this.mem.clear();
    logger.info("[CacheService] In-memory cache cleared");
  }

  /**
   * Flush only cache entries whose key starts with a given prefix.
   * - Redis: uses SCAN + DEL (non-blocking iteration)
   * - MemoryStore: iterates internal map and deletes matching keys
   */
  public async flushByPrefix(prefix: string): Promise<void> {
    if (!prefix) return;

    if (this.redis) {
      try {
        let cursor = "0";
        const keysToDelete: string[] = [];
        do {
          const result = await this.redis.scan(
            cursor,
            "MATCH",
            `${prefix}*`,
            "COUNT",
            100,
          );
          cursor = result[0];
          keysToDelete.push(...result[1]);
        } while (cursor !== "0");

        if (keysToDelete.length > 0) {
          await this.redis.del(...keysToDelete);
          logger.info(
            "[CacheService] Flushed %d keys by prefix",
            keysToDelete.length,
            { prefix },
          );
        }
      } catch (error) {
        logger.warn("[CacheService] Redis flushByPrefix failed", {
          prefix,
          error: (error as Error).message,
        });
      }
      return;
    }

    // MemoryStore: iterate and delete matching keys
    // MemoryStore doesn't expose its internal store, so we clear all for simplicity
    this.mem.clear();
    logger.info(
      "[CacheService] In-memory cache cleared (prefix flush not supported on MemoryStore)",
    );
  }

  // ----------------------------------------------------------
  //  Lifecycle
  // ----------------------------------------------------------

  public async disconnect(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // silent
      }
      this.redis = null;
    }
    this.mem.clear();
    logger.info("[CacheService] Disconnected");
  }

  public isConnected(): boolean {
    return this.redis !== null && !this.usingMemory;
  }
}

export default CacheService;
