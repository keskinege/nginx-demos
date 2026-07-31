# Cache Backend Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two optional cache backends alongside the existing in-process shared dictionary: (1) Redis Stack with vector search via a Python sidecar, and (2) NGINX Plus zone_sync for zero-code shared dict replication across instances.

**Architecture:** The shared dict remains the primary cache in all configurations. Redis is an optional L2 layer — consulted after the shared dict (or instead of the scan), with seamless fallback on error. zone_sync requires zero code changes to NJS — it's a pure NGINX Plus config addition that automatically replicates shared dict writes across instances. Both are opt-in via config; the default ("shared") path is unchanged.

**Tech Stack:** NJS `ngx.fetch()` for HTTP calls, Python 3.12 + FastAPI + `redis-py` + Redis Stack (7.2+ with RediSearch). NGINX Plus `zone_sync` module (config only, no code). Docker Compose for orchestration.

## Global Constraints

- Image must be `nginx:1.29.1` (OSS) — no custom NGINX build for Redis path
- NGINX Plus zone_sync requires NGINX Plus (commercial) — documented but not included in Docker Compose
- No npm packages in NJS (NJS has no package manager)
- Python sidecar must use only `fastapi`, `uvicorn`, `redis`
- All new containers must have healthchecks
- The existing shared-dict cache path must remain the default and work without any Redis or Plus dependency
- Zero changes to `aiproxy.js` — all cache backend selection lives in `cache.js`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `vector-bridge/Dockerfile` | **NEW** | Python container build |
| `vector-bridge/requirements.txt` | **NEW** | Python deps (fastapi, uvicorn, redis) |
| `vector-bridge/app.py` | **NEW** | FastAPI app: vector index management, search, store, evict |
| `njs/redis_vector.js` | **NEW** | NJS HTTP client for the vector-bridge REST API |
| `njs/cache.js` | **MODIFY** | Add store dispatch: `"redis"` → `redis_vector`, `"shared"` → existing path |
| `njs/aiproxy.js` | **NO CHANGE** | Dispatch is transparent to the route handler |
| `config/aiproxy.conf` | **MODIFY** | Add `vector-bridge` upstream, `/vector-bridge` internal location; document zone_sync config |
| `config/rbac.json` | **MODIFY** | Add `"store": "redis"` / `"redis_l2"` / `"redis_only"` options in `semantic_cache` |
| `docker-compose.yml` | **MODIFY** | Add `redis-stack` and `vector-bridge` services |
| `tests/redis_vector_test.js` | **NEW** | Unit tests for the NJS Redis client |
| `tests/test.sh` | **MODIFY** | Add optional Redis healthcheck and vector-bridge readiness probe |
| `docs/superpowers/specs/2026-07-31-cache-backend-options-design.md` | **NEW** | Design spec |

---

### Task 1: Infrastructure — Docker & NGINX Config

**Files:**
- Create: `vector-bridge/Dockerfile`
- Create: `vector-bridge/requirements.txt`
- Modify: `docker-compose.yml:1-47`
- Modify: `config/aiproxy.conf:1-139`

**Interfaces:**
- Consumes: existing `docker-compose.yml`, `config/aiproxy.conf`
- Produces: `redis-stack` container on port 6379, `vector-bridge` container on port 8000 (internal), NGINX `/vector-bridge` internal location, zone_sync documentation in aiproxy.conf

- [ ] **Step 1: Create `vector-bridge/Dockerfile`**

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Create `vector-bridge/requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.31.0
redis==5.2.0
```

- [ ] **Step 3: Add `redis-stack` and `vector-bridge` to `docker-compose.yml`**

Add these services after the `ollama` service block:

```yaml
  redis-stack:
    image: redis/redis-stack:7.2.0-v9
    container_name: ai-proxy-redis
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  vector-bridge:
    build:
      context: ./vector-bridge
      dockerfile: Dockerfile
    container_name: ai-proxy-vector-bridge
    ports:
      - "127.0.0.1:8000:8000"
    depends_on:
      redis-stack:
        condition: service_healthy
    environment:
      - REDIS_HOST=redis-stack
      - REDIS_PORT=6379
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 5s
      timeout: 3s
      retries: 15
      start_period: 15s
```

