# Cache Backend Options — Design Spec

> **Status:** Implementation plan complete
> **Date:** 2026-07-31
> **Scope:** Add two optional cache backends alongside the existing in-process shared dictionary: (1) Redis Stack with vector search via a Python sidecar, and (2) NGINX Plus zone_sync for automatic shared dict replication across instances.

## Architecture

The shared dictionary remains the **primary cache** in all configurations. Redis and zone_sync are optional additions that solve specific problems:

### Topology A: Single NGINX (OSS or Plus) — No extras

```
nginx worker 1 ──shared dict (ai_cache:32M)── nginx worker N
```

Existing behavior. In-process, zero dependencies, ~20ms HIT at 500 entries.

### Topology B: Multiple NGINX Plus instances — zone_sync

```
┌─────────────┐    zone_sync protocol    ┌─────────────┐
│ NGINX Plus A ├──────────────────────────┤ NGINX Plus B │
│ (shared dict)│◄────────────────────────►│ (shared dict)│
└─────────────┘                           └─────────────┘
     │                                         │
     ▼                                         ▼
  upstream LLM                             upstream LLM
```

The shared dict is replicated across Plus instances automatically. Every write to the dict on any instance is broadcast to all peers. Reads are local — zero network latency. **Zero code changes** — pure NGINX Plus config.

### Topology C: Any NGINX (OSS or Plus) + optional Redis vector search

```
nginx worker
  │
  ├── shared dict (L1, always) — local, fast, bounded
  │
  └── [if store === "redis"] ngx.fetch() ──► vector-bridge ──► Redis Stack
        │                                                        │
        └── HIT → return (O(log N), ~10ms)                       ├── FT.SEARCH KNN
           MISS → shared dict fallback (~20ms)                   └── HSET / PEXPIRE
```

Redis is an **additive L2 layer**: the shared dict always takes the first look and is always written to. Redis is consulted after the shared dict misses (or instead of the scan, depending on config). The shared dict's LRU+TTL logic is unaffected.

## Cache Backend Options

### Option 1: Shared Dict Only (Default)

| Attribute | Value |
|-----------|-------|
| **License** | NGINX OSS, any version |
| **Code changes** | None (existing) |
| **External deps** | None |
| **Multi-instance** | ❌ Fragmented (each instance has its own cache) |
| **Persistence** | ❌ Lost on restart |
| **Vector search** | ❌ O(N) cosine scan in NJS |
| **Capacity per model** | ~500 entries (32M zone) |

### Option 2: NGINX Plus zone_sync

zone_sync replicates shared memory zones across NGINX Plus instances. Each instance has its own local copy of the `ai_cache` dict; writes are broadcast to all peers via a TCP-based sync protocol.

**How it works:**
- One Plus instance is designated as the sync cluster's "leader" (or a mesh)
- Each instance opens a `zone_sync` listener on a dedicated port
- When `dict().set(key, value)` is called on instance A, the change is serialized and sent to instance B, C, etc.
- Reads are always local — no network round-trip on the request path

**NGINX Plus config:**
```nginx
# On every Plus instance in the cluster:
server {
    listen 10.0.0.1:9000;  # zone_sync listener (internal IP)
    zone_sync;
    zone_sync_interval 1s;         # heartbeat interval
    zone_sync_timeout 5s;          # connection timeout
    zone_sync_buffering 512k;      # sync buffer per peer
}

zone_sync_server 10.0.0.2:9000;  # peer 1
zone_sync_server 10.0.0.3:9000;  # peer 2
```

| Attribute | Value |
|-----------|-------|
| **License** | NGINX Plus only |
| **Code changes** | **Zero** (pure config change) |
| **External deps** | None |
| **Multi-instance** | ✅ **Native** — synchronous replication across Plus instances |
| **Persistence** | ❌ Lost on restart (zone_sync is memory-only) |
| **Vector search** | ❌ O(N) cosine scan in NJS (same as shared dict) |
| **Capacity per model** | ~500 entries per instance (zone holds full copy) |
| **HIT latency** | ~20ms (identical to shared dict — reads are local) |
| **Sync latency** | Sub-millisecond to ~10ms (depends on network) |
| **Consistency** | Eventual — writes are async broadcast |

**Best for:** You're already on NGINX Plus, have 2+ instances, and want a zero-effort shared cache without adding Redis to your stack.

### Option 3: Redis Stack with Vector Search

Redis is an **optional L2 cache** that sits behind the shared dict. It adds persistence, multi-instance sharing, and O(log N) vector search.

**Two sub-modes controlled by `store` config:**

| `store` value | Primary path | Fallback path |
|---|---|---|
| `"shared"` (default) | Shared dict only | Text similarity |
| `"redis"` | Redis vector search first | Shared dict → text similarity |
| `"redis_l2"` | Shared dict first | Redis vector search |
| `"redis_only"` | Redis only (no shared dict used) | Text similarity |

The `"redis_l2"` mode is the most conservative: the shared dict handles requests at ~5-20ms, and Redis is only consulted on shared dict MISS. This keeps Redis optional — if it's down, the shared dict still works.

| Attribute | Value |
|-----------|-------|
| **License** | NGINX OSS or Plus |
| **Code changes** | ~140 lines (redis_vector.js + cache.js dispatch) |
| **External deps** | Redis Stack + Python sidecar |
| **Multi-instance** | ✅ Single unified Redis pool across any number of instances |
| **Persistence** | ✅ RDB/AOF — survives restart |
| **Vector search** | ✅ **O(log N)** via RediSearch FT.SEARCH KNN |
| **Capacity per model** | Unlimited (Redis RAM) |
| **HIT latency** | ~10ms (constant, regardless of entry count) |
| **MISS penalty** | ~12ms (embedding + Redis query) + ~2ms shared dict check |

