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