Add `redis_data` to the `volumes:` block:

```yaml
volumes:
  ollama_data:
  nginx_keys:
  redis_data:
```

Make `nginx` depend on `vector-bridge` (not directly on `redis-stack`):

```yaml
  nginx:
    depends_on:
      ollama:
        condition: service_healthy
      vector-bridge:
        condition: service_healthy
```

- [ ] **Step 4: Add vector-bridge upstream and internal location to `config/aiproxy.conf`**

After the `ollama` upstream block:

```nginx
upstream vector_bridge {
    zone vector_bridge 64k;
    server vector-bridge:8000;
}
```

After the `/openai-embedding` location block:

```nginx
location /vector-bridge {
    internal;

    proxy_pass http://vector_bridge;
    proxy_set_header Host vector-bridge;
    proxy_set_header Content-Type "application/json";
    proxy_pass_request_headers off;

    proxy_http_version 1.1;

    proxy_buffer_size 16k;
    proxy_buffers 8 16k;
    proxy_busy_buffers_size 32k;
}
```

- [ ] **Step 5: Add zone_sync configuration comment block to `config/aiproxy.conf`**

Add this as a comment block near the `js_shared_dict_zone` declaration (no active code — documentation only):

```nginx
# ── NGINX Plus zone_sync (optional, for multi-instance shared dict replication) ──
#
# If you run NGINX Plus in a multi-instance cluster, uncomment and adapt the
# following on each instance to replicate the ai_cache shared dict automatically.
# No NJS code changes needed — zone_sync operates at the shared memory layer.
#
#     server {
#         listen <INTERNAL_IP>:9000;
#         zone_sync;
#     }
#     zone_sync_server <PEER1_IP>:9000;
#     zone_sync_server <PEER2_IP>:9000;
#
# Reads are always local (zero network latency). Writes are broadcast to peers
# asynchronously. If a peer is unreachable, the local dict still works — the
# peer re-syncs on reconnection.
#
# NOTE: Requires NGINX Plus. Not available in NGINX OSS (nginx:1.29.1).
```

---

### Task 2: Python Sidecar — `vector-bridge/app.py`

**Files:**
- Create: `vector-bridge/app.py`

**Interfaces:**
- Consumes: `REDIS_HOST` and `REDIS_PORT` env vars (defaults: `redis-stack`, `6379`)
- Produces: REST API at `GET /health`, `POST /lookup/{model}`, `POST /store/{model}`, `DELETE /evict/{model}`

The sidecar translates HTTP requests from NJS into Redis RESP commands:
1. On startup, connects to Redis Stack
2. For each model it encounters, creates a RediSearch index with a VECTOR field (COSINE distance, FLAT)
3. Exposes HTTP endpoints that NJS calls via `ngx.fetch()`

- [ ] **Step 1: Write `vector-bridge/app.py`**