**Best for:** You need persistence, you have many NGINX instances (OSS or Plus), or your cache has grown beyond 500 entries per model where the O(N) scan starts to hurt.

## Comparison

| | Shared dict (baseline) | + zone_sync (Plus only) | + Redis Stack (any NGINX) |
|---|---|---|---|
| **Code changes** | None | None | ~140 lines NJS + ~80 lines Python |
| **External deps** | None | None | Redis + Python sidecar |
| **Multi-instance** | ❌ Fragmented | ✅ Zero-effort sync | ✅ Unified pool |
| **Persistence** | ❌ | ❌ | ✅ RDB/AOF |
| **Vector search** | ❌ O(N) | ❌ O(N) | ✅ O(log N) |
| **Max capacity** | ~500 | ~500 per instance | Unlimited |
| **HIT latency** | ~5-20ms | ~5-20ms (local read) | ~10ms (constant) |
| **Failure resilience** | Built-in | Sync failure → local only | Falls through to shared dict |
| **Operational cost** | Zero | NGINX Plus license | +Redis + Python containers |

## Configuration

### `rbac.json` (semantic_cache block)

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

| Field | Values | Description |
|---|---|---|
| `store` | `"shared"` \| `"redis"` \| `"redis_l2"` \| `"redis_only"` | Cache backend. Default: `"shared"`. |
| `redis_max_entries` | integer | Max entries per model in Redis. Default: 5000. |
| `redis_ttl_seconds` | integer | TTL for Redis entries. Default: 86400 (24h). |

**`store` values in detail:**

| Value | Lookup order | Store targets | Use case |
|---|---|---|---|
| `"shared"` | shared dict → text fallback | shared dict | Default, no Redis needed |
| `"redis"` | Redis vector search → shared dict → text | shared dict + Redis | Prefer speed (O(log N)), fall back to shared dict |
| `"redis_l2"` | shared dict → Redis → text | shared dict + Redis | Prefer low latency for small caches, Redis for large |
| `"redis_only"` | Redis vector search → text | Redis only | Redis is authoritative, no shared dict needed |

### zone_sync (NGINX Plus, no rbac.json change)

zone_sync is configured entirely in `aiproxy.conf` — zero code or config changes to the NJS modules. The shared dict is automatically replicated.

```nginx
# On each NGINX Plus instance:

# The existing shared dict — no changes needed
js_shared_dict_zone zone=ai_cache:32M;

# zone_sync listener (internal IP only, never exposed to clients)
server {
    listen 10.0.0.1:9000;
    zone_sync;
    zone_sync_interval 1s;
    zone_sync_timeout 5s;
    zone_sync_buffering 512k;
}

# Peers in the sync cluster
zone_sync_server 10.0.0.2:9000;
zone_sync_server 10.0.0.3:9000;
```

## Cache Backend Selection Logic

### `lookup()` in `cache.js`

```
1. Compute embedding (shared by all paths)
2. Switch on config.store:
   "redis":
     try Redis vector search via ngx.fetch → vector-bridge → FT.SEARCH
     HIT → return
     MISS/error → log, fall through to step 3
   "redis_l2":
     try shared dict scan first
     HIT → return
     MISS → try Redis vector search
     HIT → return + promote to shared dict
     MISS → fall through to step 3
   "redis_only":
     try Redis vector search
     HIT → return
     MISS/error → log, fall through to step 3
   "shared" (default):
     existing shared dict scan → step 3
3. Text similarity fallback (existing behavior)
4. MISS → return null → upstream LLM
```

### `store()` in `cache.js`

```
1. Create entry object (embedding, prompt_text, response, timestamps)
2. If store !== "redis_only":
     Write to shared dict (L1 cache — always, except redis_only mode)
3. If store starts with "redis":
     Write to Redis via ngx.fetch → vector-bridge → HSET
     Best-effort: catch errors, never block response
```

## Failure Modes

| Scenario | Shared dict only | + zone_sync | + Redis |
|---|---|---|---|
| zone_sync peer down | N/A | Local dict still works, peer re-syncs on reconnect | N/A |
| Redis container down | N/A | N/A | `depends_on` prevents NGINX start at boot |
| vector-bridge crashes at runtime | N/A | N/A | `redis_vector.js` returns null → falls through to shared dict |
| Embedding dimensions mismatch | N/A | N/A | RediSearch error → caught → shared dict fallback |
| Redis out of memory | N/A | N/A | Evicts oldest keys (allkeys-lru) or OOM → falls through |
| NGINX restart | Cache lost | Cache lost (zone_sync is memory-only) | RDB/AOF recovers Redis cache |

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `vector-bridge/Dockerfile` | NEW | Python container |
| `vector-bridge/requirements.txt` | NEW | fastapi, uvicorn, redis |
| `vector-bridge/app.py` | NEW | FastAPI sidecar (~80 lines) |
| `njs/redis_vector.js` | NEW | NJS Redis HTTP client (~60 lines) |
| `njs/cache.js` | MODIFY | Add store dispatch: `"redis"` → `redis_vector`, `"shared"` → existing path |
| `config/aiproxy.conf` | MODIFY | Add vector-bridge upstream + internal location |
| `config/rbac.json` | MODIFY | Add `store`, `redis_max_entries`, `redis_ttl_seconds` |
| `docker-compose.yml` | MODIFY | Add redis-stack + vector-bridge services |
| `tests/redis_vector_test.js` | NEW | NJS unit tests (6 tests) |
| `tests/redis_integration_test.sh` | NEW | Integration test script |
| `docs/superpowers/plans/2026-07-31-cache-backends.md` | NEW | Implementation plan |
