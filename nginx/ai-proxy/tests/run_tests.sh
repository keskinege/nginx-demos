#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== NJS Unit Tests ==="
echo ""

tests=(
    "embeddings_test.js"
    "cache_test.js"
    "cache_dict_test.js"
)

passed=0
failed=0

for test in "${tests[@]}"; do
    test_file="$SCRIPT_DIR/$test"
    if [ ! -f "$test_file" ]; then
        echo "SKIP: $test_file (not found)"
        continue
    fi

    echo "--- $test ---"
    # NOTE: do not let a non-zero njs exit code abort the script under `set -e`
    # — capture it, report it, and count it as a failure instead.
    exit_code=0
    output=$(docker run --rm --entrypoint njs \
        -v "$PROJECT_DIR/njs:/etc/njs:ro" \
        -v "$SCRIPT_DIR:/tests:ro" \
        -w /tests \
        nginx:1.29.1 \
        -p /etc/njs \
        "/tests/$test" 2>&1) || exit_code=$?
    echo "$output"
    if [ "$exit_code" -ne 0 ]; then
        echo "FAIL: $test (njs exited with code $exit_code)"
        failed=$((failed + 1))
    elif echo "$output" | grep -q "FAIL:"; then
        echo "FAIL: $test"
        failed=$((failed + 1))
    elif echo "$output" | grep -q "Thrown:"; then
        echo "FAIL: $test"
        failed=$((failed + 1))
    elif ! echo "$output" | grep -q "passed"; then
        echo "FAIL: $test (no test summary in output — unexpected failure)"
        failed=$((failed + 1))
    else
        echo "PASS: $test"
        passed=$((passed + 1))
    fi
    echo ""
done

echo "=== Results: $passed passed, $failed failed ==="
if [ "$failed" -gt 0 ]; then
    exit 1
fi