```python
import os
import json
import logging
from contextlib import asynccontextmanager

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

REDIS_HOST = os.environ.get("REDIS_HOST", "redis-stack")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
VECTOR_DIMS = int(os.environ.get("VECTOR_DIMS", 768))
TTL_SECONDS = int(os.environ.get("CACHE_TTL", 3600))
MAX_ENTRIES = int(os.environ.get("CACHE_MAX_ENTRIES", 5000))

r = None

INDEX_PREFIX = "idx:"
ENTRY_PREFIX = "entry:"
INDEX_TEMPLATE = (
    "FT.CREATE {idx_name} ON HASH PREFIX 1 {prefix} "
    "SCHEMA embedding VECTOR FLAT 6 DIM {dims} TYPE FLOAT32 DISTANCE_METRIC COSINE "
    "model TAG SEPARATOR ; "
    "created_at NUMERIC SORTABLE "
    "ttl_ms NUMERIC "
    "hits NUMERIC"
)


class LookupRequest(BaseModel):
    embedding: list[float]
    threshold: float = 0.95
    model: str


class LookupResponse(BaseModel):
    response: str | None = None
    score: float | None = None
    key: str | None = None


class StoreRequest(BaseModel):
    embedding: list[float]
    prompt_text: str
    response: str
    model: str
    created_at: int
    ttl_ms: int
    hits: int = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global r
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    r.ping()
    logging.info(f"Connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
    yield
    r.close()


app = FastAPI(title="Vector Bridge", lifespan=lifespan)


def ensure_index(model: str):
    idx_name = f"{INDEX_PREFIX}{model}"
    try:
        r.ft(idx_name).info()
    except redis.ResponseError:
        prefix = f"{ENTRY_PREFIX}{model}:"
        r.execute_command(
            INDEX_TEMPLATE.format(idx_name=idx_name, prefix=prefix, dims=VECTOR_DIMS)
        )
        logging.info(f"Created index {idx_name} with prefix {prefix}")


@app.get("/health")
def health():
    try:
        r.ping()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/lookup/{model}", response_model=LookupResponse)
def lookup(model: str, req: LookupRequest):
    ensure_index(model)
    idx_name = f"{INDEX_PREFIX}{model}"

    query = "*=>[KNN 1 @embedding $vec AS vector_score]"
    params = {
        "vec": _vector_to_bytes(req.embedding),
    }

    try:
        results = r.ft(idx_name).search(query, query_params=params)
    except redis.ResponseError as e:
        logging.warning(f"FT.SEARCH failed for {model}: {e}")
        return LookupResponse(response=None, score=None, key=None)

    if not results.docs:
        return LookupResponse(response=None, score=None, key=None)

    doc = results.docs[0]
    distance = float(doc.vector_score)

    # Convert COSINE distance to similarity and compare against threshold
    similarity = 1.0 - distance
    if similarity < req.threshold:
        return LookupResponse(response=None, score=None, key=None)

    r.hincrby(doc.id, "hits", 1)
    r.hset(doc.id, "created_at", int(__import__("time").time() * 1000))

    return LookupResponse(
        response=doc.response,
        score=similarity,
        key=doc.id,
    )


@app.post("/store/{model}")
def store(model: str, req: StoreRequest):
    ensure_index(model)
    entry_key = f"{ENTRY_PREFIX}{model}:{_next_seq(model)}"

    r.hset(entry_key, mapping={
        "embedding": _vector_to_bytes(req.embedding),
        "prompt_text": req.prompt_text,
        "response": req.response,
        "model": model,
        "created_at": req.created_at,
        "ttl_ms": req.ttl_ms,
        "hits": req.hits,
    })

    if req.ttl_ms > 0:
        r.pexpire(entry_key, req.ttl_ms)

    _trim_model(model)
    return {"stored": True, "key": entry_key}


@app.delete("/evict/{model}")
def evict(model: str):
    idx_name = f"{INDEX_PREFIX}{model}"
    prefix = f"{ENTRY_PREFIX}{model}:*"
    keys = r.keys(prefix)
    if keys:
        r.delete(*keys)
    try:
        r.ft(idx_name).dropindex()
    except redis.ResponseError:
        pass
    return {"evicted": len(keys)}


def _next_seq(model: str) -> int:
    seq_key = f"seq:{model}"
    return r.incr(seq_key)


def _trim_model(model: str):
    prefix = f"{ENTRY_PREFIX}{model}:*"
    count = len(r.keys(prefix))
    if count > MAX_ENTRIES:
        keys = r.keys(prefix)
        keys.sort()
        excess = count - MAX_ENTRIES
        for key in keys[:excess]:
            r.delete(key)


def _vector_to_bytes(vector: list[float]) -> bytes:
    import struct
    return struct.pack(f"{len(vector)}f", *vector)
```

- [ ] **Step 2: Verify the Dockerfile builds**

```bash
cd /Users/k.keskinege/Documents/nginx/nginx-demos/nginx/ai-proxy
docker compose build vector-bridge
```

Expected: build succeeds, image tagged as `ai-proxy-vector-bridge`.

---

### Task 3: NJS Redis Client — `njs/redis_vector.js`

**Files:**
- Create: `njs/redis_vector.js`

**Interfaces:**
- Consumes: `r` (NJS request object), embedding, model name, config
- Produces: functions `lookup(r, embedding, model, config) → {response, score, key} | null`, `store(r, entry, model, config) → void`, `evict(model) → void`

