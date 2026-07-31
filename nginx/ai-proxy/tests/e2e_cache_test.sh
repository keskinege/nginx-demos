#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-localhost:4242}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
KEYS_DIR="$PROJECT_DIR/.tmp-keys"
CONTAINER_NAME="nginx-ai-proxy-e2e"
NGINX_IMAGE="nginx:1.29.1"
# Where the container should reach the Ollama API (host-side check uses localhost)
OLLAMA_HOST="${OLLAMA_HOST:-host.docker.internal}"
PASSED=0
FAILED=0

function assert_eq() {
    local msg="$1"; local expected="$2"; local actual="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $msg"
        PASSED=$((PASSED + 1))
    else
        echo "  FAIL: $msg — expected '$expected', got '$actual'"
        FAILED=$((FAILED + 1))
    fi
}

function assert_contains() {
    local msg="$1"; local needle="$2"; local haystack="$3"
    if echo "$haystack" | grep -q "$needle"; then
        echo "  PASS: $msg"
        PASSED=$((PASSED + 1))
    else
        echo "  FAIL: $msg — expected to contain '$needle'"
        FAILED=$((FAILED + 1))
    fi
}

function api_call() {
    local model="$1"; local api_key="$2"; local content="$3"
    curl -s -X POST "$HOST/v1/chat/completions" \
        -H 'Content-Type: application/json' \
        -H "x-api-key: $api_key" \
        -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"$content\"}]}"
}

function cleanup() {
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    rm -rf "$KEYS_DIR"
    echo "Container stopped"
}

function start_container() {
    echo ""
    echo "=== Starting NGINX AI Proxy ==="

    # Real keys are injected via envsubst templates at container startup —
    # the generated key snippets land in $KEYS_DIR (mounted as the keys dir)
    mkdir -p "$KEYS_DIR"
    trap cleanup EXIT

    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

    docker run -d --rm -p 4242:4242 \
        -v "$PROJECT_DIR/config:/etc/nginx:ro" \
        -v "$PROJECT_DIR/njs:/etc/njs:ro" \
        -v "$PROJECT_DIR/templates:/etc/nginx-ai-proxy/templates:ro" \
        -v "$KEYS_DIR:/etc/nginx-ai-proxy/keys" \
        -e NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx-ai-proxy/templates \
        -e NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx-ai-proxy/keys \
        -e OLLAMA_HOST="$OLLAMA_HOST" \
        -e OPENAI_API_KEY \
        -e ANTHROPIC_API_KEY \
        --name "$CONTAINER_NAME" \
        "$NGINX_IMAGE" > /dev/null

    echo "Waiting for NGINX to answer on $HOST..."
    for i in {1..15}; do
        # Any HTTP response (even 4xx) means NGINX is up
        if [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$HOST/v1/chat/completions" 2>/dev/null || true)" != "000" ]; then
            break
        fi
        sleep 2
    done

    if ! docker ps --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
        echo "FATAL: Container failed to start"
        docker logs "$CONTAINER_NAME" 2>&1 | tail -20
        exit 1
    fi
    echo "Container started"
}

function check_ollama() {
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "Ollama detected on localhost:11434"
        return 0
    fi
    echo "Ollama NOT detected — embedding-based semantic matching unavailable"
    return 1
}

# ──────────────────────────────────────────────────

echo "=============================================="
echo " E2E Test: NGINX AI Proxy Semantic Cache"
echo "=============================================="

HAS_OLLAMA=false
check_ollama && HAS_OLLAMA=true

if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY not set — skipping cache tests (needs real API key)"
    echo "Set it with: export OPENAI_API_KEY=sk-..."
    exit 0
fi
# Anthropic key is optional: the tests below only exercise the OpenAI model
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

start_container

TEST_MODEL="gpt-5"

# ── Test 1: Cache MISS (first request) ──
echo ""
echo "── Test 1: First request → cache MISS → upstream"

RESPONSE1=$(api_call "$TEST_MODEL" "sk-demo-key-user-a" "What is the capital of France?")
echo "  Response: $(echo "$RESPONSE1" | head -c 200)..."

assert_contains "upstream responded" '"choices"' "$RESPONSE1"

sleep 2  # ensure async store completes

# ── Test 2: Cache HIT (same prompt) ──
echo ""
echo "── Test 2: Identical prompt → cache HIT"
echo "   (works with embeddings OR text fallback: identical prompts score 1.0)"

RESPONSE2=$(api_call "$TEST_MODEL" "sk-demo-key-user-a" "What is the capital of France?")
echo "  Response: $(echo "$RESPONSE2" | head -c 200)..."

assert_eq "identical response body (served from cache)" "$RESPONSE1" "$RESPONSE2"

# ── Test 3: Cache HIT (semantically similar) ──
echo ""
echo "── Test 3: Semantically similar prompt → cache HIT"

if [ "$HAS_OLLAMA" = true ]; then
    RESPONSE3=$(api_call "$TEST_MODEL" "sk-demo-key-user-a" "Tell me what the capital of France is")
    echo "  Response: $(echo "$RESPONSE3" | head -c 200)..."

    assert_eq "semantically similar → cached response" "$RESPONSE1" "$RESPONSE3"
else
    echo "  SKIP: requires Ollama embeddings — the text fallback scores this pair"
    echo "        ~0.63, below the 0.85 text_similarity_threshold"
fi

# ── Test 4: Cache MISS (different topic) ──
echo ""
echo "── Test 4: Different topic → cache MISS"

RESPONSE4=$(api_call "$TEST_MODEL" "sk-demo-key-user-a" "Write a short poem about dogs")
echo "  Response: $(echo "$RESPONSE4" | head -c 200)..."

if [ "$RESPONSE4" = "$RESPONSE1" ]; then
    echo "  FAIL: different topic should not return cached response"
    FAILED=$((FAILED + 1))
else
    echo "  PASS: different topic → fresh response (cache miss)"
    PASSED=$((PASSED + 1))
fi

# ── Test 5: Cache log verification ──
echo ""
echo "── Test 5: Cache log verification"

LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
echo "  Cache-related log entries:"
echo "$LOGS" | grep -i "cache" | while read -r line; do echo "    $line"; done

HIT_COUNT=$(echo "$LOGS" | grep -c "cache: HIT" 2>/dev/null || echo 0)
MISS_COUNT=$(echo "$LOGS" | grep -c "cache: MISS" 2>/dev/null || echo 0)
STORE_COUNT=$(echo "$LOGS" | grep -c "cache: STORED" 2>/dev/null || echo 0)

HIT_COUNT=$(echo "$HIT_COUNT" | tr -d '[:space:]')
MISS_COUNT=$(echo "$MISS_COUNT" | tr -d '[:space:]')
STORE_COUNT=$(echo "$STORE_COUNT" | tr -d '[:space:]')

echo "  HIT=$HIT_COUNT MISS=$MISS_COUNT STORED=$STORE_COUNT"
echo ""
assert_eq "at least 1 cache HIT logged" "true" "$([ "$HIT_COUNT" -ge 1 ] 2>/dev/null && echo true || echo false)"
assert_eq "at least 1 cache MISS logged" "true" "$([ "$MISS_COUNT" -ge 1 ] 2>/dev/null && echo true || echo false)"
assert_eq "at least 1 cache STORE logged" "true" "$([ "$STORE_COUNT" -ge 1 ] 2>/dev/null && echo true || echo false)"

# ── Summary ──
echo ""
echo "=============================================="
echo " E2E Results: $PASSED passed, $FAILED failed"
echo "=============================================="

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
