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

| Variable                      | Default              | Purpose                                                            |
| ----------------------------- | -------------------- | ------------------------------------------------------------------ |
| `PORT`                        | `8787`               | Listen port                                                        |
| `HOST`                        | `127.0.0.1`          | Bind address (localhost by default)                                |
| `POOL_SIZE`                   | `1`                  | Pre-minted hCaptcha tokens to keep warm                            |
| `LIGHTPANDA_PATH`             | (auto-detected)      | Path to the Lightpanda binary, overrides PATH detection            |
| `MODEL`                       | `moonshotai/kimi-k3` | Fallback model name                                                |
| `API_KEY`                     | (unset)              | Comma-separated bearer keys; empty or unset disables auth          |
| `PROXY_FILE`                  | `PROXIES.txt`        | Optional startup-loaded HTTP/SOCKS proxy list                      |
| `UPSTREAM_CONCURRENCY`        | `1`                  | Maximum simultaneous NVIDIA generations                           |
| `UPSTREAM_MIN_INTERVAL_MS`    | `15000`              | Minimum delay between NVIDIA request starts                        |
| `UPSTREAM_BACKOFF_MS`         | `120000`             | Initial cooldown after an upstream failure                         |
| `UPSTREAM_MAX_BACKOFF_MS`     | `600000`             | Maximum cooldown after repeated upstream failures                  |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | `120000`             | Maximum wait for NVIDIA to begin a response                        |
| `UPSTREAM_BODY_TIMEOUT_MS`    | `120000`             | Maximum wait for a non-streaming NVIDIA response body              |
| `UPSTREAM_STREAM_IDLE_TIMEOUT_MS` | `120000`         | Maximum idle time between NVIDIA stream frames                     |

## Optional proxy rotation

Create `PROXIES.txt` in the working directory to enable failure-driven egress rotation. The file is intentionally excluded from Git and Docker build contexts. It is read once at startup; restart the service after editing it.

```text
# One unauthenticated, globally routable IP endpoint per line
http://204.13.164.127:3128
socks4://1.2.3.4:1080
socks5://5.6.7.8:1080
```

Only `http://`, `socks4://`, and `socks5://` URLs with public IPv4 or bracketed IPv6 literals are accepted. Credentials, hostnames, private addresses, paths, queries, and fragments are rejected. Invalid entries are reported by line number and reason without logging their contents.

The service keeps a healthy proxy active and rotates only after a proxy-attributable failure. hCaptcha minting and the matching NVIDIA request share one route epoch, including one browser and token pool. Failures before NVIDIA dispatch can try another route, but timeouts or incomplete responses after dispatch are never replayed. When all external routes are cooling, the service temporarily uses direct egress and returns to a proxy after one becomes eligible.

Proxy mode requires `UPSTREAM_CONCURRENCY=1`; startup fails before Lightpanda or the API listener starts when the value is higher. The normal request-start pacing remains active across route changes. NVIDIA-wide failures still open a provider cooldown instead of burning through every proxy.

A proxy URL identifies an endpoint, not a guaranteed public exit. Use endpoints that retain one stable egress IP across connections and destinations. Public proxies can log your source IP, destination hosts, timing, and traffic volume. Target TLS verification remains enabled, but public proxies are still unsuitable for secrets or production workloads.

For Docker, mount the file read-only instead of adding it to the image:

```bash
docker run --rm \
  -v "$(pwd)/PROXIES.txt:/app/PROXIES.txt:ro" \
  -p 8787:8787 \
  ghcr.io/chakornk/nim-playground-provider
```

Use `PROXY_FILE=/path/in/container.txt` when mounting at a different path.

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
