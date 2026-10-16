import { Router } from "express";
import {
  createJournalEntry,
  listJournalEntries,
  settleJournalEntry,
} from "../controllers/journal.controller";

const router = Router();

// PART 50 [537] — LOCAL trade journal (nothing is sent to Pocket Option).
router.post("/journal", createJournalEntry);
router.get("/journal", listJournalEntries);
router.patch("/journal/:id/settle", settleJournalEntry);

export default router;
