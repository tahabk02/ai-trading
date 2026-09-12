#!/bin/bash
# deploy-frontend.sh
# Rebuild and deploy the Next.js frontend on production server

set -e

echo "=== Building Next.js Frontend Docker Image ==="
cd client-app

echo "Cleaning old build artifacts..."
rm -rf .next
rm -rf node_modules

echo "Building Docker image..."
docker build --no-cache -t trading-app-frontend:latest .

echo ""
echo "=== Deployment Ready ==="
echo ""
echo "To run the container on production server (91.99.71.111):"
echo ""
echo "  docker stop frontend 2>/dev/null || true"
echo "  docker rm frontend 2>/dev/null || true"
echo "  docker run -d --name frontend -p 3000:3000 trading-app-frontend:latest"
echo ""
echo "To verify it's working:"
echo "  curl http://localhost:3000"
echo "  # Visit http://91.99.71.111:3000 in browser"
echo "  # Check Network tab → all requests should go to http://91.99.71.111:4000/api/v1"
echo ""
