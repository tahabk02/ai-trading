import { Request, Response } from "express";
import { authService } from "../services/auth.service";
import { logger } from "../utils/logger";

export class AuthController {
  async register(req: Request, res: Response) {
    try {
      const { email, password, name } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const result = await authService.register(email, password, name);
      return res.status(201).json(result);
    } catch (error: any) {
      logger.error("[AuthController] Registration failed", { error: error.message });
      return res.status(400).json({ error: error.message });
    }
  }

  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const result = await authService.login(email, password);
      return res.json(result);
    } catch (error: any) {
      logger.error("[AuthController] Login failed", { error: error.message });
      return res.status(401).json({ error: error.message });
    }
  }

  async me(req: Request, res: Response) {
    // req.user is attached by authMiddleware
    if (!(req as any).user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.json({ user: (req as any).user });
  }
}

export const authController = new AuthController();
