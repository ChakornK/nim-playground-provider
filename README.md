# NVIDIA NIM Playground Provider

A proxy that turns NVIDIA's free inference playground into an OpenAI-compatible API. Point any OpenAI client at it and use models without an API key or NVIDIA account.

## Quick start

```bash
bun install
bunx playwright install chromium
bun start
```

The server listens on `http://localhost:8787`.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Configuration

All settings use environment variables. None are required.

| Variable             | Default                                | Purpose                                 |
| -------------------- | -------------------------------------- | --------------------------------------- |
| `PORT`               | `8787`                                 | Listen port                             |
| `POOL_SIZE`          | `2`                                    | Pre-minted hCaptcha tokens to keep warm |
| `CHROMIUM_PATH`      | (Playwright bundled)                   | Path to Chromium binary                 |
| `NVIDIA_MODEL_ID`    | `qc69jvmznzxy/glm-5.2`                 | NVIDIA deployment path segment          |
| `NVIDIA_FUNCTION_ID` | `3b9748d8-1d85-40e8-8573-0eeaa63a4b63` | NVIDIA queue function ID                |
| `MODEL`              | `z-ai/glm-5.2`                         | Model name advertised to clients        |

## API

### `POST /v1/chat/completions`

Accepts standard OpenAI chat fields: `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `tools`. Also accepts `enable_thinking` (defaults to `true`) to toggle the model's reasoning mode.

Returns streaming or non-streaming completions in OpenAI format.

### `GET /v1/models`

Returns the model list.

## How it works

NVIDIA's free endpoint gates access behind a single-use hCaptcha token. This proxy runs a headless Chromium browser that mints tokens on `build.nvidia.com` and keeps a warm pool. Each request pulls a token from the pool, calls the NVIDIA API, and translates the response into OpenAI format.

## Tests

```bash
bun test                    # unit + offline integration
NVIDIA_LIVE=1 bun test      # live smoke tests
```
