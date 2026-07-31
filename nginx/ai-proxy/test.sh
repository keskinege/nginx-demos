#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=============================================="
echo " Starting Full Test Suite for NGINX AI Proxy"
echo "=============================================="

# 1. Run Unit Tests
echo ""
echo "[1/2] Running Unit Tests..."
if ! "$SCRIPT_DIR/tests/run_tests.sh"; then
    echo "Unit tests failed! Aborting."
    exit 1
fi

# 2. Run Integration Tests
echo ""
echo "[2/2] Running Integration Tests..."

# Clean up any existing state
echo "Cleaning up any existing containers..."
docker compose down -v >/dev/null 2>&1

# Bring up the environment with mock/invalid upstream API keys 
# to ensure consistent integration test behavior without relying on real accounts
echo "Starting test environment..."
OPENAI_API_KEY=invalid ANTHROPIC_API_KEY=invalid docker compose up -d

# NOTE: the integration tests require internet egress from the containers
# (api.openai.com / api.anthropic.com) and reachability of the 8.8.8.8
# resolver configured in config/aiproxy.conf. The upstream keys are mock —
# every upstream call is expected to fail with 401.

echo "Waiting for NGINX to answer (first run also pulls the Ollama embedding model — can take a few minutes)..."
ready=false
for i in {1..150}; do
    # Probe the real entrypoint: any HTTP response (even 4xx) means NGINX is up.
    # NGINX only starts once the Ollama healthcheck (model present) passes.
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4242/v1/chat/completions 2>/dev/null || true)
    if [ -n "$code" ] && [ "$code" != "000" ]; then
        ready=true
        break
    fi
    sleep 2
done

if [ "$ready" != true ]; then
    echo "NGINX did not become ready in time. Container logs:"
    docker compose logs
    echo "Cleaning up..."
    docker compose down -v >/dev/null 2>&1
    exit 1
fi

echo "Running integration tests script..."
if ! "$SCRIPT_DIR/tests/integration_test.sh"; then
    echo ""
    echo "Integration tests failed!"
    echo "Logs from NGINX container:"
    docker compose logs nginx
    echo ""
    echo "Cleaning up..."
    docker compose down -v >/dev/null 2>&1
    exit 1
fi

echo ""
echo "Cleaning up test environment..."
docker compose down -v >/dev/null 2>&1

echo "=============================================="
echo " All tests passed successfully!"
echo "=============================================="
