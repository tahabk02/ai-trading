import { logger } from "./logger";

export interface OHLCV {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MarketDataValidator {
  /**
   * Validates a dataset of OHLCV candles.
   * Ensures it is a non-empty array and every element has valid numeric OHLCV properties.
   */
  public static validateOHLCVArray(data: any): OHLCV[] {
    if (!Array.isArray(data)) {
      const error = `Invalid data format: Expected array, got ${typeof data}`;
      logger.error(`[MarketDataValidator] ${error}`);
      throw new Error(error);
    }

    if (data.length === 0) {
      logger.warn("[MarketDataValidator] Validation failed: Array is empty");
      return [];
    }

    const validated: OHLCV[] = [];

    for (let i = 0; i < data.length; i++) {
      const entry = data[i];
      
      // Strict existence and type checks
      const time = Number(entry.time || entry.timestamp);
      const open = Number(entry.open);
      const high = Number(entry.high);
      const low = Number(entry.low);
      const close = Number(entry.close);
      const volume = Number(entry.volume ?? 0);

      const isValid = 
        Number.isFinite(time) &&
        Number.isFinite(open) &&
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close) &&
        Number.isFinite(volume);

      if (!isValid) {
        logger.error("[MarketDataValidator] Malformed candle at index " + i, { entry });
        continue; // Skip malformed entries to prevent downstream crashes
      }

      // Ensure time is in seconds (Unix timestamp)
      // If time is > 10^12, it's likely in milliseconds
      const normalizedTime = time > 1000000000000 ? Math.floor(time / 1000) : Math.floor(time);

      validated.push({
        time: normalizedTime,
        open,
        high,
        low,
        close,
        volume
      });
    }

    // Lightweight-charts requires data to be sorted by time ascending
    return validated.sort((a, b) => a.time - b.time);
  }

  /**
   * Validates a single live tick update.
   */
  public static validateTick(data: any): OHLCV | null {
    if (!data || typeof data !== "object") return null;

    const time = Number(data.time || data.timestamp || Date.now());
    const open = Number(data.open || data.price);
    const high = Number(data.high || data.price);
    const low = Number(data.low || data.price);
    const close = Number(data.price || data.close);
    const volume = Number(data.volume ?? 0);

    const isValid = 
      Number.isFinite(time) &&
      Number.isFinite(open) &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close);

    if (!isValid) return null;

    return {
      time: time > 1000000000000 ? Math.floor(time / 1000) : Math.floor(time),
      open,
      high,
      low,
      close,
      volume
    };
  }
}
