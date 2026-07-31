# IDEA: Semantic Cache for NGINX AI Proxy

## Problem

Every `/v1/chat/completions` request hits the upstream LLM (OpenAI or Anthropic), consuming API credits and adding latency even for semantically identical or near-identical prompts. Users asking "How do I reset my password?" and "I forgot my password, help" produce the same useful answer — but pay twice.

## Concept

Add a **semantic caching layer** in the NJS proxy that intercepts requests **before** they reach the upstream LLM. Instead of exact-match caching (which would almost never hit on free-form text), use **embedding similarity** to find cached responses to semantically equivalent prompts.

```
Request → RBAC validation → [CACHE LOOKUP] → hit? → return cached response
                                          → miss? → upstream LLM → store in cache → return
```

## How it works

1. **Extract the user prompt** from the chat messages array (concatenate all `role: "user"` content fields)
2. **Compute an embedding** of the prompt via Ollama running locally (free, no API key needed, model: `nomic-embed-text`)
3. **Search the cache** for an entry with cosine similarity above threshold (e.g. 0.95)
4. **On hit** — return the cached LLM response immediately, skipping the upstream API call
5. **On miss** — proceed normally to OpenAI/Anthropic, then store the response + embedding

## Resilience

If Ollama (the embedding API) is down, the system **does not break**. It falls back to **normalized text matching** — lowercase, strip punctuation, 3-gram Jaccard similarity — a simpler but still useful heuristic.

## Cache store

A single **NGINX shared dictionary** (`js_shared_dict_zone`) — in-process, zero network hops, zero external dependencies. LRU eviction + per-entry TTL. Redis (L2) is designed but deferred to keep the demo self-contained.

## Impact

| Without cache | With cache |
|---|---|
| Every request costs API credits | Cache hits cost nothing |
| Every request takes 1-3 seconds | Cache hits return in ~10ms |
| Identical work repeated | Semantic deduplication |

## Scope

This is a **demo enhancement**, not production infrastructure. It demonstrates the concept of AI-aware caching at the proxy layer. Redis support, cache statistics endpoints, user-scoped caches, and streaming support are explicitly out of scope for this cycle.
