# Code Review Findings — NGINX AI Proxy

> **Date:** 2026-07-31
> **Scope:** Full working-tree review of code (`njs/`, `config/`, `templates/`, `docker-compose.yml`), documentation (`*.md`, `docs/`), and tests (`tests/`, `test.sh`) against the stated plans (`docs/IDEA.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/superpowers/specs/2026-07-27-semantic-cache-design.md`) and doc claims (`completed_implementation_log.md`, `test_coverage_report.md`, `live_interaction_tests.md`, `semantic_caching.md`, `README.md`).
> **Method:** Independent senior code review; all Critical findings verified by direct code reading and by executing the project's own similarity functions.

---

## Strengths (verified)

- **Auth wiring is coherent**: `x-api-key` → `map` (`config/api_keys.conf`) → `$aiproxy_user` → 401 (`njs/aiproxy.js:171-179`). The `X-User` → `x-api-key` migration is complete in code and README.
- **Header hygiene / security**: every internal upstream location sets `proxy_pass_request_headers off` (`config/aiproxy.conf`), so the client's `x-api-key` cannot leak to OpenAI/Anthropic/Ollama. All upstream locations are `internal`; keys enter only via envsubst templates; the access-log format does not log the key.
- **Error handling**: cache lookup/store are wrapped in try/catch in `aiproxy.js` — cache-layer failures degrade gracefully instead of producing 500s. No unhandled promise rejections in the `js_content` handler.
- **Implementation-log claims verified**: module-level RBAC caching (no per-request `readFileSync`), token `0`-coercion fix (`!== undefined`), Anthropic temperature `/2.0`, best-match (not first-match) semantic retrieval loop, README `OLLAMA_HOST` envsubst fix — all true.
- **Correct NJS API usage**: `ngx.shared.ai_cache.*`, `r.subrequest(location, {method, body})`, `r.log`/`r.error` (no Node-isms in production code).
- **Good pure-function unit tests** that genuinely run under the real njs CLI.

---

## Issues

### Critical (Must Fix)

#### C1. `store()` index allocator silently kills the cache after `max_entries` stores
- **File:** `njs/cache.js:210-230` (also `pruneExpired` at `cache.js:262`)
- **What:** `nextIdx = readCount(model)` uses `count` as the entry-index allocator, but `count` is decremented back on every eviction (line 228). Once `count` reaches `max_entries`, each new store re-uses the same index, overwriting a live entry; within a few more stores the just-written entry evicts itself.
- **Trace (`max_entries=3`):** store#5 overwrites live `entry:3` → `entries=[3,2]`; store#6 → `[3]`; store#7 evicts the entry it just wrote → `[]`; store#8+ every store is immediately self-evicted — **the cache stays empty forever**. With the shipped default of 1000 this triggers on the 1001st stored prompt per model.
- **Why it matters:** The headline feature silently stops working at scale; no error is ever logged.
- **Fix:** Allocate indices from a separate monotonic `{model}:seq` counter that is never decremented; derive count from the `{model}:entries` array length. Fix `pruneExpired` the same way. Add a regression test storing `max_entries + n` entries.

