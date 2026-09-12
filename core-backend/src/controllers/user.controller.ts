import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();

/**
 * Get the authenticated user's profile.
 * Expects `req.user` to be populated by authMiddleware.
 */
export const getProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json(user);
  } catch (error) {
    logger.error("Error fetching user profile", { error });
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

/**
 * Update the authenticated user's profile.
 * Currently supports updating the `name` field.
 */
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { name } = req.body;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { name: name ?? undefined },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    return res.json(updated);
  } catch (error) {
    logger.error("Error updating user profile", { error });
    return res.status(500).json({ error: "Failed to update profile" });
  }
};

/**
 * Delete the authenticated user's account.
 */
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    await prisma.user.delete({ where: { id: userId } });

    logger.info("User account deleted", { userId });
    return res.json({ message: "Account deleted successfully" });
  } catch (error) {
    logger.error("Error deleting user account", { error });
    return res.status(500).json({ error: "Failed to delete account" });
  }
};
