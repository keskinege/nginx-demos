# NGINX AI Proxy

## Demo Overview

Simple demo showcasing how to use NGINX and NGINX JavaScript (NJS) to act as a simple AI proxy. This demo covers how to use NGINX to provide the following AI proxy capabilities:

- User-based AI model access control.
- AI model abstraction (OpenAI ↔ Anthropic) with request/response translation.
- Per-model failover.
- AI model token usage extraction into access logs.
- Semantic caching of responses (embedding similarity with a text-similarity fallback) — see [`semantic_caching.md`](semantic_caching.md).

This demo has the following limitations:

- The JSON config is statically loaded (no dynamic reload logic here).
- Only a subset of OpenAI → Anthropic fields are properly translated (enough for basic prompts).
- No handling of AI streaming (streaming requests bypass the cache entirely).
- Authentication is done via header-based API key (`x-api-key`) mapped to users.
- Failover only triggers on non-200 HTTP status.
- No rate limiting.
- The semantic cache is in-memory only (NGINX shared dictionary), scoped per **model** — not per user: cached responses are shared across all users with access to the same model. Do not send user-specific/confidential prompts through this demo (see the warning in [`semantic_caching.md`](semantic_caching.md)).

## Demo Walkthrough

### Prerequisites

Before you can run this demo, you will need:

- An OpenAI API key exported as an environment variable:

    ```bash
    export OPENAI_API_KEY=<API_KEY>
    ```

- An Anthropic API key exported as an environment variable:

    ```bash
    export ANTHROPIC_API_KEY=<API_KEY>
    ```

- A functional Docker installation.

- (Optional, for semantic caching) Ollama with the `nomic-embed-text` model. Either run it on your host (`ollama pull nomic-embed-text`) or use the Docker Compose flow below, which runs and pulls it automatically. If Ollama is unreachable, the cache degrades gracefully to a text-similarity fallback.

### Launching the Container Demo Environment on Docker

1. Clone this repo and change directory to the AI proxy directory inside the cloned repo:

    ```bash
    git clone https://github.com/nginx/nginx-demos
    cd nginx-demos/nginx/ai-proxy
    ```

2. Create a persistent volume for generated key snippets:

    ```bash
    docker volume create nginx-keys
    ```

3. Launch the Docker NGINX container with all the necessary configuration settings:

    ```bash
    docker run -it --rm -p 4242:4242 \
      -v $(pwd)/config:/etc/nginx \
      -v $(pwd)/njs:/etc/njs \
      -v $(pwd)/templates:/etc/nginx-ai-proxy/templates \
      -v nginx-keys:/etc/nginx-ai-proxy/keys \
      -e NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx-ai-proxy/templates \
      -e NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx-ai-proxy/keys \
      -e OLLAMA_HOST=host.docker.internal \
      -e OPENAI_API_KEY \
      -e ANTHROPIC_API_KEY \
      --name nginx-ai-proxy \
      nginx:1.29.1
    ```

The official NGINX image entrypoint runs `envsubst` on templates and creates an `openai-key.conf` and `anthropic-key.conf` NGINX config files under `/etc/nginx-ai-proxy/keys/` which are then `included` by the `aiproxy.conf` NGINX config file.

### Alternative: Docker Compose (includes Ollama)

Instead of the manual `docker run` steps above, you can use Docker Compose, which also starts an Ollama container and pulls the `nomic-embed-text` embedding model for the semantic cache:

```bash
docker compose up -d
```

