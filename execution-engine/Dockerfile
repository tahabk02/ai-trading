FROM python:3.11-slim

WORKDIR /app

# Install dependencies first so source edits do not invalidate the layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run unprivileged. The engine holds exchange trading credentials; a compromised
# process should not be able to modify its own image contents.
RUN groupadd --system --gid 1002 exec \
 && useradd  --system --uid 1002 --gid exec executor \
 && chown -R executor:exec /app
USER executor

EXPOSE 8081

# /health returns 503 until the Redis subscription is live, so compose orders
# the stack correctly instead of starting dependents against a dead consumer.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/health', timeout=4).status==200 else 1)"

CMD ["python", "-m", "app.main"]
