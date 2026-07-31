#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-localhost:4242}"
PASSED=0
FAILED=0

function test() {
    local name="$1"; shift
    local expected_code="$1"; shift
    local expected_body="$1"; shift
    local curl_args=("$@")

    local response
    response=$(curl -s -w "\n%{http_code}" "${curl_args[@]}" 2>&1)
    local http_code
    http_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "$expected_code" ]; then
        if [ -n "$expected_body" ] && ! echo "$body" | grep -q "$expected_body"; then
            echo "FAIL: $name — body missing '$expected_body': $body"
            FAILED=$((FAILED + 1))
        else
            echo "PASS: $name (HTTP $http_code)"
            PASSED=$((PASSED + 1))
        fi
    else
        echo "FAIL: $name — expected HTTP $expected_code, got $http_code: $body"
        FAILED=$((FAILED + 1))
    fi
}

echo "=== NGINX AI Proxy — Integration Tests ==="
echo ""

# ── Auth & RBAC ──

test "RBAC: user-a can access gpt-5" 401 "invalid_api_key\|authentication_error\|Incorrect API key" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'

test "RBAC: user-b denied claude" 404 "not found or is not accessible" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-b' \
    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'

test "RBAC: user-b can access gpt-5" 401 "invalid_api_key\|authentication_error\|Incorrect API key" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-b' \
    -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'

test "RBAC: invalid API key denied access" 401 "Invalid or missing API key" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: invalid-key' \
    -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'

test "RBAC: requested model not in config" 404 "was not found or is not accessible" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '{"model":"non-existent-model","messages":[{"role":"user","content":"Hello"}]}'


# ── Input validation ──

test "Validation: missing API key header" 401 "Invalid or missing API key" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'

test "Validation: missing model in body" 400 "Model not specified" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '{"messages":[{"role":"user","content":"Hello"}]}'

test "Validation: invalid JSON body" 400 "Invalid JSON" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d 'not-json'

test "Validation: valid JSON array but not object" 400 "Model not specified" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '["array", "only"]'

test "Validation: model is null" 400 "Model not specified" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '{"model":null,"messages":[{"role":"user","content":"Hello"}]}'

test "Validation: missing messages array for Anthropic translation" 500 "Internal server error" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '{"model":"claude-sonnet-4-6","content":"Hello"}'


# ── Model routing ──

test "Routing: user-a → claude (Anthropic)" 401 "invalid_api_key\|authentication_error\|invalid x-api-key" \
    -X POST "$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H 'x-api-key: sk-demo-key-user-a' \
    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'

# ── Cache (non-blocking) ──

echo ""
echo "Note: Full cache E2E tests: ./tests/e2e_cache_test.sh (requires OPENAI_API_KEY)"

# ── Summary ──

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
