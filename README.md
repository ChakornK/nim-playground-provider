# NVIDIA NIM Playground Provider

A proxy that turns NVIDIA's free inference playground into an OpenAI-compatible API. Point any OpenAI client at it and use models without an API key or NVIDIA account.

## Requirements

[Lightpanda](https://github.com/lightpanda-io/browser) must be installed. The proxy finds it on your `PATH`, or you can point to it with `LIGHTPANDA_PATH`.

## Quick start

```bash
npm install
npm start
```

The server listens on `http://localhost:8787`.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Configuration

All settings use environment variables. None are required.

| Variable          | Default         | Purpose                                                 |
| ----------------- | --------------- | ------------------------------------------------------- |
| `PORT`            | `8787`          | Listen port                                             |
| `HOST`            | `127.0.0.1`     | Bind address (localhost by default)                     |
| `POOL_SIZE`       | `2`             | Pre-minted hCaptcha tokens to keep warm                 |
| `LIGHTPANDA_PATH` | (auto-detected) | Path to the Lightpanda binary, overrides PATH detection |
| `MODEL`           | `z-ai/glm-5.2`  | Fallback model name                                     |

## API

### `POST /v1/chat/completions`

Accepts standard OpenAI chat fields: `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `tools`. Also accepts `enable_thinking` (defaults to `true`) to toggle the model's reasoning mode.

Returns streaming or non-streaming completions in OpenAI format. `model` is routed to the matching NVIDIA deployment; an unknown model returns `404 model_not_found`.

### `GET /v1/models`

Returns the model list. On startup the proxy builds a catalog from NVIDIA's public model list plus each model's queue function ID, and serves every text-capable model (LLMs and multimodal vision-language models; embeddings, speech, image/video generation and other non-text models are excluded). If the catalog cannot be fetched, the proxy falls back to the single `MODEL` above.

## How it works

NVIDIA's free endpoint gates access behind a single-use hCaptcha token. This proxy spawns a [Lightpanda](https://github.com/lightpanda-io/browser) headless browser and drives it over CDP via Playwright to mint hCaptcha tokens on `build.nvidia.com`, keeping a warm pool. Each request pulls a token from the pool, calls the NVIDIA API, and translates the response into OpenAI format.

## Docker

```bash
docker build -t nim-playground-provider .
docker run -p 8787:8787 nim-playground-provider
```

The container bundles Lightpanda and uses the same environment variables as local execution.

## Tests

```bash
npm test                    # unit + offline integration
NVIDIA_LIVE=1 npm test      # live smoke tests
```