#### C2. `tests/e2e_cache_test.sh` can never pass as wired; two docs falsely claim it works with live keys
- **File:** `tests/e2e_cache_test.sh:44-59,95`; `live_interaction_tests.md:19`; `test_coverage_report.md:19`
- **What:** The script gates on `OPENAI_API_KEY` being set (line 95) but never injects it: it writes `Bearer fake` key files (lines 44-47), disables envsubst (`NGINX_ENVSUBST_TEMPLATE_DIR=/nonexistent`, line 56) and passes no `-e OPENAI_API_KEY`. With a real key exported: Test 1 fails (upstream 401, no `"choices"`), Test 5's `STORED ≥ 1` fails (only 200s are cached), Test 4 fails spuriously (all responses are the identical 401 body). In text-fallback mode, Test 3's prompt pair scores **0.6316 < 0.85** (verified by running the project's own `normalize`/`ngrams`/`jaccardSimilarity`), so it can never HIT either.
- **Why it matters:** The flagship live test is theater; the docs instruct users to run something that cannot succeed.
- **Fix:** Pass `-e OPENAI_API_KEY -e ANTHROPIC_API_KEY` and mount the real `templates/` dir so envsubst generates genuine key files; delete the fake-key writing. Gate Test 3 on actual embedding (Ollama) availability.

#### C3. README walkthrough 404s: stale model name
- **File:** `README.md:132,166,204-236,260,297,307`
- **What:** `config/rbac.json` renamed the Anthropic model to `claude-sonnet-4-6`, but the README still uses `claude-sonnet-4-20250514` in curl examples, the failover narrative/expected outputs, and the RBAC JSON example.
- **Why it matters:** Following the README returns `404 … not found or is not accessible` — the documented demo behavior is false.
- **Fix:** Update README to `claude-sonnet-4-6` everywhere.

### Important (Should Fix)

#### I1. Default embedding provider contradicts every design doc
- **File:** `config/rbac.json:9`
- **What:** Ships `"provider": "openai"`; `docs/IDEA.md:19`, `docs/IMPLEMENTATION_PLAN.md:56`, the spec, and `semantic_caching.md:12,43` all say Ollama is the default. Every cache lookup/store makes a paid OpenAI embeddings call, and the compose Ollama service is unused by default.
- **Fix:** Flip default to `ollama` (matches all docs).

#### I2. Shared-dict zone undersized; no full-zone strategy
- **File:** `config/aiproxy.conf:7` vs `config/rbac.json:7`
- **What:** 10M zone, no `evict`/`timeout`. Each entry stores a 768-float embedding (~12-16 KB JSON) + the full response body → the zone exhausts around a few hundred entries, well below `max_entries: 1000` **per model**. njs `set()` then throws `SharedMemoryError`; the hit-bookkeeping write (`cache.js:184`) throwing turns a would-be HIT into a MISS. Enabling `evict` is not a clean fix (njs can evict the index keys and corrupt bookkeeping).
- **Fix:** Right-size zone (32M) and `max_entries` (500), make all dict writes best-effort, document the sizing math and strategy.

#### I3. Expired entries are never removed; `prune()` is dead code
- **File:** `njs/cache.js:159` (skip without delete), `cache.js:245-264` (exported, never called, and reintroduces the C1 index collision via `writeCount(model, valid.length)`)
- **What:** The spec ("Lazily prune expired on access") and `semantic_caching.md:29` claim lazy pruning; in reality expired entries (embedding + response body each) occupy the zone until LRU eviction — which is itself broken per C1.
- **Fix:** Delete expired entries when encountered during `lookup()`; rewrite `prune` against the seq-based scheme.

#### I4. Every cache MISS pays up to two synchronous embedding round-trips on the critical path
- **File:** `njs/aiproxy.js:243` (lookup awaits embedding subrequest before routing) and `aiproxy.js:306` (store awaits another before `r.return`)
- **What:** With the `openai` provider that's two extra internet API calls added to every miss's latency.
- **Fix:** Compute the embedding once per request — `lookup()` returns its computed embedding, `store()` accepts it as a precomputed parameter.

#### I5. Test coverage materially overstated
- **File:** `test_coverage_report.md:18-19`
- **What:** (a) No automated test exercises `lookup`/`store`/LRU/TTL against a shared dict — exactly why C1 shipped. (b) The claimed "403 on invalid user" test does not exist, and the 403 branch (`aiproxy.js:182-189`) is unreachable with the shipped map+rbac. (c) The e2e claims are false per C2.
- **Fix:** Add dict-backed unit tests (inject a `globalThis.ngx` mock in the njs CLI); correct the report.

#### I6. Cache is shared across users for the same model
- **File:** `njs/cache.js` (per-model key patterns only)
- **What:** `user-b` receives `user-a`'s cached answers to similar prompts on `gpt-5`. Accepted non-goal in spec §10, but for a proxy with per-user auth this data-leak vector deserves a prominent README warning.

#### I7. Ollama startup race in `docker-compose.yml`
- **File:** `docker-compose.yml:16-20`
- **What:** Healthcheck (`ollama list`) passes as soon as the daemon is up, but the entrypoint pulls `nomic-embed-text` after that; nginx starts on `service_healthy` and can serve traffic during the ~274 MB pull, silently degrading all matching to text fallback on first boot.
- **Fix:** Healthcheck on model presence: `ollama show nomic-embed-text`; raise retries.

#### I8. Lookup cost scales with total cache size; mixed-score comparison
- **File:** `njs/cache.js:155-179`
- **What:** Every request reads and `JSON.parse`s every entry (embedding + full response body); at 1000 entries that's tens of MB per request. Also, when embeddings are partially missing, cosine scores (threshold 0.95) and Jaccard scores (threshold 0.85) compete in one `bestScore` comparison, so a text match can outrank a stronger semantic match.
- **Fix:** Track semantic and text best-matches separately and prefer semantic; document the scan ceiling.

### Minor (Nice to Have)

| # | File:line | Issue |
|---|-----------|-------|
| M1 | `njs/embeddings.js:44-48` | `dimensions` config knob documented (`semantic_caching.md:48,53`) but never sent in the OpenAI request body |
| M2 | `njs/aiproxy.js:239-259,303-310` | `stream: true` SSE bodies get cached and can be served to non-streaming clients (and vice versa) — skip lookup/store for streaming |
| M3 | `njs/cache.js:170-171` | `normalize(promptText)` recomputed inside the per-entry loop; hoist it |
| M4 | `tests/run_tests.sh:26-43` | Under `set -e`, a genuinely failing test aborts before FAIL reporting; unexpected output counts as PASS |
| M5 | `tests/e2e_cache_test.sh:51-52,63-67` | `-p 4242:4242` with `--network host` is discarded; host networking needs a Docker Desktop toggle on macOS; `.tmp-keys` left behind if start fails before trap is armed |
| M6 | `test.sh:36` | Readiness probe curls `/` (no location — "works" only via curl-exit-22); probe `/v1/chat/completions`. Integration tests also hard-require internet egress and `8.8.8.8` reachability — worth a note |
| M7 | `README.md` vs `docker-compose.yml:23`, `tests/*` | Image drift: README pins `nginx:1.29.1`, scripts use `nginx:latest`. Pin consistently (njs ≥0.8 required for `js_shared_dict_zone`) |
| M8 | `config/aiproxy.conf:3-4` | Redundant `js_import` lines for `cache.js`/`embeddings.js` — transitive imports from `aiproxy.js` resolve relative to `/etc/njs`; spec §8's claim is inaccurate |
| M9 | `docs/IMPLEMENTATION_PLAN.md:233-255`, spec lines 272-279 | Smoke-test curl examples still use the retired `X-User` header |

---

## Recommendations

1. Fix C1 first (seq allocator), with a regression test storing `max_entries + n` entries.
2. Repair the e2e script to actually inject keys; align Test 3 with embedding availability.
3. One embedding-provider story: default `ollama` (matches every doc).
4. Reconcile zone size vs `max_entries`; make dict writes best-effort; wire lazy expiry deletion into `lookup()`.
5. Update README: model name, stale "No rate limiting or caching" limitation, document the semantic cache + compose path + new files, cross-user cache warning.
6. Add dict-backed cache tests (mock `globalThis.ngx`); correct `test_coverage_report.md`.
7. Skip caching for `stream: true`; hoist `normalize()` out of the lookup loop.

## Assessment

**Ready to merge? No — with fixes.**

**Reasoning:** The NJS craftsmanship (auth wiring, header hygiene, transforms, error handling) is solid and most implementation-log claims check out, but the headline feature has a Critical logic bug that silently kills the cache after ~`max_entries` stores, the e2e test is wired so it can never pass while two docs claim it does, and the README walkthrough 404s against the shipped config. All fixable in a small follow-up pass; none require redesign.

---

## Resolution Status

All findings were fixed on 2026-07-31 and verified: **57/57 unit tests pass** (including a new dict-backed suite with an `ngx.shared` mock), **`nginx -t` passes**, and **12/12 integration tests pass** against a live Docker Compose stack (NGINX + Ollama, mock upstream keys).

| ID | Issue | Status | Fix |
|----|-------|--------|-----|
| C1 | `store()` index allocator | ✅ Fixed | Monotonic `{model}:seq` allocator; count derived from LRU array; regression test stores 20 entries against `max_entries=3` (`tests/cache_dict_test.js` T3) |
| C2 | e2e test key injection | ✅ Fixed | Script mounts `templates/` and injects exported keys via envsubst; Test 3 gated on Ollama availability; bridge networking; cleanup trapped early |
| C3 | README stale model name | ✅ Fixed | All examples updated to `claude-sonnet-4-6` |
| I1 | Default embedding provider | ✅ Fixed | `rbac.json` → `"provider": "ollama"` |
| I2 | Zone sizing / full-zone strategy | ✅ Fixed | Zone 32M + `max_entries` 500 (~20KB/entry math documented); all dict writes best-effort (T7 verifies HITs survive `SharedMemoryError`); no-`evict` rationale documented |
| I3 | Lazy expiry / dead `prune()` | ✅ Fixed | `lookup()` lazily deletes expired entries (T4); `prune()` rewritten on the seq scheme (T8) |
| I4 | Double embedding round-trip | ✅ Fixed | `lookup()` returns `{response, promptText, embedding, embeddingFailed}`; `store()` reuses it (T2 verifies one subrequest) |
| I5 | Overstated test coverage | ✅ Fixed | New `tests/cache_dict_test.js` (22 assertions); `test_coverage_report.md` corrected (false 403/e2e claims removed) |
| I6 | Cross-user cache warning | ✅ Fixed | Prominent warnings in `README.md` limitations and `semantic_caching.md` Caveats |
| I7 | Ollama healthcheck race | ✅ Fixed | Healthcheck is now `ollama show nomic-embed-text` with 30 retries; `test.sh` waits up to ~5 min for first-boot pull |
| I8 | Scan scaling / mixed scores | ✅ Fixed | Semantic and text best-matches tracked separately, semantic always preferred (T6); scan ceiling documented in `semantic_caching.md` |
| M1 | `dimensions` unused | ✅ Fixed | Sent in OpenAI embedding request body when configured |
| M2 | Streaming cached | ✅ Fixed | `stream: true` bypasses lookup/store entirely |
| M3 | `normalize()` in loop | ✅ Fixed | Hoisted out of the per-entry loop |
| M4 | `run_tests.sh` reporting | ✅ Fixed | Exit codes captured (`|| exit_code=$?`); unexpected output counts as FAIL |
| M5 | e2e host/port/cleanup | ✅ Fixed | Dropped `--network host` + discarded `-p`; bridge + `host.docker.internal` (overridable via `OLLAMA_HOST`) |
| M6 | `test.sh` probe | ✅ Fixed | Probes `/v1/chat/completions`; egress/resolver requirement documented |
| M7 | Image drift | ✅ Fixed | `nginx:1.29.1` pinned in compose + test scripts |
| M8 | Redundant `js_import`s | ✅ Fixed | Removed; verified by `nginx -t` (transitive imports resolve from `/etc/njs`) |
| M9 | Stale `X-User` examples | ✅ Fixed | Plan/spec curl examples use `x-api-key`; erratum added to `IMPLEMENTATION_PLAN.md` for the flawed §3.4 store algorithm |
| — | *Found during verification* | ✅ Fixed | `resolver 8.8.8.8` failed in Docker networks here ("unexpected DNS response"); now `127.0.0.11 8.8.8.8 valid=60s ipv6=off` (embedded DNS with 8.8.8.8 fallback) — 12/12 integration tests pass |

**Not run:** `tests/e2e_cache_test.sh` (requires a real `OPENAI_API_KEY`; now wired to actually inject it — see `live_interaction_tests.md`). The live Ollama embedding path was exercised by the integration run (real embedding subrequests, no fallback triggers in logs).
