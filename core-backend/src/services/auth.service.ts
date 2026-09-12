import { PrismaClient, User } from "@prisma/client";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { secrets } from "../config/secrets";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  token: string;
}

export class AuthService {
  /**
   * Register a new user.
   */
  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new Error("User already exists");
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
      },
    });

    // Create default settings for user
    await prisma.userSettings.create({
      data: { userId: user.id },
    });

    const token = this.generateToken(user);

    logger.info("[AuthService] User registered", { userId: user.id, email });

    return {
      user: { id: user.id, email: user.email, name: user.name },
      token,
    };
  }

  /**
   * Log in an existing user.
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new Error("Invalid credentials");
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error("Invalid credentials");
    }

    const token = this.generateToken(user);

    logger.info("[AuthService] User logged in", { userId: user.id, email });

    return {
      user: { id: user.id, email: user.email, name: user.name },
      token,
    };
  }

  /**
   * Generate a JWT for a user.
   */
  private generateToken(user: User): string {
    return jwt.sign(
      { userId: user.id, email: user.email },
      secrets.JWT_SECRET || "default_secret_change_me",
      { expiresIn: "7d" }
    );
  }

  /**
   * Verify a JWT and return the payload.
   */
  verifyToken(token: string): any {
    try {
      return jwt.verify(token, secrets.JWT_SECRET || "default_secret_change_me");
    } catch {
      return null;
    }
  }
}

export const authService = new AuthService();
