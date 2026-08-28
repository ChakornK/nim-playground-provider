# NVIDIA NIM Playground Provider

Get unlimited free access near-frontier models like GLM-5.2 and Minimax-M3 via NVIDIA's AI chat models for anything that uses the OpenAI API.

## Quick start with Docker

The easiest way to run the proxy is with [Docker](https://www.docker.com/).

```bash
docker run -p 8787:8787 ghcr.io/chakornk/nim-playground-provider
```

To secure the proxy, add an authorization key with `-e API_KEY=secret1`:

```bash
docker run -e API_KEY=secret1 -p 8787:8787 ghcr.io/chakornk/nim-playground-provider
```

## Use it in a chat app or agent harness

Use these settings for your favorite chat UIs and agent harnesses that accept a custom OpenAI provider:

- **Base URL:** `http://localhost:8787/v1`
- **API key:** any non-empty string, or your `API_KEY` value when you set one
- **Model:** any id from `GET /v1/models`

See the model list:

```bash
curl http://localhost:8787/v1/models
```

## Run without Docker

You need Node.js 22 or newer, and [Lightpanda](https://github.com/lightpanda-io/browser) on your `PATH` (or set `LIGHTPANDA_PATH`). Then:

```bash
git clone https://github.com/ChakornK/nim-playground-provider.git
cd nim-playground-provider
npm install
npm start
```

Add a key with `API_KEY=secret1 npm start` or by creating a `.env` file.

## Configuration

All settings use environment variables. None are required.

| Variable          | Default                | Purpose                                                   |
| ----------------- | ---------------------- | --------------------------------------------------------- |
| `PORT`            | `8787`                 | Listen port                                               |
| `HOST`            | `127.0.0.1`            | Bind address (localhost by default)                       |
| `POOL_SIZE`       | `2`                    | Pre-minted hCaptcha tokens to keep warm                   |
| `LIGHTPANDA_PATH` | (auto-detected)        | Path to the Lightpanda binary, overrides PATH detection   |
| `MODEL`           | `moonshotai/kimi-k3` | Fallback model name                                       |
| `API_KEY`         | (unset)                | Comma-separated bearer keys; empty or unset disables auth |

## Authentication

By default the proxy requires no key. Set `API_KEY` to one or more comma-separated secrets to require a bearer token on every request.

```bash
API_KEY=secret1,secret2 npm start
curl -H "Authorization: Bearer secret1" http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## API

### `POST /v1/chat/completions`

Accepts standard OpenAI chat fields: `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `tools`. `enable_thinking` (default `true`) toggles reasoning mode. The proxy doesn't support `reasoning.effort`.

### `GET /v1/models`

Returns the list of available models.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
