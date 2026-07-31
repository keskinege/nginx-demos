# NGINX AI Proxy: Completed Implementation Log

This document serves as a record of the architectural changes, bug fixes, and feature additions that have been implemented in the codebase thus far.

## 1. Authentication & Security (API Key Implementation)
* **Removed Mock Auth**: We transitioned away from using the insecure `X-User` HTTP header to mock user identities.
* **`x-api-key` Validation**: Client authentication is now strictly enforced using the standard `x-api-key` header.
* **`api_keys.conf` Mapping**: We introduced a new NGINX configuration file (`config/api_keys.conf`) that uses the NGINX `map` directive. This securely translates specific API keys (e.g., `sk-demo-key-user-a`) directly to the corresponding RBAC identity (`user-a`), seamlessly integrating with our existing `rbac.json` rules.
* **Error Handling**: Missing or invalid API keys now securely trigger an immediate HTTP `401 Unauthorized` with an "Invalid or missing API key" JSON response directly from the NJS proxy.

## 2. NJS Core Logic Fixes (`njs/aiproxy.js`)
* **Asynchronous RBAC Caching**: The proxy previously used `fs.readFileSync()` on every single HTTP request to load the RBAC policy, severely blocking the NGINX event loop. We introduced module-level caching so the `rbac.json` file is only read into memory once.
* **Token Value Coercion**: Fixed a bug where a token count of `0` was coerced into an empty string (`""`) in the NGINX access log variables. Strict `!== undefined` checks are now used.
* **Anthropic Temperature Scaling**: Smoothly unified the temperature scaling for Anthropic models. OpenAI temperature requests are now cleanly divided by `2.0` under all conditions, replacing the jarring threshold logic.

## 3. Semantic Cache Improvements (`njs/cache.js`)
* **Best-Match Semantic Retrieval**: Fixed a logic flaw where the cosine similarity loop would prematurely `break` upon finding the *first* cached embedding that exceeded the similarity threshold. The logic now correctly iterates through the valid cache entries to find and serve the absolute *best* matching score.

## 4. Documentation & Scripts
* **`README.md` Docker Fix**: Fixed the `docker run` commands in the README which were missing the `-e OLLAMA_HOST=host.docker.internal` environment variable, causing `envsubst` to crash the proxy upon startup.
* **Documentation Update**: Replaced all mentions of the `X-User` header in the README with the new `x-api-key` instructions and examples.

## 5. Automated Testing Pipeline
* **`test.sh` Orchestrator**: Authored a robust root-level `test.sh` script to completely manage testing end-to-end. It handles:
  1. Running the NJS unit tests inside the container.
  2. Tearing down any dirty Docker states.
  3. Cleanly booting a new sandboxed Docker environment (`docker compose up -d`) using mock upstream keys to ensure tests don't leak out to live OpenAI/Anthropic accounts.
  4. Running the full `integration_test.sh` suite against the live NGINX container.
  5. Automatically tearing down the environment upon completion.
* **Integration Edge Cases**: Expanded `integration_test.sh` to include aggressive edge cases, validating how the proxy handles missing users, undefined target models, valid but incorrectly structured JSON payloads, and invalid API keys.

## 6. Code Review Fixes (2026-07-31)

A full review (see `review_findings.md`) identified 3 Critical, 8 Important, and 9 Minor issues. All were fixed:

### Critical
* **Cache index allocator (`njs/cache.js`)**: `store()` used the entry `count` as the entry-index allocator while also decrementing it on eviction. Once `max_entries` was reached, new stores overwrote live entries and quickly self-evicted — the cache silently stayed empty forever. Entry indices now come from a monotonic per-model `{model}:seq` counter that is never decremented, and the count is derived from the LRU array length. Regression test added (20 stores against `max_entries=3`).
* **E2E test key injection (`tests/e2e_cache_test.sh`)**: The script gated on `OPENAI_API_KEY` but never injected it (wrote `Bearer fake` key files and disabled envsubst), so it could never pass. It now mounts `templates/` and passes the exported keys into the container so `envsubst` generates real key snippets. The semantically-similar test is gated on Ollama availability (the text fallback scores that paraphrase ~0.63 < 0.85). Also dropped the discarded `-p`/`--network host` combination and armed cleanup immediately after temp-dir creation.
* **README model name**: Updated all examples from the stale `claude-sonnet-4-20250514` to the configured `claude-sonnet-4-6` — the walkthrough previously 404'd.

### Important
* **Default embedding provider**: `rbac.json` now defaults to `ollama`, matching every design doc (previously shipped as `openai`, silently making paid API calls per lookup/store and leaving the compose Ollama service unused).
* **Zone sizing**: Shared dict grew to `32M` and `max_entries` reduced to `500` per model (~20 KB/entry ⇒ ~1500-entry capacity). All dict writes are now best-effort (`SharedMemoryError` is caught and logged) so a full zone can neither break proxying nor turn HITs into MISSes. Sizing math and the no-`evict` rationale are documented in `aiproxy.conf` and `semantic_caching.md`.
* **Lazy TTL pruning**: Expired entries are now actually deleted (and removed from the LRU index) when encountered during `lookup()`; `prune()` was rewritten consistently (previously dead code with the same index-collision flaw).
* **Single embedding per request**: `lookup()` returns `{response, promptText, embedding, embeddingFailed}` and `store()` accepts that result as a precomputed parameter, halving the embedding round-trips on cache misses.
* **Dict-backed unit tests**: New `tests/cache_dict_test.js` (22 assertions) runs the full cache against an in-memory `ngx.shared` mock with a mock embedding subrequest — covering store/lookup, embedding reuse, LRU eviction, TTL lazy deletion, text fallback, semantic-over-text preference, and full-zone resilience. `test_coverage_report.md` corrected (removed the non-existent "403" claim and the false e2e claims).
* **Docs**: README now warns that the cache is shared across users (per-model scope), documents the cache in the request flow/files table, adds the Compose launch path, and drops the stale "No rate limiting or caching" limitation. `live_interaction_tests.md` now accurately describes the e2e script.
* **Ollama healthcheck**: Compose now healthchecks `ollama show nomic-embed-text` (not `ollama list`) so NGINX only starts once the embedding model is actually pulled.
* **Match preference**: Semantic (cosine) matches are tracked separately from text (Jaccard) matches and always preferred — previously a text match could outrank a stronger semantic match when embeddings were partially missing.

### Minor
* OpenAI embedding requests now honor the documented `dimensions` config knob.
* `stream: true` requests bypass the cache entirely.
* `normalize(promptText)` hoisted out of the lookup loop.
* `run_tests.sh` reporting hardened (exit codes captured without `set -e` aborts; unexpected output counts as FAIL).
* `test.sh` probes `/v1/chat/completions`, tolerates the first-boot model pull (up to ~5 min), and documents the internet-egress/resolver requirement.
* Image pinned to `nginx:1.29.1` everywhere (README, compose, test scripts).
* Removed redundant `js_import` lines for `cache.js`/`embeddings.js` (transitive imports resolve relative to `/etc/njs`).
* Plan/spec smoke-test curl examples updated from the retired `X-User` header to `x-api-key`.
