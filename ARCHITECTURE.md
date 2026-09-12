# Trading AI Platform — Architecture & Technical Documentation

> **Author:** Enterprise Architecture Review  
> **Date:** 2025  
> **Version:** 1.0

---

## 1. PROJECT OVERVIEW & GOALS

### Core Purpose

The **Trading AI Platform** is a real-time algorithmic trading terminal that combines machine learning inference with live market data to generate predictive BUY/SELL/HOLD signals for stocks and cryptocurrencies. It provides a unified dashboard where users can view live prices, AI confidence scores, technical indicators, and order book depth — all rendered from a single source of truth.

### Target Users

| User Type                 | Need                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| **Retail Traders**        | Real-time price action + AI-predicted direction without managing ML infrastructure |
| **Quantitative Analysts** | Access to Random Forest model outputs (ML probability, confidence, accuracy)       |
| **Portfolio Managers**    | Alpha stream of signals across multiple symbols for rebalancing decisions          |
| **System Integrators**    | REST API endpoints for consuming predictions into external trading systems         |

### Problem Solved

- **Information Fragmentation:** Existing solutions scatter price data across widgets with different refresh cycles, causing conflicting numbers. This platform enforces a unified `currentPrice` single source of truth.
- **ML Ops Complexity:** The platform abstracts away model training, retraining, and inference into a seamless pipeline — users see predictions without needing to manage Jupyter notebooks or model registries.
- **Real-Time Decision Gap:** Many trading terminals use static OHLC charts without live ML overlays. This platform fuses live Alpaca snapshots with Random Forest inference in a single atomic update.

---

