import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

export interface UserSettingsData {
  timeframe: string;
  confidenceGuardrail: number;
  maxRequestsPerMin: number;
  responseSlaMs: number;
}

export class SettingsService {
  /**
   * Get settings for a user. Creates default settings if none exist.
   */
  async getSettings(userId: string): Promise<UserSettingsData> {
    let settings = await prisma.userSettings.findUnique({
      where: { userId },
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId },
      });
      logger.info("[SettingsService] Created default settings", { userId });
    }

    return {
      timeframe: settings.timeframe,
      confidenceGuardrail: settings.confidenceGuardrail,
      maxRequestsPerMin: settings.maxRequestsPerMin,
      responseSlaMs: settings.responseSlaMs,
    };
  }

  /**
   * Update settings for a user. Returns the updated settings.
   */
  async updateSettings(
    userId: string,
    data: Partial<UserSettingsData>,
  ): Promise<UserSettingsData> {
    // Ensure a settings row exists first
    const existing = await prisma.userSettings.findUnique({
      where: { userId },
    });
    if (!existing) {
      await prisma.userSettings.create({ data: { userId } });
    }

    const updated = await prisma.userSettings.update({
      where: { userId },
      data: {
        ...(data.timeframe !== undefined && { timeframe: data.timeframe }),
        ...(data.confidenceGuardrail !== undefined && {
          confidenceGuardrail: data.confidenceGuardrail,
        }),
        ...(data.maxRequestsPerMin !== undefined && {
          maxRequestsPerMin: data.maxRequestsPerMin,
        }),
        ...(data.responseSlaMs !== undefined && {
          responseSlaMs: data.responseSlaMs,
        }),
      },
    });

    logger.info("[SettingsService] Settings updated", {
      userId,
      changes: data,
    });

    return {
      timeframe: updated.timeframe,
      confidenceGuardrail: updated.confidenceGuardrail,
      maxRequestsPerMin: updated.maxRequestsPerMin,
      responseSlaMs: updated.responseSlaMs,
    };
  }
}

export const settingsService = new SettingsService();
