FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Headless (SSID auto-refresh) needs the Chromium browser inside the image.
RUN python -m playwright install --with-deps chromium

# Copy only application sources — NEVER `COPY . .`, which bakes the secret
# .env into the image. The live SSID is injected at runtime by compose
# env_file ./pocket-bridge/.env; the browser session + refresh script arrive
# via the read-only ./pocket-bridge/session volume. Without a mounted .env the
# bridge boots in the clean awaiting_ssid state (config defaults).
COPY pocket_bridge ./pocket_bridge
COPY tests ./tests
COPY .env.example ./.env.example

CMD ["python", "-m", "pocket_bridge.main"]
