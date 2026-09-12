import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

/**
 * Simple in-memory rate limiter middleware.
 *
 * Tracks request counts per IP address within a sliding window.
 * In production, swap this for `express-rate-limit` backed by Redis.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now >= entry.resetAt) {
      store.delete(key);
    }
  }
}, 60_000);

export interface RateLimitOptions {
  /** Max requests allowed within the window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** HTTP status code to return when rate limited */
  statusCode?: number;
}

const defaultOptions: RateLimitOptions = {
  maxRequests: 120,
  windowMs: 60_000, // 1 minute
  statusCode: 429,
};

/**
 * Factory that returns an Express rate-limit middleware.
 */
export function rateLimit(userOptions?: Partial<RateLimitOptions>) {
  const options: RateLimitOptions = { ...defaultOptions, ...userOptions };

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let entry = store.get(ip);

    if (!entry || now >= entry.resetAt) {
      // Start a new window
      entry = { count: 0, resetAt: now + options.windowMs };
      store.set(ip, entry);
    }

    entry.count += 1;

    // Set rate-limit headers
    const remaining = Math.max(0, options.maxRequests - entry.count);
    res.setHeader("X-RateLimit-Limit", options.maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > options.maxRequests) {
      logger.warn("Rate limit exceeded", { ip, path: req.path });
      res.status(options.statusCode!).json({
        error: "Too many requests. Please slow down.",
        retryAfterMs: entry.resetAt - now,
      });
      return;
    }

    next();
  };
}

export default rateLimit;
