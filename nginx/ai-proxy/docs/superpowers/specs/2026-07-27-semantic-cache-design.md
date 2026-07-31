# NGINX AI Proxy — Semantic Caching Design

> **Status:** Implemented (with deviations — see erratum below)
> **Date:** 2026-07-27
> **Scope:** Add two-tier semantic caching (embedding similarity + normalized text fallback) to the existing AI proxy demo, using an L1 shared dict with LRU + TTL eviction. L2 (Redis) is deferred.
>
> **Erratum (2026-07-31):** The shipped implementation differs from this spec in several ways:
> - Entry indices use a monotonic `{model}:seq` counter (not `{model}:count`); count is derived from the LRU array length.
> - Cache entry fields: `created_at` (not `pinned_at`), `response` (not `response_body`), `prompt_text` (not `prompt_tokens`).
> - LRU uses a single `{model}:entries` JSON array (not separate `head`/`tail` keys).
> - Zone sized at 32M (not 10M), `max_entries` = 500 (not 1000).
> - NJS transitive imports resolve automatically; redundant `js_import` lines in `aiproxy.conf` were removed.
> - Config includes a `providers` sub-object under `embedding` (ollama and openai entries).

---

## 1. Overview

Add a semantic caching layer to the NGINX AI proxy demo. When a chat completion request arrives, the proxy computes an embedding of the input prompt, searches the cache for a semantically similar prior request (cosine similarity > threshold), and returns the cached response on hit — bypassing the upstream LLM entirely. On miss, the request proceeds normally and the response is stored in the cache alongside its embedding.

A normalized text fallback (Jaccard n-gram similarity) activates when the embedding API is unreachable.

## 2. Architecture

```
                         ┌──────────────────────────┐
                         │    NGINX AI Proxy         │
                         │                           │
    POST /v1/chat/       │  ┌─────────────────┐     │
    completions ─────────►  │  aiproxy.js      │     │
                         │  │  (routing)       │     │
                         │  └───────┬─────────┘     │
                         │          │               │
                         │  ┌───────▼─────────┐     │
                         │  │  cache.js        │     │
                         │  │  (semantic LRU)  │     │
                         │  └────┬──────┬─────┘     │
                         │       │      │           │
                         │       │      ▼           │
                         │       │  ┌─────────────┐ │
                         │       │  │embeddings.js│ │
                         │       │  │(Ollama)     │ │
                         │       │  └─────────────┘ │
                         │       ▼                  │
                         │  ┌─────────────────┐     │
                         │  │ L1: shared dict │     │
                         │  │ (in-process)    │     │
                         │  └─────────────────┘     │
                         │       │                  │
                         │       ▼ (optional)       │
                         │  ┌─────────────────┐     │
                         │  │ L2: Redis        │     │
                         │  └─────────────────┘     │
                         └──────────────────────────┘
```

**New files:**
- `njs/cache.js` — LRU+TTL cache store, semantic matching, cosine comparison
- `njs/embeddings.js` — Ollama embedding API client (local)

**Modified files:**
- `config/aiproxy.conf` — Add `js_shared_dict_zone`, Ollama upstream, `/ollama-embedding` internal location
- `config/rbac.json` — Add `semantic_cache` configuration block
- `njs/aiproxy.js` — Inject cache lookup before model routing

## 3. Cache data model

A cache entry is stored as JSON in the shared dictionary:

```json
{
  "embedding": [0.123, -0.456, ...],
  "prompt_text": "normalized prompt text for text fallback",
  "response": "{\"id\":\"...\",\"choices\":[...]}",
  "provider": "openai",
  "model": "gpt-5",
  "created_at": 1722096000000,
  "ttl_ms": 3600000,
  "hits": 0
}
```

- **embedding**: float array (768-dim for nomic-embed-text on Ollama; dimension varies by model)
- **prompt_text**: normalized form of the original prompt, used for text fallback
- **response**: the raw response JSON string from the upstream LLM
- **provider**: which LLM provider produced this response ("openai" or "anthropic")
- **model**: logical model name that produced this entry
- **created_at**: Unix epoch ms, used for LRU ordering and TTL expiry
- **ttl_ms**: milliseconds until this entry expires
- **hits**: counter incremented on each cache hit, for observability