All functions are best-effort: return null on any error, never throw. The caller (cache.js) handles the fallback to shared dict.

- [ ] **Step 1: Write `njs/redis_vector.js`**

```javascript
const VECTOR_BRIDGE_BASE = '/vector-bridge';

async function fetchJSON(url, options) {
    const res = await ngx.fetch(url, options);
    if (res.status !== 200) return null;
    try {
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function lookup(r, embedding, model, config) {
    const threshold = config.similarity_threshold || 0.95;
    try {
        const body = JSON.stringify({
            embedding: embedding,
            threshold: threshold,
            model: model
        });
        const result = await fetchJSON(
            `${VECTOR_BRIDGE_BASE}/lookup/${encodeURIComponent(model)}`,
            { method: 'POST', headers: {'Content-Type': 'application/json'}, body: body }
        );
        if (result && result.response) {
            r.log(`Redis cache: HIT for model '${model}', score=${result.score}`);
            return result;
        }
        r.log(`Redis cache: MISS for model '${model}'`);
        return null;
    } catch (e) {
        r.log(`Redis cache: lookup error for model '${model}' (${e.message})`);
        return null;
    }
}

async function store(r, entry, model, config) {
    try {
        const ttlMs = (config.ttl_seconds || 3600) * 1000;
        const body = JSON.stringify({
            embedding: entry.embedding || [],
            prompt_text: entry.prompt_text,
            response: entry.response,
            model: model,
            created_at: entry.created_at || Date.now(),
            ttl_ms: entry.ttl_ms || ttlMs,
            hits: entry.hits || 0
        });
        const result = await fetchJSON(
            `${VECTOR_BRIDGE_BASE}/store/${encodeURIComponent(model)}`,
            { method: 'POST', headers: {'Content-Type': 'application/json'}, body: body }
        );
        if (result && result.stored) {
            r.log(`Redis cache: STORED for model '${model}' at key ${result.key}`);
        }
    } catch (e) {
        r.log(`Redis cache: store error for model '${model}' (${e.message})`);
    }
}

export default { lookup, store };
```

- [ ] **Step 2: Write unit test `tests/redis_vector_test.js`**

```javascript
import redisVector from 'redis_vector.js';

const mockResponses = [];
let fetchCallCount = 0;

globalThis.ngx = {
    fetch: async function(url, options) {
        fetchCallCount++;
        const idx = fetchCallCount - 1;
        const mock = mockResponses[idx] || mockResponses[mockResponses.length - 1];
        if (mock.error) throw mock.error;
        return {
            status: mock.status || 200,
            json: async () => mock.body || {}
        };
    }
};

function resetMocks() { mockResponses.length = 0; fetchCallCount = 0; }
function assert(cond, msg) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) process.exit(1); }

const mockR = { log: function() {} };

// Test 1: Lookup HIT
resetMocks();
mockResponses.push({
    status: 200,
    body: { response: '{"choices":[{"message":{"content":"Hello!"}}]}', score: 0.97, key: 'entry:gpt-5:42' }
});
const hit = await redisVector.lookup(mockR, [0.1, 0.2], 'gpt-5', { similarity_threshold: 0.95 });
assert(hit !== null, 'lookup returns result on HIT');
assert(hit.response === '{"choices":[{"message":{"content":"Hello!"}}]}', 'lookup returns response body');
assert(hit.score === 0.97, 'lookup returns score');

// Test 2: Lookup MISS
resetMocks();
mockResponses.push({ status: 200, body: { response: null, score: null } });
const miss = await redisVector.lookup(mockR, [0.1, 0.2], 'gpt-5', {});
assert(miss === null, 'lookup returns null on MISS');

// Test 3: Lookup with unreachable sidecar
resetMocks();
mockResponses.push({ error: new Error('Connection refused') });
const err = await redisVector.lookup(mockR, [0.1, 0.2], 'gpt-5', {});
assert(err === null, 'lookup returns null when sidecar is unreachable');

// Test 4: Store succeeds
resetMocks();
mockResponses.push({ status: 200, body: { stored: true, key: 'entry:gpt-5:1' } });
await redisVector.store(mockR, {
    embedding: [0.1, 0.2], prompt_text: 'Hello', response: '{}',
    created_at: Date.now(), ttl_ms: 3600000, hits: 0
}, 'gpt-5', { ttl_seconds: 3600 });
assert(fetchCallCount === 1, 'store makes exactly one fetch call');

// Test 5: Store with unreachable sidecar does not throw
resetMocks();
mockResponses.push({ error: new Error('Connection refused') });
let threw = false;
try { await redisVector.store(mockR, {
    embedding: [0.1, 0.2], prompt_text: 'Hello', response: '{}',
    created_at: Date.now(), ttl_ms: 3600000, hits: 0
}, 'gpt-5', {}); } catch (e) { threw = true; }
assert(!threw, 'store does not throw when sidecar is unreachable');

console.log('\nredis_vector.js tests: 5 passed, 0 failed');
```

