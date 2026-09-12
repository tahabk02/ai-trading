/**
 * local-event-bus.ts
 *
 * In-memory EventEmitter-based message bus used as a fallback when Redis
 * is unavailable.  Implements the same Pub/Sub interface as Redis so that
 * RedisSubscriber can swap transparently.
 *
 * Only ONE warning is ever emitted — after that the bus runs silently.
 */

import { EventEmitter } from "events";
import { logger } from "../utils/logger";

export class LocalEventBus {
  private static instance: LocalEventBus;
  private emitter: EventEmitter;
  private fallbackWarningLogged = false;

  private constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100); // allow many channel subscribers
  }

  public static getInstance(): LocalEventBus {
    if (!LocalEventBus.instance) {
      LocalEventBus.instance = new LocalEventBus();
    }
    return LocalEventBus.instance;
  }

  /** Subscribe to a channel (mimics Redis SUBSCRIBE) */
  public async subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void> {
    this.emitter.on(channel, listener);
  }

  /** Unsubscribe from a channel */
  public async unsubscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void> {
    this.emitter.off(channel, listener);
  }

  /** Publish a message to a channel (mimics Redis PUBLISH) */
  public async publish(channel: string, message: string): Promise<void> {
    this.emitter.emit(channel, message);
  }

  /**
   * Log the fallback warning exactly once.
   * Call this when Redis connection fails and we switch to local mode.
   */
  public warnOnce(): void {
    if (!this.fallbackWarningLogged) {
      logger.warn(
        "Redis unavailable: Using local In-Memory EventEmitter fallback",
      );
      this.fallbackWarningLogged = true;
    }
  }

  /** Graceful shutdown — remove all listeners */
  public async shutdown(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}
