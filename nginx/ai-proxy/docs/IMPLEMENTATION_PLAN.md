# Implementation Plan: Semantic Cache for NGINX AI Proxy

> **⚠️ Erratum (2026-07-31):** The store algorithm in §3.4 (`N = {model}:count`, decrementing `count` on eviction) is flawed — reusing `count` as an index allocator collides with live entries once eviction begins and permanently empties the cache (see `review_findings.md` C1). The shipped implementation allocates entry indices from a monotonic `{model}:seq` counter instead, and `lookup()` returns a result object (carrying the computed embedding for reuse by `store()`) rather than `string | null`. Lookup also implements *best*-match (not first-match) retrieval with semantic matches preferred over text matches.

## Scope

Add two-tier semantic caching (embedding similarity + normalized text fallback) to the existing AI proxy demo using an L1 NGINX shared dictionary with LRU + TTL eviction. L2 (Redis) is deferred.

---

## Phase 1: Configuration (`config/`)

### 1.1 — `config/aiproxy.conf`

**Add shared dictionary zone:**
```nginx
js_shared_dict_zone zone=ai_cache:10M;
```

**Add Ollama upstream:**
```nginx
upstream ollama {
    zone ollama 64k;
    server localhost:11434;
}
```

**Add internal location for Ollama embeddings:**
```nginx
location /ollama-embedding {
    internal;
    rewrite ^ /api/embeddings break;
    proxy_pass_request_headers off;
    proxy_set_header Content-Type "application/json";
    proxy_method POST;
    proxy_pass http://ollama;
}
```

**Add NJS imports** for the two new modules:
```nginx
js_import /etc/njs/cache.js;
js_import /etc/njs/embeddings.js;
```

### 1.2 — `config/rbac.json`

Add a `semantic_cache` block at the top level:

```json
"semantic_cache": {
    "enabled": true,
    "similarity_threshold": 0.95,
    "text_similarity_threshold": 0.85,
    "ttl_seconds": 3600,
    "max_entries": 1000,
    "embedding": {
        "provider": "ollama",
        "model": "nomic-embed-text",
        "location": "/ollama-embedding"
    }
}
```

### 1.3 — No template changes needed

Ollama runs locally with no auth, so no `envsubst` templates or environment variables are required for the embedding layer.

---

## Phase 2: Embedding Module (`njs/embeddings.js`)

### 2.1 — API: `compute(r, promptText, config) → Promise<number[]>`

- Sends a subrequest via `r.subrequest()` to `/ollama-embedding`
- Request body: `{"model": config.embedding.model, "prompt": promptText}`
- Parses response JSON, extracts `embedding` float array
- Returns the float array
- On any error (Ollama down, bad response, timeout), throws a recognized error so the caller can trigger the text fallback

### 2.2 — Subrequest details

The subrequest uses the NJS `r.subrequest()` API. The `/ollama-embedding` location handles the URL rewrite (`/api/embeddings`) and proxy to `http://ollama`. No API key or SSL.

---

## Phase 3: Cache Module (`njs/cache.js`)

### 3.1 — LRU data structure in shared dict

Keys in the shared dictionary:
| Key pattern | Content |
|---|---|
| `{model}:count` | Integer — number of cached entries for this model |
| `{model}:entries` | JSON array of entry indices in LRU order (head first) |
| `{model}:entry:{N}` | JSON blob — the cache entry (see schema below) |

Cache entry JSON:
```json
{
    "embedding": [0.123, -0.456, ...],
    "prompt_text": "normalized prompt for text fallback",
    "response": "{\"id\":\"...\",\"choices\":[...]}",
    "provider": "openai",
    "model": "gpt-5",
    "created_at": 1722096000000,
    "ttl_ms": 3600000,
    "hits": 0
}
```

### 3.2 — API surface

| Function | Signature | Behavior |
|---|---|---|
| `lookup` | `(requestBody, model, config, r) → string \| null` | Computes embedding, scans entries for this model, returns cached response body on hit, null on miss |
| `store` | `(requestBody, model, response, config, r) → void` | Computes embedding, creates entry at head of LRU list, evicts tail if count > max_entries |
| `evict` | `(model) → number` | Clears all entries for a model, returns count cleared |
| `prune` | `(now) → number` | Removes all expired entries across all models (called lazily on access or explicitly) |

### 3.3 — `lookup()` flow

```
1. Extract prompt text from requestBody
   → Join content of all messages with role === "user", separated by space
2. Try: promptEmbedding = await embeddings.compute(r, promptText, config)
3. If embeddings.compute succeeds:
   → For each entry in {model}:entries (LRU order, newest first):
     a. Parse entry JSON from {model}:entry:{N}
     b. Skip if expired (created_at + ttl_ms < now)
     c. Compute cosineSimilarity(promptEmbedding, entry.embedding)
     d. If similarity >= config.similarity_threshold:
        → Update entry: set created_at = now, increment hits
        → Move entry to head of LRU list
        → Return entry.response
   → If no match found: return null
4. If embeddings.compute fails (catch):
   → Fall back to text similarity:
     a. Normalize promptText (lowercase, strip punctuation, collapse whitespace)
     b. For each valid entry:
        → Compute textSimilarity(normalizedPrompt, entry.prompt_text) using Jaccard 3-gram
        → If >= config.text_similarity_threshold: update LRU, return entry.response
     c. If no match: return null
```