## 2. SYSTEM ARCHITECTURE & COMPONENTS

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENT (Next.js 14)                          │
│  Port 3000                                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Dashboard Page (dashboard/page.tsx)                     │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │  │
│  │  │TVChart   │  │OrderBook │  │PredictiveIntelligence│   │  │
│  │  │(Trading  │  │(depth +  │  │(signal badge, conf,  │   │  │
│  │  │View)     │  │spread)   │  │indicators, gauge)    │   │  │
│  │  └──────────┘  └──────────┘  └──────────────────────┘   │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │  Alpha Stream (SignalWidget list)                │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  State: Zustand (useTradingStore, useAuthStore)                │
│  Polling: useWebSocket hook (single source)                    │
│  HTTP: Axios (api.ts)                                          │
│  Errors: GlobalErrorBoundary + individual selectors            │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (Next.js rewrites proxy /api/* → :4000)
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│              CORE BACKEND (Node.js + Express)                    │
│              Port 4000                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Routes:                                                  │  │
│  │  POST /api/v1/predict      → signal.controller.predict   │  │
│  │  GET  /api/v1/signals      → signal.controller.getSignals│  │
│  │  GET  /api/v1/signals/:id  → signal.controller.getById   │  │
│  │  POST /api/v1/auth/register→ auth.controller             │  │
│  │  POST /api/v1/auth/login   → auth.controller             │  │
│  │  GET  /api/v1/users/me     → user.controller             │  │
│  │  GET  /health              → health check                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Services:                                                │  │
│  │  AlpacaMarketDataService → fetches bars + snapshots       │  │
│  │  PredictionService      → Prisma persistence             │  │
│  │  CacheService           → Redis / in-memory fallback     │  │
│  │  WebSocketService       → Socket.IO broadcast            │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Middleware:                                              │  │
│  │  auth.middleware   → JWT verification                    │  │
│  │  rateLimit.middleware → per-IP rate limiting             │  │
│  │  error.middleware  → global error handler                │  │
│  │  requestLogger     → Winston-based HTTP logging          │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (POST /api/v1/predict with candles)
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│              AI ENGINE (Python FastAPI)                          │
│              Port 8000                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Endpoints:                                               │  │
│  │  POST /api/v1/predict  → ML inference pipeline           │  │
│  │  POST /api/v1/analyze  → market analysis trigger         │  │
│  │  GET  /api/v1/status   → engine health                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ML Pipeline:                                             │  │
│  │  ml_predictor.py → RandomForest (150 estimators)         │  │
│  │  signal_generator.py → 3-layer (ADX/ATR/regime)          │  │
│  │  technical_analysis.py → RSI, SMA, ATR, ADX, MACD        │  │
│  │  risk_filter.py → confidence-based signal filtering      │  │
│  │  fundamental_analysis.py → (extensible)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Data Sources:                                            │  │
│  │  MarketDataCollector → Binance (crypto fallback)         │  │
│  │  yfinance → stock data (fallback if no candles)          │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              EXECUTION ENGINE (Python FastAPI)                   │
│              Port 8001 (orchestrates trades)                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Broker Clients:                                          │  │
│  │  alpaca_client.py → Alpaca trading API                    │  │
│  │  binance_client.py → Binance spot/futures                 │  │
│  │  order_manager.py → order lifecycle                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Risk Management:                                        │  │
│  │  position_sizing.py → Kelly / fixed fraction             │  │
│  │  stop_loss_manager.py → trailing + hard stops            │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Reconciliation:                                         │  │
│  │  trade_logger.py → fills + settlement tracking           │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

External Services:
  Alpaca Market Data API  ◄── Core Backend (bars, snapshots)
  Alpaca Trading API      ◄── Execution Engine (orders)
  Binance API             ◄── AI Engine (crypto fallback)
  TradingView Widget      ◄── Client (chart, no backend)
```

### 2.1 Frontend Architecture

| Layer                | Technology                                               | Details                                                                                                                    |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Framework**        | Next.js 14 (App Router)                                  | `client-app/` — Pages: `/(dashboard)/dashboard`, `/(auth)/register`, `/settings`                                           |
| **UI Library**       | React 18 + Tailwind CSS                                  | Dark theme, `globals.css` with custom scrollbar, `tailwind.config.js` with extended palette                                |
| **State Management** | Zustand                                                  | `useTradingStore` (trading state), `useAuthStore` (auth state) — individual primitive selectors to prevent re-render loops |
| **HTTP Client**      | Axios                                                    | `api.ts` — base URL auto-detects Dev Tunnel vs localhost, request/response interceptors for JWT + 401 redirect             |
| **Real-Time**        | HTTP Polling (30s interval)                              | `useWebSocket` hook — single orchestrator, no Socket.IO dependency                                                         |
| **Charts**           | TradingView widget (TVChart) + Recharts (FinancialChart) | TVChart for main chart, FinancialChart for SMA overlays with `suppressHydrationWarning`                                    |
| **Error Boundary**   | GlobalErrorBoundary                                      | Suppresses extension errors (MetaMask, monica, etc.) via `window.addEventListener('unhandledrejection')`                   |

**Key Design Decisions:**

- **Primitive selectors** over aggregate object selectors to prevent infinite re-render loops (Zustand `Object.is` comparison)
- **Single polling source** (`useWebSocket`) instead of duplicate `setInterval` + `useWebSocket` race condition
- **`suppressHydrationWarning`** on `<html>` to suppress extension-injected attributes (monica-id, etc.)

### 2.2 Backend Services

#### Core Backend (Node.js + Express, Port 4000)

| Service                         | Responsibility                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **signal.controller.ts**        | Prediction pipeline orchestrator: fetches Alpaca bars → forwards to AI Engine → returns unified response with `current_price` + `currentPrice` (dual casing)               |
| **alpacaMarketData.service.ts** | Fetches historical bars (`/v2/stocks/{symbol}/bars`) and live snapshots (`/v2/stocks/{symbol}/snapshot`). Market-closed fallback auto-retries with historical `start` date |
| **prediction.service.ts**       | Prisma persistence layer for predictions with retry logic (3 attempts, exponential backoff)                                                                                |
| **cache.service.ts**            | Redis (preferred) / in-memory fallback with TTL. Flushes all cache on startup (`flushAll()` + `flushByPrefix('alpaca_quote_')`)                                            |
| **websocket.service.ts**        | Socket.IO server for real-time signal broadcast (`new_signal`, `symbol_update`, `engine_status`)                                                                           |

**Fallback Chain (predictSignal):**

1. ✅ Fetch 150+ bars from Alpaca + live snapshot price
2. ✅ Forward bars + `live_price` to Python AI Engine (POST /api/v1/predict)
3. ✅ If AI Engine fails → compute RSI/SMA/ATR/ADX locally from Alpaca bars
4. ✅ If Alpaca bars insufficient → try AI Engine with yfinance fallback
5. ✅ If everything fails → deterministic fallback with live Alpaca snapshot price (never 502)

#### AI Engine (Python FastAPI, Port 8000)

| Module                    | Function                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ml_predictor.py**       | RandomForestClassifier (150 estimators, max_depth=8, class_weight='balanced'). Retrains on every request — zero stale cache. Feature engineering: RSI, SMA crossovers, ATR, ADX, volatility, MACD, price position |
| **signal_generator.py**   | 3-layer signal generator (ADX trend filter → ATR volatility → regime detection)                                                                                                                                   |
| **technical_analysis.py** | Pure NumPy implementation of RSI, SMA, ATR, ADX, MACD, Bollinger Bands                                                                                                                                            |
| **risk_filter.py**        | Confidence-based signal filtering with threshold from config                                                                                                                                                      |

**Production Mandates (enforced in code):**

- `live_price` is **required** — AI Engine rejects requests without it
- `current_price` must be the Alpaca snapshot live price, never a bar close
- `target_price` derived dynamically from `current_price + ATR * 3.0` (BUY) / `- ATR * 3.0` (SELL)
- Model retrained on every request — no stale `.joblib` cache files loaded

#### Execution Engine (Python FastAPI, Port 8001)

| Module                   | Function                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| **alpaca_client.py**     | Alpaca Trading API client for order placement (market, limit, stop-loss) |
| **binance_client.py**    | Binance REST API client for crypto order execution                       |
| **order_manager.py**     | Order lifecycle management (create, cancel, replace, track fills)        |
| **position_sizing.py**   | Kelly Criterion / fixed fraction position sizing                         |
| **stop_loss_manager.py** | Trailing stop-loss + hard stop-loss management                           |
| **trade_logger.py**      | Trade reconciliation and settlement tracking                             |

### 2.3 Database & Storage

#### Prisma (PostgreSQL / SQLite)

| Model          | Key Fields                                                                                                                                                  | Purpose                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Prediction** | `id`, `symbol`, `signal`, `confidence`, `targetPrice`, `currentPrice`, `mlProbability`, `modelAccuracy`, `rsi14`, `sma20`, `sma50`, `timeframe`, `metadata` | Persisting AI prediction results  |
| **Signal**     | `id`, `symbol`, `signalType`, `price`, `confidence`, `createdAt`, `indicators`                                                                              | Storing generated trading signals |
| **User**       | `id`, `email`, `password`, `name`                                                                                                                           | Authentication                    |

#### Caching Layer

| Cache                      | Backend         | TTL          | Purpose                                               |
| -------------------------- | --------------- | ------------ | ----------------------------------------------------- |
| **Redis** (preferred)      | `ioredis`       | 300s default | Price quotes, prediction results, rate limit counters |
| **MemoryStore** (fallback) | In-memory `Map` | 300s default | Used when Redis is unavailable                        |

**Cache Flush on Startup:**

```typescript
cacheService.flushAll(); // FLUSHALL on Redis / clear() on MemoryStore
cacheService.flushByPrefix("alpaca_quote_"); // SCAN + DEL for price quotes
```

---

## 3. INTEGRATIONS & EXTERNAL SERVICES

### 3.1 Market Data Providers

| Provider                | Endpoint                           | Data                        | Frequency               |
| ----------------------- | ---------------------------------- | --------------------------- | ----------------------- |
| **Alpaca Market Data**  | `GET /v2/stocks/{symbol}/bars`     | Historical OHLCV bars       | Per request (150+ bars) |
| **Alpaca Market Data**  | `GET /v2/stocks/{symbol}/snapshot` | Latest trade price, bid/ask | Per request             |
| **Binance** (fallback)  | `fetch_historical_candles()`       | Crypto OHLCV                | Per request (AI Engine) |
| **yfinance** (fallback) | `yfinance.download()`              | Stock data                  | Per request (AI Engine) |

### 3.2 Real-Time Communication

```
┌──────────┐     HTTP Poll (30s)     ┌──────────────┐
│  Client  │ ──────────────────────► │  Core Backend│
│ (Next.js)│ ◄────────────────────── │  Port 4000   │
│          │     JSON Response       │              │
└──────────┘                         └──────┬───────┘
                                            │ Socket.IO
                                            ▼
                                     ┌──────────────┐
                                     │  WebSocket   │
                                     │  Clients     │
                                     └──────────────┘
```

| Channel         | Event            | Payload                                   | Frequency          |
| --------------- | ---------------- | ----------------------------------------- | ------------------ | -------------------- | ------------------------ |
| `new_signal`    | Global broadcast | `{symbol, signalType, price, confidence}` | On each prediction |
| `symbol_update` | Room-specific    | `{symbol, signalType, price, confidence}` | On each prediction |
| `engine_status` | Global broadcast | `{status: 'ONLINE'                        | 'DEGRADED'         | 'OFFLINE', message}` | On startup / degradation |

**Note:** The frontend currently uses HTTP polling (30s interval) via `useWebSocket` hook, not Socket.IO. The Socket.IO server exists on the backend but the frontend switched to polling because the Python FastAPI backend (port 4000) doesn't support WebSocket. The `useWebSocket` hook exposes the same `{ connected, subscribeSymbol, unsubscribeSymbol }` interface for API compatibility.

### 3.3 ML / AI Prediction Pipeline

```
┌──────────────┐    150 bars + live_price     ┌──────────────────┐
│  Core        │ ────────────────────────────► │  AI Engine       │
│  Backend     │                               │  (Port 8000)     │
│  (Port 4000) │ ◄──────────────────────────── │                  │
│              │    {signal, confidence,       │  1. Feature Eng  │
│              │     target_price,             │  2. RandomForest │
│              │     current_price,            │  3. Signal Gen   │
│              │     indicators, ...}          │     (fallback)   │
└──────┬───────┘                               └──────────────────┘
       │
       │ Alpaca API
       ▼
┌──────────────┐
│  Alpaca      │
│  Market Data │
│  API         │
└──────────────┘
```

**Pipeline Steps:**

1. Core Backend fetches 150 bars + live snapshot from Alpaca
2. Core Backend forwards bars + `live_price` to AI Engine
3. AI Engine computes features (RSI, SMA, ATR, ADX, MACD, volatility, price position)
4. RandomForest classifier predicts probability of upward movement
5. Signal derived: `BUY` (prob ≥ 0.65 & RSI < 75), `SELL` (prob ≤ 0.35 & RSI > 25), `HOLD` (otherwise)
6. `target_price` computed dynamically: `current_price + ATR * 3.0` (BUY), `current_price - ATR * 3.0` (SELL)
7. Response returned with dual-cased `current_price` / `currentPrice` for frontend compatibility

---

## 4. IDENTIFIED BUGS & TECHNICAL DEBT

### 4.1 ✅ Resolved: Widget Re-Render Loop (Infinite Refresh)

**Root Cause:** Aggregate Zustand selector `selectPredictionState` returned a new object `{...}` on every invocation. Since `Object.is({}, {}) === false`, React re-rendered the entire Dashboard on every store update — including unrelated fields like `_priceVersion`, `isLoading`, `orderBook`.

**Fix Applied:**

- Replaced aggregate selectors with **individual primitive selectors** (`selectCurrentPrice`, `selectPredictionData`, `selectActiveSymbol`, `selectIsLoading`, `selectError`, etc.)
- Each selector returns a `string`, `number`, `boolean`, or `null` — primitive values that only change when the actual value changes
- Dashboard now subscribes to 9 individual selectors instead of 1 aggregate object

**Files Changed:**

- `client-app/src/store/useTradingStore.ts` — Added `selectCurrentPrice`, `selectActiveSymbol`, `selectPredictionData`, etc.
- `client-app/src/app/(dashboard)/dashboard/page.tsx` — Switched to individual selectors
- `client-app/src/components/trading/signal-widget.tsx` — Switched to `selectCurrentPrice`

### 4.2 ✅ Resolved: Price Desynchronization Across Components

**Root Cause:** Two separate polling paths (dashboard's `setInterval` + `useWebSocket`'s `setInterval`) both called `getPrediction()` and `addLiveSignal()` independently, creating a race condition where different components read different `currentPrice` values.

**Fix Applied:**

- Consolidated to **single polling orchestrator** in `useWebSocket` hook
- Dashboard's duplicate `setInterval` removed — all polling flows through `useWebSocket` alone
- `useWebSocket` now calls `getPrediction()` directly (not `addLiveSignal()`)
- `getPrediction()` atomically updates BOTH `predictionData` AND `currentPrice` in a single `set()` call
- Added `_priceVersion` counter incremented on every atomic update to force re-renders

**Files Changed:**

- `client-app/src/hooks/useWebSocket.ts` — Refactored to single orchestrator
- `client-app/src/store/useTradingStore.ts` — Added `flushPriceCache()`, `_priceVersion`, fixed `addLiveSignal`
- `client-app/src/app/(dashboard)/dashboard/page.tsx` — Removed duplicate `setInterval`

### 4.3 ✅ Resolved: Extension-Injected Hydration Warnings

**Root Cause:** Browser extensions (Monica AI, Grammarly, etc.) inject attributes like `monica-id`, `monica-version` into the `<html>` element. React's strict hydration checking detected these mismatches between server-rendered HTML and client HTML, logging warnings to console.

**Fix Applied:**

- Added `suppressHydrationWarning` to `<html>` element in `layout.tsx`
- Added `/monica/i`, `/monica-id/i`, `/monica-version/i` to `GlobalErrorBoundary`'s extension error patterns

**Files Changed:**

- `client-app/src/app/layout.tsx` — Added `suppressHydrationWarning`
- `client-app/src/components/shared/GlobalErrorBoundary.tsx` — Added monica patterns

### 4.4 ✅ Resolved: Web3/MetaMask Console Errors

**Root Cause:** The MetaMask browser extension injects `window.ethereum` and attempts to auto-connect on page load. When MetaMask is locked or misconfigured, it throws unhandled promise rejections that pollute the console.

**Fix Applied:**

- `GlobalErrorBoundary` already catches `unhandledrejection` events matching `ethereum`, `MetaMask`, `window.ethereum`, `Failed to connect to MetaMask` patterns
- No code in the application references `window.ethereum` — MetaMask errors come exclusively from the extension itself

**Files Changed:**

- `client-app/src/components/shared/GlobalErrorBoundary.tsx` — Pre-existing patterns catch all MetaMask errors

### 4.5 ⚠️ Open: WebSocket 404/403 Routing Mismatch

**Issue:** The Socket.IO server on port 4000 uses `/socket.io/` as its default path. The Next.js rewrites in `next.config.js` proxy `/socket.io/:path*` → `http://localhost:4000/socket.io/:path*`. However, the frontend switched to HTTP polling and no longer uses Socket.IO, so the WebSocket server is unused.

**Impact:** Low — the polling path works correctly. However, the Socket.IO server is operational and could be used for push-based updates if needed.

**Remediation:**

- Either remove Socket.IO entirely (simplify) or re-enable it on the frontend with a proper Socket.IO client library
- If keeping, ensure the client imports `socket.io-client` and connects to the correct URL

### 4.6 ⚠️ Open: No Authentication on `/api/v1/predict`

**Issue:** The `POST /api/v1/predict` endpoint in `signal.routes.ts` does not use `authMiddleware`. The `predict` route is mounted before the auth middleware check.

**Impact:** Medium — the prediction endpoint is publicly accessible without authentication. This is intentional for the current development phase but should be secured before production.

**Remediation:**

- Add `authMiddleware` to the predict route: `router.post("/predict", authMiddleware, predictSignal);`
- Or add a separate API key check for machine-to-machine calls

### 4.7 ⚠️ Open: No Rate Limiting on Prediction Endpoint

**Issue:** The prediction endpoint triggers expensive operations (Alpaca API calls, ML model training) on every request. Without rate limiting, a malicious or buggy client could exhaust API quotas.

**Impact:** Medium — the `rateLimit.middleware.ts` exists but may not be tuned for the predict endpoint's resource intensity.

**Remediation:**

- Implement per-symbol caching (e.g., cache predictions for 30s, return cached result for same symbol)
- Add stricter rate limits for `/predict` than for read-only endpoints

---

## 5. STEP-BY-STEP IMPLEMENTATION ROADMAP

### Priority: P0 (Critical — Must Fix Before Production)

| #   | Task                                                                                | Component    | Effort | Dependencies |
| --- | ----------------------------------------------------------------------------------- | ------------ | ------ | ------------ |
| 1   | ✅ **Fix re-render loop** — Switch to primitive selectors                           | Frontend     | Done   | —            |
| 2   | ✅ **Fix price desync** — Single polling source                                     | Frontend     | Done   | #1           |
| 3   | ✅ **Suppress extension errors** — GlobalErrorBoundary + `suppressHydrationWarning` | Frontend     | Done   | —            |
| 4   | **Add auth middleware to `/predict`**                                               | Core Backend | 1h     | —            |
| 5   | **Add prediction caching** — Return cached result for same symbol within 30s        | Core Backend | 2h     | —            |
| 6   | **Tune rate limits** — Stricter limits for `/predict`                               | Core Backend | 1h     | —            |

### Priority: P1 (High — Needed for Reliability)

| #   | Task                                                                                                              | Component                | Effort | Dependencies |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ------ | ------------ |
| 7   | **Add health check for AI Engine** — Core Backend should verify AI Engine is reachable before forwarding requests | Core Backend             | 2h     | —            |
| 8   | **Add circuit breaker for Alpaca API** — If Alpaca returns errors, fall back to cached data instead of failing    | Core Backend             | 3h     | —            |
| 9   | **Add request tracing** — Add `X-Request-ID` header to all requests for debugging                                 | Core Backend + AI Engine | 2h     | —            |
| 10  | **Add structured logging** — Ensure all services log in JSON format for log aggregation                           | All Services             | 2h     | —            |
| 11  | **Add Prometheus metrics** — Request count, latency, error rate per endpoint                                      | Core Backend             | 3h     | —            |

### Priority: P2 (Medium — Feature Completeness)

| #   | Task                                                                                | Component                   | Effort | Dependencies |
| --- | ----------------------------------------------------------------------------------- | --------------------------- | ------ | ------------ |
| 12  | **Re-enable WebSocket** — Add `socket.io-client` to frontend for push-based updates | Frontend                    | 4h     | #1, #2       |
| 13  | **Add signal history page** — View historical predictions with filtering            | Frontend                    | 6h     | —            |
| 14  | **Add portfolio tracking** — Track holdings, P&L, and position sizing               | Frontend + Execution Engine | 8h     | —            |
| 15  | **Add multi-timeframe support** — Allow users to select 1h, 4h, 1d, 1w              | Frontend + AI Engine        | 4h     | —            |
| 16  | **Add dark/light theme toggle** — Extend Tailwind theme                             | Frontend                    | 2h     | —            |

### Priority: P3 (Low — Nice to Have)

| #   | Task                                                                                               | Component          | Effort | Dependencies |
| --- | -------------------------------------------------------------------------------------------------- | ------------------ | ------ | ------------ |
| 17  | **Add user preferences** — Save symbol watchlist, theme, default timeframe                         | Frontend + Backend | 6h     | #16          |
| 18  | **Add email notifications** — Send alerts when confidence ≥ threshold                              | Core Backend       | 4h     | —            |
| 19  | **Add mobile responsive improvements** — Optimize chart and order book for mobile                  | Frontend           | 4h     | —            |
| 20  | **Add i18n for Arabic/French** — Extend `useLang.ts` and `i18n.ts`                                 | Frontend           | 3h     | —            |
| 21  | **Add Docker Compose health checks** — Ensure all services report healthy before accepting traffic | Infrastructure     | 2h     | —            |

### Testing Roadmap

| #   | Task                                                                                              | Component                | Effort |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------ | ------ |
| T1  | **Unit tests for Zustand selectors** — Verify primitive selectors return correct values           | Frontend                 | 2h     |
| T2  | **Unit tests for prediction pipeline** — Mock Alpaca + AI Engine, verify fallback chain           | Core Backend             | 4h     |
| T3  | **Integration tests for signal.controller** — Test full predict flow with mocked dependencies     | Core Backend             | 4h     |
| T4  | **E2E tests for dashboard** — Playwright tests for symbol search, price display, signal rendering | Frontend                 | 6h     |
| T5  | **Load test for /predict endpoint** — Ensure 50 concurrent requests don't crash the server        | Core Backend + AI Engine | 3h     |

---

## Appendix A: Port Configuration

| Service              | Port | Protocol         | Purpose                     |
| -------------------- | ---- | ---------------- | --------------------------- |
| **Next.js (Client)** | 3000 | HTTP             | Frontend application        |
| **Core Backend**     | 4000 | HTTP + WebSocket | REST API + Socket.IO        |
| **AI Engine**        | 8000 | HTTP             | ML inference endpoint       |
| **Execution Engine** | 8001 | HTTP             | Order execution             |
| **Redis**            | 6379 | TCP              | Caching (optional)          |
| **PostgreSQL**       | 5432 | TCP              | Primary database (optional) |

## Appendix B: Environment Variables

| Variable                    | Service                        | Purpose                    |
| --------------------------- | ------------------------------ | -------------------------- |
| `ALPACA_API_KEY_ID`         | Core Backend, Execution Engine | Alpaca API authentication  |
| `ALPACA_API_SECRET`         | Core Backend, Execution Engine | Alpaca API authentication  |
| `ALPACA_USE_SANDBOX`        | Core Backend                   | Toggle sandbox/live mode   |
| `AI_ENGINE_URL`             | Core Backend                   | AI Engine endpoint URL     |
| `AI_ENGINE_API_KEY`         | Core Backend                   | AI Engine authentication   |
| `REDIS_HOST` / `REDIS_PORT` | Core Backend                   | Redis connection           |
| `DATABASE_URL`              | Core Backend                   | Prisma database connection |
| `JWT_SECRET`                | Core Backend                   | JWT token signing          |
| `CORS_ORIGIN`               | Core Backend                   | Allowed CORS origins       |
| `NEXT_PUBLIC_API_URL`       | Client                         | API base URL for frontend  |
| `NEXT_PUBLIC_AI_ENGINE_URL` | Client                         | AI Engine direct URL       |

## Appendix C: Data Flow Diagram (Price Update)

```
Alpaca Snapshot API
        │
        ▼
Core Backend (signal.controller.predictSignal)
        │
        ├─── fetchHistoricalBars(symbol) → 150 OHLCV bars
        ├─── fetchSnapshot(symbol) → live_price (e.g. 333.48)
        │
        │   POST /api/v1/predict
        │   { symbol, candles, live_price }
        ▼
AI Engine (signals.py → ml_predictor.py)
        │
        ├─── Engineer features (RSI, SMA, ATR, ADX, MACD, volatility)
        ├─── Retrain RandomForest on latest candles
        ├─── Predict probability of upward movement
        ├─── Derive signal (BUY/SELL/HOLD) from probability + RSI
        ├─── Compute target_price from current_price + ATR
        │
        │   JSON response
        │   { signal, confidence, target_price, current_price, indicators }
        ▼
Core Backend
        │
        ├─── Override current_price = live_price (absolute live sync)
        ├─── Add dual casing: { current_price, currentPrice }
        ├─── Add proxied, proxyLatencyMs, dataSource metadata
        │
        │   HTTP 200 JSON
        ▼
Client (Axios → useTradingStore.getPrediction)
        │
        ├─── set({ predictionData, currentPrice, lastPriceUpdate, _priceVersion })
        │
        ├─── Dashboard re-renders (only if currentPrice changed)
        │       ├─── TVChart (TradingView widget)
        │       ├─── OrderBook (reads currentPrice prop)
        │       ├─── Predictive Intelligence (signal badge, confidence, indicators)
        │       └─── Alpha Stream (SignalWidget reads store selectCurrentPrice)
        │
        └─── _priceVersion increment → all stale memoized values invalidated
```