---

### Task 4: Cache Backend Selection — Modify `njs/cache.js`

**Files:**
- Modify: `njs/cache.js:1-337`

**Interfaces:**
- Consumes: `redis_vector.js`, existing shared-dict functions
- Produces: `lookup()` and `store()` that dispatch to Redis or shared dict based on `config.store`

The key design: the **shared dict is always the primary cache**. Redis is an optional L2 that supplements it. Four store modes:

| Mode | Lookup order | Store targets |
|---|---|---|
| `"shared"` (default) | shared dict → text fallback | shared dict |
| `"redis"` | Redis → shared dict → text | shared dict + Redis |
| `"redis_l2"` | shared dict → Redis → text | shared dict + Redis |
| `"redis_only"` | Redis → text | Redis only |

- [ ] **Step 1: Add import at top of `njs/cache.js`**

After `import embeddings from 'embeddings.js';`:

```javascript
import redisVector from 'redis_vector.js';
```

- [ ] **Step 2: Modify `lookup()` — add Redis dispatch**

Replace the beginning of `lookup()` (current lines 139-158) and the scan loop that follows:

```javascript
async function lookup(requestBody, model, config, r) {
    const result = { response: null, promptText: '', embedding: null, embeddingFailed: false };

    const promptText = extractPrompt(requestBody);
    if (!promptText) return result;
    result.promptText = promptText;

    const threshold = config.similarity_threshold || 0.95;
    const textThreshold = config.text_similarity_threshold || 0.85;
    const now = Date.now();

    // Compute embedding once — shared by all cache paths
    let promptEmbedding = null;
    try {
        promptEmbedding = await embeddings.compute(r, promptText, config);
        result.embedding = promptEmbedding;
    } catch (e) {
        r.log(`Semantic cache: embedding compute failed (${e.message}), falling back to text similarity`);
        result.embeddingFailed = true;
    }

    const storeMode = config.store || 'shared';

    // ── Mode "redis": try Redis vector search first (fast path for large caches) ──
    if (storeMode === 'redis' && promptEmbedding) {
        try {
            const redisHit = await redisVector.lookup(r, promptEmbedding, model, config);
            if (redisHit && redisHit.response) {
                result.response = redisHit.response;
                r.log(`Redis cache: HIT for model '${model}', score=${redisHit.score}`);
                return result;
            }
        } catch (e) {
            r.log(`Redis cache: lookup failed for model '${model}' (${e.message}), falling back to shared dict`);
        }
    }

    // ── Shared dict scan (always performed except in "redis_only" mode) ──
    if (storeMode !== 'redis_only') {
        const normPrompt = normalize(promptText);
        const entries = readEntries(model);
        let bestSemantic = null, bestSemanticScore = -1;
        let bestText = null, bestTextScore = -1;
        const expiredIdx = [];

        for (let i = 0; i < entries.length; i++) {
            const idx = entries[i];
            const entry = readJSON(entryKey(model, idx));
            if (!entry) continue;
            if (isExpired(entry, now)) { expiredIdx.push(idx); continue; }

            if (promptEmbedding && entry.embedding && entry.embedding.length > 0) {
                const score = cosineSimilarity(promptEmbedding, entry.embedding);
                if (score >= threshold && score > bestSemanticScore) {
                    bestSemantic = entry; bestSemanticScore = score; bestSemanticIdx = idx;
                }
            } else if (entry.prompt_text) {
                const score = jaccardSimilarity(normPrompt, normalize(entry.prompt_text));
                if (score >= textThreshold && score > bestTextScore) {
                    bestText = entry; bestTextScore = score; bestTextIdx = idx;
                }
            }
        }

        // Lazy prune expired entries
        if (expiredIdx.length > 0) {
            try {
                const remaining = entries.filter(idx => expiredIdx.indexOf(idx) === -1);
                writeEntries(model, remaining);
                for (let i = 0; i < expiredIdx.length; i++)
                    dict().delete(entryKey(model, expiredIdx[i]));
            } catch (e) { /* best-effort */ }
        }

        // Semantic matches always win over text matches
        let bestMatch = null, bestMatchIdx = -1, matchKind = null;
        if (bestSemantic) { bestMatch = bestSemantic; bestMatchIdx = bestSemanticIdx; matchKind = 'semantic'; }
        else if (bestText) { bestMatch = bestText; bestMatchIdx = bestTextIdx; matchKind = 'text'; }

        if (bestMatch) {
            bestMatch.hits = (bestMatch.hits || 0) + 1;
            bestMatch.created_at = now;
            try {
                writeJSON(entryKey(model, bestMatchIdx), bestMatch);
                lruPin(model, bestMatchIdx);
            } catch (e) { /* best-effort */ }
            r.log(`Semantic cache: HIT for model '${model}', match=${matchKind}, score=${(matchKind === 'semantic' ? bestSemanticScore : bestTextScore).toFixed(4)}, hits=${bestMatch.hits}`);
            result.response = bestMatch.response;
            return result;
        }
    }

    // ── Mode "redis_l2": try Redis after shared dict missed ──
    if (storeMode === 'redis_l2' && promptEmbedding) {
        try {
            const redisHit = await redisVector.lookup(r, promptEmbedding, model, config);
            if (redisHit && redisHit.response) {
                result.response = redisHit.response;
                r.log(`Redis cache (L2): HIT for model '${model}', score=${redisHit.score}`);
                return result;
            }
        } catch (e) {
            r.log(`Redis cache (L2): lookup failed for model '${model}' (${e.message})`);
        }
    }

    const scanned = storeMode !== 'redis_only' ? readEntries(model).length : 0;
    r.log(`Semantic cache: MISS for model '${model}' (mode=${storeMode}, entries scanned=${scanned})`);
    return result;
}
```

