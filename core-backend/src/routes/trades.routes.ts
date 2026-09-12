import { Router } from "express";
import {
  executeTrade,
  getTradeHistory,
} from "../controllers/trades.controller";

const router = Router();

// ── Trade Execution ──
router.post("/trades", executeTrade);
router.get("/trades", getTradeHistory);

export default router;
