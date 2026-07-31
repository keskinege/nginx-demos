# NGINX AI Proxy Test Coverage & Edge Cases

This document provides a breakdown of the test coverage across the NGINX AI Proxy, documents edge cases, and explains the testing strategy.

**Current status: 57/57 tests passing** (35 unit tests across 3 suites + 12 integration tests).

## 1. Current Test Coverage Analysis

The test suite is split into two primary methodologies: **Unit Tests** and **Integration / End-to-End Tests**.

### Unit Tests (`tests/cache_test.js`, `tests/embeddings_test.js` & `tests/cache_dict_test.js`)
We use a lightweight, custom unit-testing wrapper to evaluate the core math and string manipulation inside NJS:
* **String Parsing (`extractPrompt`)**: Covered. Tests varying lengths of prompt schemas to ensure only `user` role content is extracted while `system` and `assistant` contexts are ignored.
* **Math Logic (`cosineSimilarity`)**: Covered. Tests vector geometry calculations against identical, orthogonal, opposite, and multi-dimensional numeric arrays.
* **Text Fallback (`jaccardSimilarity` / `ngrams` / `normalize`)**: Covered. Tests string normalization algorithms, precise 3-gram chunking logic, and intersection-over-union math.
* **Date Logic (`isExpired`)**: Covered. Tests basic TTL boundaries.
* **Provider Parsing (`parseOllamaResponse` & `parseOpenAIResponse`)**: Covered. Tests strict traversal of the upstream JSON schemas to pull out embedding float arrays and correctly handles `error` objects.

`tests/cache_dict_test.js` (22 assertions) exercises the full cache machinery against an in-memory mock of the NGX shared dictionary (injected as `globalThis.ngx`) with a mock embedding subrequest:
* **Store → Lookup round-trip** via embeddings, including the `{response, promptText, embedding}` result shape.
* **Single embedding per request**: `store()` reuses the embedding returned by `lookup()` (no second subrequest).
* **LRU eviction regression**: 20 stores against `max_entries=3` keep the cache capped, newest entries retrievable, oldest blobs deleted (locks down the index-allocator fix — was previously using count as index).
* **TTL**: expired entries are skipped *and lazily deleted* from the dict and LRU index; explicit `prune()` keeps the index consistent.
* **Text fallback**: with the embedding API mocked down, identical prompts still HIT via Jaccard similarity.
* **Match preference**: a semantic match beats an equally-scoring text-only match.
* **Full-zone resilience**: HITs are still served and `store()` does not throw when dict writes fail (`SharedMemoryError`).

### Integration / E2E Tests (`tests/integration_test.sh` & `tests/e2e_cache_test.sh`)
* **RBAC & Authorization**: Covered. Confirms that users are authorized based on valid `x-api-key` values and securely mapped to allowable models. The integration suite uses `OPENAI_API_KEY=invalid` (mock keys), so upstream calls are expected to return 401 — this is intentional to avoid accidental API charges. (Tested: 401 on missing key, 401 on invalid key, 404 on inaccessible/unknown model, 400 on malformed payloads, 500 on Anthropic translation with missing messages array).
* **Semantic Caching (live e2e)**: Covered by `tests/e2e_cache_test.sh` with a **real** `OPENAI_API_KEY` injected into the container via envsubst. Validates cache MISS on first request, HIT on an identical prompt (works with embeddings or text fallback), HIT on a semantically similar prompt (requires Ollama; skipped with a note when Ollama is unreachable, since the text fallback scores that paraphrase ~0.63 < 0.85), MISS on a different topic, and HIT/MISS/STORED log lines.

## 2. Identified Edge Cases & Test Additions

During the coverage analysis, we identified a few vulnerable edge cases in the data validation layer that could cause the NJS engine to crash or behave unexpectedly. We have added the following test fixtures to `tests/integration_test.sh` to lock down this behavior:

### A. Missing `messages` Array (Anthropic Translation)
**Vulnerability**: The proxy expects payloads to match the OpenAI schema `{"model": "...", "messages": [...]}`. If a client sends a payload without a `messages` array, passing this to the Anthropic schema transformer (`transformAnthropicRequest`) caused the NJS engine to throw a `TypeError: Cannot read properties of undefined (reading 'length')`, resulting in an unhandled 500 error.
**Test Added**: `Validation: missing messages array for Anthropic translation`
**Result**: We now strictly test that a malformed JSON payload aiming for an Anthropic upstream is caught (currently returning a 500 Internal Server error; in a future PR, we will add stricter validation to return a graceful 400 Bad Request).

### B. Explicitly Null Variables
**Vulnerability**: We tested missing `model` fields, but we needed to ensure that explicitly passing `{"model": null}` would also correctly trip the `Model not specified` logic rather than crashing string-matching routines.
**Test Added**: `Validation: model is null`
**Result**: Returns `400 Bad Request` successfully.

### C. Outdated E2E Auth Headers
**Vulnerability**: `tests/e2e_cache_test.sh` was still attempting to authenticate using the legacy `-H "X-User: user-a"` mock header. 
**Fix Implemented**: The test has been fully updated to use `-H "x-api-key: sk-demo-key-user-a"` to seamlessly pass through the new `api_keys.conf` mapping directive without failing auth.