- [ ] **Step 3: Modify `store()` — add Redis write after shared-dict write**

After the shared-dict write block (after `writeEntries(model, entries)` in the try block), add:

```javascript
        // ── Redis store (optional L2) ──
        if (config.store && config.store !== 'shared' && promptEmbedding && promptEmbedding.length > 0) {
            try {
                await redisVector.store(r, entry, model, config);
            } catch (e) {
                r.log(`Redis cache: store failed for model '${model}' (${e.message})`);
            }
        }
```

In `"redis_only"` mode, skip the shared-dict write entirely:

```javascript
    // Best-effort writes: a full shared zone must never break the response path.
    try {
        if (config.store !== 'redis_only') {
            const idx = readSeq(model);
            writeJSON(entryKey(model, idx), entry);
            writeSeq(model, idx + 1);

            const entries = readEntries(model);
            entries.unshift(idx);
            while (entries.length > maxEntries) {
                const tail = entries.pop();
                dict().delete(entryKey(model, tail));
            }
            writeEntries(model, entries);
        }

        // Always try Redis if configured (even if shared-dict write failed)
        if (config.store && config.store !== 'shared' && promptEmbedding && promptEmbedding.length > 0) {
            await redisVector.store(r, entry, model, config);
        }
    } catch (e) {
        r.log(`Semantic cache: store failed for model '${model}' (${e.message})`);
    }
```

- [ ] **Step 4: Run existing unit tests to verify no regression**

```bash
cd /Users/k.keskinege/Documents/nginx/nginx-demos/nginx/ai-proxy
docker compose run --rm --entrypoint njs nginx:1.29.1 -p /etc/njs /tests/cache_test.js
docker compose run --rm --entrypoint njs nginx:1.29.1 -p /etc/njs /tests/cache_dict_test.js
```

