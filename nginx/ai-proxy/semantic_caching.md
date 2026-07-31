# Semantic Caching in NGINX AI Proxy

One of the most powerful features of this proxy is its ability to perform **Semantic Caching**. Traditional caching mechanisms require exact string matches (e.g., `Hello, world!` !== `hello world!`). Semantic caching, however, understands the *meaning* and *intent* behind a prompt. If a user asks "What is the capital of France?" and later asks "Which city is the capital of France?", the proxy recognizes that these prompts are semantically identical and serves the response from the cache without ever hitting the upstream AI model.

This document explains how this mechanism is implemented securely and efficiently within NGINX using NJS.

## 1. How the Semantic Cache Works

When an incoming request reaches the proxy, the system follows this workflow:

1. **Extract the Prompt**: The NJS engine (`cache.js`) iterates over the incoming JSON payload's `messages` array, extracts only the contents from the `user` roles, and concatenates them into a single string. System and assistant messages are deliberately ignored to focus purely on the user's intent.
2. **Compute Embeddings**: The proxy pauses the request and makes a subrequest to an embedding model. By default, this is configured to use a local `Ollama` container running the `nomic-embed-text` model, but it can easily be swapped to use OpenAI's `text-embedding-3-small` in `rbac.json`. The embedding model converts the user's prompt string into a high-dimensional mathematical vector (an array of numbers).
3. **Similarity Search**: The NJS engine retrieves previous entries from its shared memory dictionary. It calculates the **Cosine Similarity** between the incoming prompt's embedding vector and the stored embedding vectors.
4. **Cache HIT / MISS**: 
    - **HIT**: If the Cosine Similarity score exceeds the configured `similarity_threshold` (e.g., `0.95`), the proxy immediately intercepts the request, logs a "Cache HIT", updates the hit count/LRU position, and returns the cached JSON response to the user. When multiple entries exceed the threshold, the *best* scoring entry wins, and semantic (embedding) matches are always preferred over text-fallback matches.
    - **MISS**: If no cached embedding meets the threshold, the request is forwarded to the upstream AI provider. When the provider responds, the proxy stores the original prompt, its embedding vector, and the response in the shared memory cache for future use.
5. **One embedding per request**: the embedding computed during the cache lookup is reused for the store phase, so a cache MISS costs at most one extra embedding round-trip (never two).
6. **Streaming bypass**: requests with `"stream": true` skip the cache entirely — SSE bodies are never stored or served from the cache.

## 2. Text Similarity Fallback

To ensure the proxy is resilient, `cache.js` includes a graceful fallback mechanism. If the embedding provider (like Ollama) crashes, is offline, or throws an error, the proxy does not fail the user's request. 

Instead, it falls back to a **Jaccard Similarity** calculation based on text n-grams. The prompt is normalized (lowercased, stripped of punctuation), broken into 3-character chunks (n-grams), and compared against the text of previous prompts. If the Jaccard similarity exceeds the `text_similarity_threshold` (e.g., `0.85`), the proxy still serves the cached response.

## 3. Storage and Memory Management

The semantic cache must be incredibly fast to be useful. 
* **NGINX Shared Memory**: The cache is stored entirely in RAM using an NGINX shared dictionary (`js_shared_dict_zone zone=ai_cache:32M;`). This allows data to persist across multiple NGINX worker processes without relying on an external database like Redis.
* **Eviction (LRU)**: The cache implements a strict Least Recently Used (LRU) algorithm. If the cache reaches the `max_entries` limit defined in `rbac.json` (e.g., 500 entries), the proxy silently evicts the oldest, least-accessed entry to make room for the new one. Entry indices come from a monotonic per-model sequence counter, so eviction never corrupts the index.
* **Expiration (TTL)**: Entries are not stored forever. They expire based on the `ttl_seconds` setting. Expired entries found during a lookup are skipped **and lazily deleted** from the shared dictionary.
* **Memory sizing**: each entry holds a JSON float-array embedding (~10–16 KB for 768 dimensions) plus the upstream response body — plan for ~20 KB per entry. The 32M zone therefore holds ~1500 entries, comfortably above two models × `max_entries=500`. The zone deliberately does **not** use njs `evict` (which could delete the LRU index keys); instead, if the zone ever fills up, writes fail safe: the error is caught and logged, and proxying continues unaffected.
* **Scan cost**: a lookup reads and parses every live entry for the requested model. At the default of 500 entries per model this is a few MB of JSON per request — fine for a demo, but the real scaling ceiling is `max_entries`, not the zone size. Keep `max_entries` modest, or scope entries more narrowly, if you adapt this beyond a demo.

## 4. Configuration Options

The behavior of the semantic cache is entirely controlled by the `rbac.json` file. Here is an example configuration block:

```json
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
```

## Benefits
* **Cost Reduction**: Highly repetitive queries (or identically-intentioned queries) never reach the expensive upstream API.
* **Latency Reduction**: Returning an answer directly from the NGINX shared memory takes milliseconds compared to waiting for a full upstream AI text generation.
* **Resilience**: The text-based fallback guarantees that the cache logic will never break the primary chat functionality.

## Caveats

* **⚠️ The cache is shared across users.** Entries are scoped per *model*, not per user: if `user-a`'s prompt is cached, a semantically similar prompt from `user-b` on the same model is served `user-a`'s cached answer. This is acceptable for a demo but is a data-leak vector in any real deployment — do not send user-specific or confidential prompts through this proxy without adding per-user cache keying first.
* **Cache misses pay an embedding toll.** Every MISS adds one embedding round-trip before the upstream call (and none after, thanks to embedding reuse). With a local Ollama this is a few milliseconds; with a remote embedding API it is a real latency addition.
* **Semantic ≠ exact.** A HIT returns the answer to a *similar* prompt, which may not be correct for the actual prompt. Tune `similarity_threshold` conservatively (closer to 1.0) if correctness matters more than savings.
