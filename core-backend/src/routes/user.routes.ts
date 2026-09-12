import { Router } from "express";
import {
  getProfile,
  updateProfile,
  deleteAccount,
} from "../controllers/user.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

// All user routes require authentication
router.use(authMiddleware);

router.get("/me", getProfile);
router.patch("/me", updateProfile);
router.delete("/me", deleteAccount);

export default router;