### 3.4 — `store()` flow

```
1. Extract prompt text from requestBody (same extraction as lookup)
2. Try: promptEmbedding = await embeddings.compute(r, promptText, config)
3. If embeddings.compute fails:
   → Store with embedding = null (entry only usable via text fallback)
4. Create entry JSON with embedding, prompt_text, response, provider, model, created_at=now, ttl_ms, hits=0
5. Assign next entry index: N = {model}:count
6. Write entry to {model}:entry:{N}
7. Prepend N to {model}:entries array head
8. If {model}:count >= max_entries:
   → Pop tail index from {model}:entries
   → Delete {model}:entry:{tail}
   → Decrement {model}:count
9. Increment {model}:count
```

### 3.5 — Utility functions (module-private)

```javascript
function cosineSimilarity(a, b) → number
function textSimilarity(a, b) → number    // Jaccard 3-gram
function normalize(text) → string         // lowercase, strip non-alphanum
function ngrams(text, n=3) → Set<string>
function extractPrompt(requestBody) → string  // concat user messages
function lruPin(model, index) → void      // move entry to head
```

---

## Phase 4: Integration in `njs/aiproxy.js`

### 4.1 — Import

```javascript
import cache from 'cache.js';
```

Export updated (no other changes needed to the export default):
```javascript
export default { load_rbac, route };
```

### 4.2 — Inject cache lookup in `route()`

After RBAC validation and model resolution (after line 235 in current code), **before** `tryModel()`:

```javascript
// ── Semantic cache lookup ──
const cacheConfig = config.semantic_cache;
if (cacheConfig && cacheConfig.enabled) {
    const cachedResponse = await cache.lookup(requestBody, requestedModel, cacheConfig, r);
    if (cachedResponse !== null) {
        r.log(`Cache hit for model '${requestedModel}'`);
        // Set token vars from cached response
        try {
            const parsed = JSON.parse(cachedResponse);
            if (parsed.usage) {
                r.variables.ai_proxy_response_prompt_tokens = parsed.usage.prompt_tokens || "";
                r.variables.ai_proxy_response_completion_tokens = parsed.usage.completion_tokens || "";
                r.variables.ai_proxy_response_total_tokens = parsed.usage.total_tokens || "";
            }
        } catch (e) { /* ignore */ }
        r.return(200, cachedResponse);
        return;
    }
}
```

### 4.3 — Inject cache storage after successful upstream response

After the successful response (after line 267, inside the `if (serviceReply.status === 200)` block), add:

```javascript
// ── Store in semantic cache ──
if (cacheConfig && cacheConfig.enabled) {
    cache.store(requestBody, requestedModel, responseBody, cacheConfig, r);
}
```

---

## Phase 5: Testing

### 5.1 — Manual smoke tests (curl)

```bash
# Test 1: Exact prompt → cache hit (second call)
curl -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello, how are you?"}]}'

# Same request again → should return cached response
curl -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello, how are you?"}]}'

# Test 2: Similar prompt → semantic cache hit
curl -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hi, how are you doing?"}]}'

# Test 3: Different prompt → cache miss
curl -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Write a poem about trees"}]}'

# Test 4: Different model → separate cache entry
curl -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello, how are you?"}]}'

# Test 5: Text fallback (stop Ollama, repeat Test 1)
```

### 5.2 — Unit tests (`njs/cache_test.js`, `njs/embeddings_test.js`)

- LRU ordering: insert N+1 entries, verify oldest evicted
- TTL expiry: set TTL=1s, wait, verify entry skipped
- Cosine similarity: known vectors, verify expected score
- Embedding API failure: verify text fallback triggers correctly
- Text similarity: known strings, verify Jaccard score

---

## File Summary

| File | Action | Purpose |
|---|---|---|
| `njs/embeddings.js` | **NEW** | Ollama embedding API client |
| `njs/cache.js` | **NEW** | LRU+TTL cache store with semantic matching |
| `njs/aiproxy.js` | **MODIFY** | Inject cache lookup before upstream, cache store after success |
| `config/aiproxy.conf` | **MODIFY** | Add shared dict, Ollama upstream, `/ollama-embedding` location, new js_imports |
| `config/rbac.json` | **MODIFY** | Add `semantic_cache` configuration block |

---

## Dependencies

- **Ollama** running locally with `nomic-embed-text` model pulled:
  ```bash
  ollama pull nomic-embed-text
  ```
- The Docker run command must expose Ollama to the container (e.g. `--network host` or `host.docker.internal`)
- No new npm packages, no new Dockerfile — everything runs within NGINX NJS runtime

---

## Edge Cases Handled

| Scenario | Behavior |
|---|---|
| Ollama is down | Text fallback activates; requests still work |
| Cache dict is full | LRU eviction removes oldest entry |
| Expired entry found during lookup | Lazy prune — entry is skipped, not returned |
| Subrequest to upstream fails (non-200) | Response is NOT cached (only 200 responses stored) |
| Cached response has different format than expected | Wrapped in try/catch, logs warning, proceeds as miss |
| Multiple concurrent requests | NJS is single-threaded per worker; no race conditions on shared dict |
