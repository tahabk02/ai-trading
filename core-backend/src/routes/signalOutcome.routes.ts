import { Router } from "express";
import {
  postSignalOutcome,
  getSignalOutcomes,
  getSignalOutcomeStats,
} from "../controllers/signalOutcome.controller";

const router = Router();

// ── PART 5: PERSISTED SIGNAL ACCURACY OUTCOMES ──
router.post("/signal-outcomes", postSignalOutcome);
router.get("/signal-outcomes", getSignalOutcomes);
router.get("/signal-outcomes/stats", getSignalOutcomeStats);

export default router;