Compose inherits `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from your shell environment. The first start downloads the embedding model (~274 MB), so NGINX may take a few minutes to come up (it waits until the model is available).

### Testing Basic Requests

1. Try sending a request as `user-a` to the OpenAI model:

    ```bash
    curl -s -X POST http://localhost:4242/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H 'x-api-key: sk-demo-key-user-a' \
      -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'
    ```

    Expected response:

    ```json
    {
      "id": "...",
      "object": "chat.completion",
      "created": ...,
      "model": "gpt-5-2025-08-07",
      "choices": [
        {
          "index": 0,
          "message": {
            "role": "assistant",
            "content": "Hello! How can I help you today?",
            "refusal": null,
            "annotations": []
          },
          "finish_reason": "stop"
        }
      ],
      "usage": {
        "prompt_tokens": 7,
        "completion_tokens": 82,
        "total_tokens": 89,
        "prompt_tokens_details": {
          "cached_tokens": 0,
          "audio_tokens": 0
        },
        "completion_tokens_details": {
          "reasoning_tokens": 64,
          "audio_tokens": 0,
          "accepted_prediction_tokens": 0,
          "rejected_prediction_tokens": 0
        }
      },
      "service_tier": "default",
      "system_fingerprint": null
    }
    ```

2. Send a different request as `user-a` to the Anthropic model (still using the OpenAI schema as the AI model translation happens server-side in the NJS code):

    ```bash
    curl -s -X POST http://localhost:4242/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H 'x-api-key: sk-demo-key-user-a' \
      -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'
    ```

    Expected response:

    ```json
    {
      "id": "...",
      "object": "chat.completion",
      "model": "claude-sonnet-4-6",
      "choices": [
        {
          "index": 0,
          "finish_reason": "end_turn",
          "message": {
            "role": "assistant",
            "content": "Hello! How are you doing today? Is there anything I can help you with?"
          }
        }
      ],
      "usage": {
        "prompt_tokens": 8,
        "completion_tokens": 20,
        "total_tokens": 28
      }
    }
    ```

3. Send a request as `user-b`. This user does not have access to Anthropic:

    ```bash
    curl -s -X POST http://localhost:4242/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H 'x-api-key: sk-demo-key-user-b' \
      -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'
    ```

    Expected response:

    ```json
    {
      "error": {
        "message": "The model 'claude-sonnet-4-6' was not found or is not accessible to the user"
      }
    }
    ```

### Testing the Failover Mechanism

1. Stop the previous running NGINX AI proxy Docker container. It should automatically get deleted from your container cache:

    ```bash
    docker stop nginx-ai-proxy
    ```

2. Start a new Docker container with an invalid OpenAI key to force failure:

    ```bash
    docker run -it --rm -p 4242:4242 \
      -v $(pwd)/config:/etc/nginx \
      -v $(pwd)/njs:/etc/njs \
      -v $(pwd)/templates:/etc/nginx-ai-proxy/templates \
      -v nginx-keys:/etc/nginx-ai-proxy/keys \
      -e NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx-ai-proxy/templates \
      -e NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx-ai-proxy/keys \
      -e OLLAMA_HOST=host.docker.internal \
      -e OPENAI_API_KEY=bad \
      -e ANTHROPIC_API_KEY \
      --name nginx-ai-proxy \
      nginx:1.29.1
    ```

3. Send a request as `user-a` to the OpenAI model. `user-a` has configured Anthropic as a failover model:

    ```bash
    curl -s -X POST http://localhost:4242/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H 'x-api-key: sk-demo-key-user-a' \
      -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'
    ```

    Expected response:

    ```json
    {
      "id": "...",
      "object": "chat.completion",
      "model": "claude-sonnet-4-6",
      "choices": [
        {
          "index": 0,
          "finish_reason": "end_turn",
          "message": {
            "role": "assistant",
            "content": "Hello! How are you doing today? Is there anything I can help you with?"
          }
        }
      ],
      "usage": {
        "prompt_tokens": 8,
        "completion_tokens": 20,
        "total_tokens": 28
      }
    }
    ```

4. Send a request as `user-b` to the OpenAI model. `user-b` has no failover models available:

    ```bash
    curl -s -X POST http://localhost:4242/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H 'x-api-key: sk-demo-key-user-b' \
      -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'
    ```

    Expected response:

    ```json
    {
      "error": {
        "message": "Incorrect API key provided: bad. You can find your API key at https://platform.openai.com/account/api-keys.",
        "type": "invalid_request_error",
        "param": null,
        "code": "invalid_api_key"
      }
    }
    ```

Output should show `"claude-sonnet-4-6"` model indicating fallback.

## Cleanup

1. Stop the running NGINX AI proxy Docker container. It should automatically get deleted from your container cache:

    ```bash
    docker stop nginx-ai-proxy
    ```

2. Cleanup the Docker key volume we created in one of the first steps:

    ```bash
    docker volume rm nginx-keys
    ```

## Demo Structure

### Files

| Path | Purpose |
|------|---------|
| [`config/nginx.conf`](config/nginx.conf) | Includes the default `nginx.conf` file with a few modifications. Major differences are loading the NJS module, tweaking the log format to include token vars and "including" the AI proxy NGINX config (`aiproxy.conf`) |
| [`config/aiproxy.conf`](config/aiproxy.conf) | Includes upstream blocks for OpenAI/Anthropic with dynamic DNS resolution, sets up a server listening on port 4242, loads a JSON config into the `$ai_proxy_config` variable using NJS, exposes a `/v1/chat/completions` location entrypoint, sets up internal locations for the `/openai` and `/anthropic` models plus the `/ollama-embedding` and `/openai-embedding` embedding endpoints, and declares the `ai_cache` shared dictionary zone |
| [`config/rbac.json`](config/rbac.json) | Includes the RBAC data in a JSON data format -- See section below for more information. Also holds the `semantic_cache` configuration block |
| [`config/api_keys.conf`](config/api_keys.conf) | NGINX `map` translating `x-api-key` header values to RBAC user identities |
| [`njs/aiproxy.js`](njs/aiproxy.js) | NJS script including JSON RBAC parsing and AI proxy routing logic (authorization, model lookup, model failover, provider-specific transforms, cache integration, and token extraction) |
| [`njs/cache.js`](njs/cache.js) | Semantic cache: LRU+TTL store in the NGINX shared dictionary, cosine-similarity matching with a Jaccard text fallback |
| [`njs/embeddings.js`](njs/embeddings.js) | Embedding API client (Ollama and OpenAI providers) used by the semantic cache |
| [`templates/*.template`](templates/) | `envsubst` templates to inject API keys into included snippets |
| [`docker-compose.yml`](docker-compose.yml) | Compose stack: NGINX proxy + Ollama (with automatic `nomic-embed-text` pull) |
| [`test.sh`](test.sh) / [`tests/`](tests/) | Unit (njs), integration, and live e2e test suites |

### RBAC JSON Configuration Model

The [JSON RBAC model](config/rbac.json) looks like this:

```json
{
  "users": {
    "user-a": {
      "models": [
        {"name": "gpt-5", "failover": "claude-sonnet-4-6"},
        {"name": "claude-sonnet-4-6"}
      ]
    },
    "user-b": {
      "models": [{"name": "gpt-5"}]
    }
  },
  "models": {
    "gpt-5": {"provider": "openai", "location": "/openai"},
    "claude-sonnet-4-6": {"provider": "anthropic", "location": "/anthropic"}
  }
}
```

Each user contains a list of allowed models (and an optional `failover` model). The model section maps logical model names to a provider name and the internal location used by NGINX.

### NGINX Request Processing Flow

1. A client POSTs an OpenAI chat completion request containing the appropriate JSON data to `/v1/chat/completions`. The header `x-api-key` details which user this client corresponds to.
2. The `aiproxy.js` NJS script validates the user and model access.
3. The semantic cache is consulted: the prompt embedding is compared against cached entries for the requested model. On a HIT, the cached response is returned immediately and no upstream call is made.
4. On a cache MISS, NGINX proxies the request to the appropriate model via an internal location block (`/openai` or `/anthropic`).
5. If the provider is Anthropic, the request is transformed by the NJS script to an Anthropic API compatible request. The response is then transformed back to an OpenAI compatible response.
6. If the primary model returns a non-200 status code and a `failover` model is defined, a second attempt is made to the `failover` model.
7. Once a successful request is completed, the response is stored in the semantic cache and token counts are extracted from the response and logged within the NGINX access log.

### Token Usage Logging in NGINX

Token usage data is saved into NGINX variables using NJS. These variables, `$ai_proxy_response_prompt_tokens`, `$ai_proxy_response_completion_tokens`, and `$ai_proxy_response_total_tokens`, are then included into the access log format in the core NGINX config file (`nginx.conf`). Failed requests produce empty values. The resulting access log could look something along these lines:

```console
... 401 ... prompt_tokens= completion_tokens= total_tokens=
... 200 ... prompt_tokens=13 completion_tokens=39 total_tokens=52
```