## 4. Request flow

**Prompt extraction:** The "prompt" for embedding and caching purposes is the concatenated `content` field of all messages with `role: "user"` in the request body, joined with a space. System and assistant messages are excluded. This keeps cache lookups focused on user intent.

**Model scoping:** Cache entries are keyed per-model. The same prompt for `gpt-5` and `claude-sonnet-4-20250514` produces separate entries, since responses differ by model.

```
1. Request arrives at /v1/chat/completions
2. aiproxy.js validates user, model, RBAC (existing flow)
3. NEW: cache.lookup(requestBody, requestedModel, config, r) is called before tryModel()
   a. embeddings.js computes embedding of prompt via subrequest to /ollama-embedding
   b. cache.js iterates stored entries for this model
   c. Cosine similarity computed: dot(a,b) / (||a|| * ||b||)
   d. Track best match: semantic scores are tracked separately from text scores
   e. If embedding API succeeded: iterate entries, compute cosine similarity
        - If >= similarity_threshold: track as best semantic match
        - After scan, return the best semantic match (higher score preferred)
   f. If embedding API failed: fall back to normalized text comparison
        - Normalize: lowercase, strip punctuation, 3-gram Jaccard similarity
        - Track best text match; semantic matches always preferred over text matches
   g. On HIT: update entry's created_at (LRU pin), increment hits counter,
        move entry to head of LRU list, return cached response
   h. On MISS: return null (cache miss) — returned result includes the computed
        embedding and promptText for reuse by store()
4. On cache miss: proceed to tryModel() as before
5. On successful upstream response (200):
   a. Store response + embedding in cache via cache.store()
        - Reuses the embedding computed during lookup (single embedding per request)
   b. If count >= max_entries: evict LRU tail entry
6. Return response to client (same as before)
```

## 5. Module: cache.js

### API surface

```
cache.lookup(requestBody, model, config, r) → {response, promptText, embedding, embeddingFailed} | null
cache.store(requestBody, model, responseBody, cacheResult, config, r) → void
cache.evict(model) → number
cache.prune(now) → number
```

`lookup()` returns a result object (not just a string) so the caller can reuse the computed embedding and prompt text in `store()`, halving embedding round-trips on cache MISSes.

`r` is the NJS request object — needed by the embedding subrequest and for logging.

### LRU implementation

The shared dictionary stores entries using keys:
- `{model}:entry:{N}` — JSON blob per cache entry, where `N` comes from a monotonic `{model}:seq` counter (never decremented)
- `{model}:seq` — monotonic index allocator (incremented on every store, never decremented)
- `{model}:entries` — JSON array of entry indices in LRU order (head first)
- `{model}:count` — (derived from `{model}:entries` array length, not stored separately)

LRU operations:
- **Store**: assign next index from `{model}:seq`, write entry, prepend index to entries array head. If array length > max_entries, pop tail index and delete the corresponding `{model}:entry:{tail}` entry.
- **Lookup hit**: find entry, update its `created_at`, move to head by reordering the entries array.
- **TTL check**: on every lookup, skip entries where `now - created_at > ttl_ms`. Expired entries are **lazily deleted** from the dict and entries array.
- **Eviction via index allocator**: indices are never reused, avoiding the bug where count-based allocators overwrite live entries and self-evict.

**Performance note:** The `{model}:entries` array is read→modified→written as JSON on every cache access. At `max_entries=500`, the meta blob is ~8-10 KB. This is acceptable for a demo but a production implementation would use a native data structure or Redis for the ordering layer.

### Cosine similarity

```
function cosineSimilarity(a, b):
    let dot = 0, normA = 0, normB = 0
    for i in 0..len(a):
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
```

Plain JS computation — no external dependencies. Handles 1536-dim arrays in <1ms.

### Normalized text fallback

```
function textSimilarity(a, b):
    // Normalize: lowercase, strip non-alphanumeric
    // Tokenize into 3-grams
    // Jaccard: intersection.size / union.size

function normalize(text):
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '')

function ngrams(text, n=3):
    const grams = new Set()
    for i in 0..text.length-n:
        grams.add(text.slice(i, i+n))
    return grams
```

