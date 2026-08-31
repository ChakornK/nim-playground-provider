# NVIDIA NIM Playground Provider

Get unlimited free access to frontier open models like Kimi K3 and Deepseek V4 Pro 0813 via NVIDIA's AI chat, through anything that uses the OpenAI API.

## Quick start with Docker

The easiest way to run the proxy is with [Docker](https://www.docker.com/).

```bash
docker run -p 8787:8787 ghcr.io/chakornk/nim-playground-provider
```

To secure the proxy, add an authorization key with `-e API_KEY=secret1`:

```bash
docker run -e API_KEY=secret1 -p 8787:8787 ghcr.io/chakornk/nim-playground-provider
```

The container listens on all interfaces and warns at startup when no `API_KEY` is set. Anyone who can reach the port can use the proxy, so set a key when you expose it beyond your own machine.

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

You need [Bun](https://bun.sh) 1.4 or newer, and [Lightpanda](https://github.com/lightpanda-io/browser) on your `PATH` (or set `LIGHTPANDA_PATH`). Then:

```bash
git clone https://github.com/ChakornK/nim-playground-provider.git
cd nim-playground-provider
bun install
bun start
```

Add a key with `API_KEY=secret1 bun start` or by creating a `.env` file.

## Configuration

All settings use environment variables. None are required.

| Variable          | Default              | Purpose                                                   |
| ----------------- | -------------------- | --------------------------------------------------------- |
| `PORT`            | `8787`               | Listen port                                               |
| `HOST`            | `127.0.0.1`          | Bind address (localhost by default)                       |
| `POOL_SIZE`       | `2`                  | Pre-minted hCaptcha tokens to keep warm                   |
| `LIGHTPANDA_PATH` | (auto-detected)      | Path to the Lightpanda binary, overrides PATH detection   |
| `MODEL`           | `moonshotai/kimi-k3` | Fallback model name                                       |
| `API_KEY`         | (unset)              | Comma-separated bearer keys; empty or unset disables auth |

## Authentication

By default the proxy requires no key. Set `API_KEY` to one or more comma-separated secrets to require a bearer token on every request.

```bash
API_KEY=secret1,secret2 bun start
curl -H "Authorization: Bearer secret1" http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## API

### `POST /v1/chat/completions`

Accepts standard OpenAI chat fields: `model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `tools`. `enable_thinking` (default `true`) toggles reasoning mode. The proxy doesn't support `reasoning.effort`.

Request a model outside the `GET /v1/models` list and you get a 404. The default model (the `MODEL` variable) keeps working even when the model list fails to load.

Each model accepts a different subset of sampling params, read from its published spec. If you send a param the model rejects (e.g. `top_p` to Kimi K3), the proxy drops it and logs a warning once per model instead of failing the request.

### `GET /v1/models`

Returns the list of available models.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