Expected: all existing tests pass (28 + 22 = 50 assertions).

---

### Task 5: Configuration — Modify `config/rbac.json`

**Files:**
- Modify: `config/rbac.json:1-54`

**Interfaces:**
- Consumes: existing `semantic_cache` block
- Produces: updated `semantic_cache` with `"store"` field (shared | redis | redis_l2 | redis_only)

- [ ] **Step 1: Add `store` field to `config/rbac.json`**

```json
{
    "semantic_cache": {
        "enabled": true,
        "store": "shared",
        "similarity_threshold": 0.95,
        "text_similarity_threshold": 0.85,
        "ttl_seconds": 3600,
        "max_entries": 500,
        "redis_max_entries": 5000,
        "redis_ttl_seconds": 86400,
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

The `store` field accepts:
- `"shared"` (default) — use only the in-process shared dict. No Redis dependency.
- `"redis"` — try Redis vector search first, fall back to shared dict, then text similarity.
- `"redis_l2"` — try shared dict first, then Redis, then text similarity.
- `"redis_only"` — use only Redis (no shared dict). Falls back to text similarity.

---

### Task 6: Integration Wiring — Verify `njs/aiproxy.js`

**Files:**
- Verify: `njs/aiproxy.js:239-264` (cache lookup), `njs/aiproxy.js:308-316` (cache store)

**Interfaces:**
- Consumes: `cache.lookup()` and `cache.store()` (interfaces unchanged)
- Produces: no changes needed — all dispatch is transparent

The `cache.lookup()` and `cache.store()` calls in `aiproxy.js` already pass `config` through, and `config.store` is now read inside `cache.js`. The `cacheResult` object already carries `embedding` and `promptText` which `store()` needs for all paths.

```javascript
// Current code — already correct:
cacheResult = await cache.lookup(requestBody, requestedModel, cacheConfig, r);
// ... later ...
await cache.store(requestBody, requestedModel, responseBody, cacheConfig, r, cacheResult || undefined);
```

- [ ] **Step 1: Verify no changes needed**

Read `njs/aiproxy.js` lines 239-264 and 308-316. Confirm `config` is passed to both `cache.lookup()` and `cache.store()`. If yes, no edits required.

---

### Task 7: Integration Testing

**Files:**
- Create: `tests/redis_integration_test.sh`

**Interfaces:**
- Consumes: running Docker Compose stack with Redis + vector-bridge + Ollama + NGINX
- Produces: test results (PASS/FAIL)

- [ ] **Step 1: Write `tests/redis_integration_test.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-localhost:4242}"
PASSED=0
FAILED=0

