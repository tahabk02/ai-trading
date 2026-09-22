# Trading AI Platform

Industrial-grade, automated trading platform powered by AI.

## Architecture
- **AI Engine**: Python (FastAPI, TA-Lib, XGBoost). Market analysis and signal generation.
- **Core Backend**: Node.js (Express, Prisma, Socket.io). Event orchestration and data persistence.
- **Execution Engine**: Python (CCXT). Automated trade execution and risk management.
- **Client App**: Next.js 14. Real-time monitoring dashboard.
- **Messaging**: Redis Pub/Sub for low-latency inter-service communication.
- **Database**: PostgreSQL for historical signal and user data.

## Getting Started

### Prerequisites
- Docker & Docker Compose
- Node.js 20+ (for local development)
- Python 3.11+ (for local development)

### Quick Start
1. Clone the repository.
2. Configure `.env` files for each service (see `.env.example` in each folder).
3. Run with Docker Compose:
   ```bash
   docker-compose up --build
   ```

## Modules

### Market Data Sources

**OTC pairs + crypto (canonical 44-symbol engine universe):**
- Live spot: `open.er-api.com/v6/latest/{BASE}` (ECB-sourced, no key).
- Daily candles: `api.frankfurter.dev/v1` (ECB reference rates).
- Crypto majors (BTC/USD, ETH/USD): CoinGecko public API.

**The 10 real (non-OTC) forex pairs (EUR/SEK, EUR/NOK, EUR/DKK, EUR/PLN,
EUR/CZK, EUR/HUF, USD/SEK, USD/NOK, USD/PLN, USD/CZK) — PART 28:**
- Live intraday spot + M1/Hr candles: **Yahoo Finance chart API**
  (`query1.finance.yahoo.com/v8/finance/chart/{SYM}=X`), streamed through the
  core-backend tick engine at 1Hz, per-symbol poll throttle ~9s.
- Automatic fallback: if Yahoo fails, the tiered cascade continues to
  Frankfurter (ECB daily) → open.er-api spot → held real-print. Verified by
  `core-backend/src/lib/__tests__/forexData.yahooFallback.test.ts`.

### Operational Risk — Yahoo Finance Chart API (unofficial endpoint)

> **Warning.** The Yahoo Finance intraday forex feed is an **unofficial,
> undocumented endpoint**. It is not covered by a published API ToS for
> third-party use and can, without notice, **rate-limit (HTTP 429), change
> response shape, or be blocked** (network/geo). Treat it as best-effort.

Mitigations already in place:
- Per-symbol poll throttle (9s hold of the last real print) keeps global load
  around ~1.1 req/s — well below the endpoint's comfort zone.
- The tiered fallback to Frankfurter (ECB daily) → open.er-api is automatic and
  unit-tested (`forexData.yahooFallback.test.ts`); the ai-engine collector falls
  back to `open.er-api`/Frankfurter daily the same way.
- Yahoo is only ever a **streaming velocity** source for the 10 real pairs; when
  it degrades, the system still serves real ECB daily closes (won't fabricate).

To add a self-hosted intraday feed later (TwelveData, Polygon, or a keyed Yahoo
query1/quotes endpoint), replace the `fetchYahooSpot`/`fetchYahooCandles`
methods in `core-backend/src/services/forexData.service.ts` and the matching
methods in `ai-engine/app/data/collector.py`; the cascade falls through
automatically.

## Getting Started

### AI Engine (Port 8001)
Generates high-confidence signals using a 3-layer security checkpoint:
1. **Regime Layer**: ADX-based market filtering.
2. **Inference Layer**: Technical analysis and AI probability.
3. **Validation Layer**: Confidence thresholding (>= 80%).

### Core Backend (Port 4000)
Handles data persistence and real-time broadcasting to the frontend via WebSockets.

### Client App (Port 3000)
A high-performance Next.js dashboard for real-time alpha stream monitoring.

### Execution Engine
Universal exchange connectivity via CCXT. Automates BUY/SELL orders based on high-confidence signals (>= 90%).

## Security
- Strict type-safety across all services.
- Industrial logging with Structlog and Winston.
- Containerized environment for isolation.
