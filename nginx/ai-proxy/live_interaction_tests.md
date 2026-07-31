# Running Real Interaction Tests

To test the NGINX AI Proxy against actual upstream AI providers (like OpenAI and Anthropic) rather than asserting against local proxy failures, you must inject your real API keys into the testing environment.

Because the Docker configuration uses `envsubst` upon startup, you do not need to hardcode your secret keys into any configuration files. Instead, you supply them via environment variables.

## 1. Setting Up the Keys
Before launching any containers or scripts, export your live API keys directly in your terminal session:

```bash
export OPENAI_API_KEY="sk-your-real-openai-key-here"
export ANTHROPIC_API_KEY="sk-your-real-anthropic-key-here"
```

## 2. Running the Cache E2E Test (Recommended)
We have a dedicated script designed specifically for live interaction testing: `tests/e2e_cache_test.sh`.

This script:
1. Provisions a temporary NGINX container, passing your exported keys (`OPENAI_API_KEY`, and optionally `ANTHROPIC_API_KEY`) into the container environment, where `envsubst` generates real key snippets from `templates/`.
2. Sends a real request to OpenAI (e.g., "What is the capital of France?").
3. Verifies that the upstream API successfully answered.
4. Sends the exact same prompt again to test the semantic cache (works via embeddings, or via the text fallback if Ollama is down).
5. Sends a semantically similar prompt to ensure vector caching works properly. **This step requires a reachable Ollama** (on `localhost:11434`, override the container-side address with `OLLAMA_HOST=...`) because the text fallback scores such paraphrases (~0.63) below the `text_similarity_threshold` (0.85). If Ollama is not detected, the step is skipped with a note.
6. Sends a different-topic prompt to verify cache MISS behavior.
7. Verifies HIT/MISS/STORED log lines, then cleans up and destroys the temporary container.

**To run it, simply execute:**
```bash
export OPENAI_API_KEY="sk-your-real-openai-key-here"
./tests/e2e_cache_test.sh
```

If `OPENAI_API_KEY` is not set, the script exits early without running anything.

## 3. Running Live Integration Tests (Optional)
Our primary orchestrator (`test.sh`) intentionally hardcodes `invalid` upstream keys to prevent accidental API charges during routine validation.

If you wish to run the full `integration_test.sh` suite against the live APIs, you must bypass `test.sh` and run the suite manually using your exported keys:

```bash
# 1. Clean up any existing Docker states
docker compose down -v

# 2. Start the proxy. Because we use `docker compose`, it will automatically 
# inherit the OPENAI_API_KEY and ANTHROPIC_API_KEY from your host terminal!
docker compose up -d

# 3. Wait for services to become healthy, then run the tests
./tests/integration_test.sh
```

**Note on Integration Tests**: The `integration_test.sh` script is explicitly designed to test RBAC rules. Therefore, tests like "user-a can access gpt-5" are *expected* to return a `401 Unauthorized` (verifying that the proxy correctly routed the request upstream, where it failed due to bad mock credentials). If you run this suite with *real* keys, those tests will actually return a `200 OK` from OpenAI, causing the test suite to report a "FAIL" because it received a success code instead of an auth error! 

For true functional testing, always prefer `tests/e2e_cache_test.sh`.