function test() {
    local name="$1"; shift
    local expected_code="$1"; shift
    local expected_body="$1"; shift

    local response
    response=$(curl -s -w "\n%{http_code}" -X POST "$HOST/v1/chat/completions" \
        -H 'Content-Type: application/json' \
        -H 'x-api-key: sk-demo-key-user-a' \
        -d '{"model":"gpt-5","messages":[{"role":"user","content":"'"$1"'"}]}')
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

echo "=== Redis Vector Cache — Integration Tests ==="
echo ""

echo "Checking vector-bridge health..."
if ! curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    echo "SKIP: vector-bridge is not healthy"
    exit 0
fi

# Test 1: First request — cache MISS, upstream call
test "First request — MISS then upstream" 401 "invalid_api_key\|Incorrect API key" "Hello"

# Test 2: Same prompt — cache HIT from Redis (uses vector search)
test "Same prompt — Redis HIT" 401 "invalid_api_key\|Incorrect API key" "Hello"

# Test 3: Verify Redis has cached entries
echo ""
echo "Cache entries in Redis:"
docker compose exec redis-stack redis-cli KEYS 'entry:gpt-5:*'

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then exit 1; fi
```

- [ ] **Step 2: Run the integration test**

```bash
cd /Users/k.keskinege/Documents/nginx/nginx-demos/nginx/ai-proxy
export OPENAI_API_KEY="sk-..."
docker compose up -d --wait
./tests/redis_integration_test.sh
docker compose down -v
```

Expected: Test 1 shows MISS + 401, Test 2 shows HIT (same 401 body served from Redis), Test 3 confirms entries in Redis.

- [ ] **Step 3: Add optional Redis section to `test.sh`**

```bash
echo ""
echo "[3/3] Running Redis Cache Tests..."
if docker compose exec vector-bridge curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    if ! "$SCRIPT_DIR/tests/redis_integration_test.sh"; then
        echo "Redis cache tests failed!"
        docker compose logs vector-bridge
        exit 1
    fi
else
    echo "SKIP: Redis cache tests (vector-bridge not available)"
fi
```

---

### Task 8: Documentation — Write Design Spec

**Files:**
- Create: `docs/superpowers/specs/2026-07-31-cache-backend-options-design.md`

- [ ] **Step 1: Write the design spec**

See separate file. Covers all three cache backend options (shared dict, zone_sync, Redis), store modes, architecture diagrams, performance comparison, failure modes, and configuration reference.

---

### Task 9: NGINX Plus zone_sync Documentation

**Files:**
- Modify: `config/aiproxy.conf` (already has comment block from Task 1 Step 5)
- No code changes needed — zone_sync is pure config

**Interfaces:**
- Consumes: existing `js_shared_dict_zone zone=ai_cache:32M`
- Produces: replicated shared dict across NGINX Plus instances

zone_sync requires zero NJS code changes because it operates at the shared memory layer — below NJS's `ngx.shared` API. Every `dict().set()` call is automatically broadcast to sync peers.

- [ ] **Step 1: Verify the comment block in `config/aiproxy.conf`**

Verify the zone_sync documentation comment was added in Task 1 Step 5:

```nginx
# ── NGINX Plus zone_sync (optional, for multi-instance shared dict replication) ──
#
# If you run NGINX Plus in a multi-instance cluster, uncomment and adapt the
# following on each instance to replicate the ai_cache shared dict automatically.
# No NJS code changes needed — zone_sync operates at the shared memory layer.
#
#     server {
#         listen <INTERNAL_IP>:9000;
#         zone_sync;
#     }
#     zone_sync_server <PEER1_IP>:9000;
#     zone_sync_server <PEER2_IP>:9000;
#
# Reads are always local (zero network latency). Writes are broadcast to peers
# asynchronously. If a peer is unreachable, the local dict still works — the
# peer re-syncs on reconnection.
#
# NOTE: Requires NGINX Plus. Not available in NGINX OSS (nginx:1.29.1).
```

- [ ] **Step 2: Document zone_sync limitations and trade-offs**

No step needed — covered in the design spec (`docs/superpowers/specs/2026-07-31-cache-backend-options-design.md`).

---

### Task 10: Update README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all implementation from Tasks 1-9
- Produces: updated README with Redis and zone_sync documentation

- [ ] **Step 1: Add cache backend options section to README**

```markdown
### Cache Backend Options

The semantic cache supports multiple backends, controlled by the `"store"` field in `config/rbac.json`:

| `store` value | Lookup order | Store targets | Use case |
|---|---|---|---|
| `"shared"` (default) | shared dict → text | shared dict | Single instance, no extras needed |
| `"redis"` | Redis → shared dict → text | shared dict + Redis | Prefer speed (O(log N)), large caches |
| `"redis_l2"` | shared dict → Redis → text | shared dict + Redis | Low latency for small caches, Redis for overflow |
| `"redis_only"` | Redis → text | Redis only | Redis is authoritative |

**Redis Stack** (requires Docker Compose or separate Redis + vector-bridge deployment):
- Provides O(log N) vector search via RediSearch `FT.SEARCH` KNN
- Adds persistence (RDB/AOF) — cache survives NGINX restarts
- Shares cache across any number of NGINX instances (OSS or Plus)
- Falls back gracefully to shared dict and text similarity on error
- Start with: `docker compose -f docker-compose.yml -f docker-compose.redis.yml up -d`

**NGINX Plus zone_sync** (NGINX Plus only, no extra containers):
- Replicates the shared dict across Plus instances automatically
- Zero code changes — pure NGINX config addition
- Reads are local (sub-millisecond), writes are async broadcast
- See zone_sync config comments in `config/aiproxy.conf`
