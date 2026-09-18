import { Router } from "express";
import {
  getSignals,
  getSignalById,
  predictSignal,
  multiPredict,
} from "../controllers/signal.controller";
import { receiveSignal } from "../controllers/receiver.controller";
import { getOrderBook } from "../controllers/orderbook.controller";
import { getSymbols } from "../controllers/symbol.controller";
import { getQuotes } from "../controllers/quotes.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.get("/signals", getSignals);
router.get("/signals/:id", getSignalById);
router.post("/signals/receive", receiveSignal); // Internal endpoint for AI Engine fallback
router.post("/predict", predictSignal); // Proxy to Python AI Engine /api/v1/predict
router.post("/multi-predict", multiPredict); // Market-terminal batch prediction
router.get("/orderbook", getOrderBook); // Real order book from Binance/Alpaca
router.get("/symbols", getSymbols); // Symbol registry for autocomplete
router.get("/quotes", getQuotes); // All-pairs live quotes snapshot (market terminal)

export default router;
