import { Router } from "express";
import {
  getSettings,
  updateSettings,
} from "../controllers/settings.controller";

const router = Router();

// Settings endpoints are accessible without authentication.
// The controllers use a stable default user ID when no JWT is present,
// ensuring local development works out of the box.
router.get("/settings", getSettings);
router.put("/settings", updateSettings);

export default router;
