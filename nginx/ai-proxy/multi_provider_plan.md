# Plan: Dynamic Multi-Provider AI Proxy

Currently, adding a new AI provider (like Google Gemini, Cohere, or Mistral) requires modifying NGINX location blocks, updating upstream servers, and writing hardcoded `if/else` statements in the NJS routing logic. 

To make this completely dynamic and driven by a simple external configuration file, here is the architectural plan:

## 1. Create a `providers.json` Configuration File
We will abstract the provider connection details into a new `providers.json` file. This file will define the API URL, the required authentication header format, and the payload "schema" (how the request/response should be shaped).

```json
{
  "openai": {
    "url": "https://api.openai.com/v1/chat/completions",
    "auth_header": "Authorization",
    "auth_prefix": "Bearer ",
    "schema": "openai"
  },
  "anthropic": {
    "url": "https://api.anthropic.com/v1/messages",
    "auth_header": "x-api-key",
    "auth_prefix": "",
    "extra_headers": { "anthropic-version": "2023-06-01" },
    "schema": "anthropic"
  },
  "gemini": {
    "url": "https://generativelanguage.googleapis.com/v1beta/models",
    "auth_header": "x-goog-api-key",
    "schema": "gemini"
  }
}
```

## 2. Refactor NJS `aiproxy.js` for Dynamic Transformation
Currently, `tryModel()` uses hardcoded `if (modelConfig.provider === "anthropic")` blocks. We will refactor this to use a **Transformer Registry**:
1. We will define an object mapping `schema` types to transformer functions (e.g., `transformers["anthropic"] = { request: toAnthropic, response: fromAnthropic }`).
2. When a request comes in, NJS will look up the model's provider in `providers.json`.
3. It will retrieve the necessary `schema` transformer, dynamically map the request payload, and prepare the response parser.

## 3. Transition to `ngx.fetch()` for Dynamic Routing
**The biggest hurdle in NGINX** is that `proxy_set_header` does not allow dynamic header *names* (like switching between `Authorization`, `x-api-key`, and `x-goog-api-key` dynamically on a single route).

To solve this without needing a hardcoded `location` block for every single provider, we will utilize **NJS `ngx.fetch()`**:
- Instead of using NGINX `r.subrequest()` to proxy through hardcoded internal locations (`/openai`, `/anthropic`), the NJS script will use the built-in `ngx.fetch(url, options)`.
- This allows NJS to dynamically inject arbitrary API keys, URLs, and headers on the fly using standard JavaScript `fetch` semantics.
- We will no longer need `upstream` blocks or internal `location` blocks in `aiproxy.conf`.

## 4. Secure API Key Management
Instead of writing API keys directly into NGINX config files (`openai-key.conf`), we will load them into the environment variables and expose them to NJS using NGINX's `env` directive, or store them in a secure JSON file mapped to providers.

## Execution Steps
1. Create `config/providers.json`.
2. Refactor `aiproxy.js` to implement the Schema Transformer Registry.
3. Replace `r.subrequest` with `ngx.fetch()` in `tryModel()` to dynamically target any URL with any headers.
4. Clean up `aiproxy.conf` to remove the hardcoded internal location blocks and upstreams.
5. Add unit tests for the new `ngx.fetch` logic and the Transformer Registry.