Only used as fallback when the embedding API subrequest fails.

## 6. Module: embeddings.js

### API surface

```
embeddings.compute(r, inputText, modelName, location, config) → Promise<Array<number>>
```

Accepts the NJS request object `r` to make the embedding subrequest.

### Flow

1. Send subrequest to the configured embedding location (e.g., `/ollama-embedding`)
2. Body: `{"model": "nomic-embed-text", "prompt": inputText}`
3. Parse response, extract `response.embedding` (flat float array)
4. Return float array

### Configuration (from rbac.json)

```json
{
  "semantic_cache": {
    "enabled": true,
    "similarity_threshold": 0.95,
    "text_similarity_threshold": 0.85,
    "ttl_seconds": 3600,
    "max_entries": 500,
    "embedding": {
      "provider": "ollama",
      "providers": {
        "ollama": {
          "model": "nomic-embed-text",
          "location": "/ollama-embedding",
          "dimensions": 768
        },
        "openai": {
          "model": "text-embedding-3-small",
          "location": "/openai-embedding",
          "dimensions": 1536
        }
      }
    }
  }
}
```

## 7. Configuration changes

### aiproxy.conf additions

```nginx
# Shared dictionary for semantic cache
# Each entry: ~10-16 KB (embedding float array) + response body ≈ ~20 KB
# 32M zone → ~1500 entries, comfortably above 2 models × max_entries=500
# No evict/timeout on zone (JS evict could delete LRU index keys)
js_shared_dict_zone zone=ai_cache:32M;

# Ollama upstream (local, no auth)
upstream ollama {
    zone ollama 64k;
    server localhost:11434;
}

# Internal location for Ollama embeddings
location /ollama-embedding {
    internal;
    rewrite ^ /api/embeddings break;
    proxy_pass_request_headers off;
    proxy_set_header Content-Type "application/json";
    proxy_method POST;
    proxy_pass http://ollama;
}
```

No API key or SSL needed — Ollama runs locally. No new templates or environment variables required.

## 8. NJS import structure

**cache.js** imports from `embeddings.js`:
```
import embeddings from 'embeddings.js';
```

**aiproxy.js** imports from `cache.js`:
```
import cache from 'cache.js';
```

**aiproxy.conf** only needs to import `aiproxy.js` — transitive NJS imports (`cache.js` → `embeddings.js`) resolve automatically relative to `/etc/njs`:
```
js_import /etc/njs/aiproxy.js;
```

## 9. Test strategy

### Unit tests (NJS test harness)

- `cache_test.js`: LRU ordering, TTL expiry, eviction overflow, entry store/retrieve, cosine similarity, Jaccard similarity, prompt extraction, parseOllamaResponse/parseOpenAIResponse
- `embeddings_test.js`: API call succeeds, API unreachable (fallback trigger)
- `cache_dict_test.js` (22 assertions): full cache machinery against an in-memory `ngx.shared` mock with a mock embedding subrequest — store/lookup round-trip, single embedding reuse, LRU eviction regression (20 stores against `max_entries=3`), TTL lazy deletion, text fallback, match preference, full-zone resilience

### Integration tests (curl-based, following README pattern)

- Cache hit: same prompt twice → second call returns cached response (verify response body identical)
- Cache miss: different prompt → different response
- Semantic similarity: "How do I reset my password?" and "I forgot my password, help" → cache hit
- TTL expiry: set low TTL, wait, verify miss
- Text fallback: stop Ollama, verify normalized text matching works

### Manual smoke test

```
# Drive two similar prompts
curl -s -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello, how are you?"}]}'

curl -s -X POST localhost:4242/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: sk-demo-key-user-a' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hi, how are you doing?"}]}'

# Second call should return the cached response (identical body, no new upstream call)
```

## 10. Limitations (explicit non-goals for this cycle)

- Only prompt-text embedding; does NOT embed images, tool calls, or function arguments
- L2 (Redis) is deferred — config placeholder exists but no implementation yet
- No cache warming, pre-population, or batch operations
- No per-user cache isolation (cache is global)
- No cache statistics endpoint (hits counters exist per-entry but no API surface)
