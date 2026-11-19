# opencode-key-failover

A small, **harness-agnostic** local proxy that gives any LLM provider **multiple API keys with automatic failover**.

Pick a model in your agent/harness → it goes to one route → the proxy tries that route's keys in rotation → on a failure it retries the **same request with the next key** → if every key for that route fails, you get a clear message and a notification.

It is a plain HTTP proxy. It does not depend on OpenCode internals; any client that can point an OpenAI-style (or Anthropic / Gemini / Azure-style) base URL at it can use it.

## Features

- Multiple keys per provider/route, round-robin, independent per route
- Automatic retry of the **same model request** on 401/402/403/429/5xx/network errors
- Clear **503 + message** when all keys for that route fail (never falls back to another provider)
- Per-key failure notifications and a persistent log (keys always masked)
- Failed keys temporarily quarantined (configurable) to avoid noise
- Auth styles: `bearer`, `header` (e.g. `x-api-key`, `api-key`), `query` (e.g. Gemini `?key=`), `basic`, `none`
- Route selection by path prefix, header, hostname, or default route
- Streaming (SSE) passthrough
- Desktop notifications on Windows / macOS / Linux, or webhook (Discord/Slack/etc.)
- No third-party runtime dependencies — Node.js 18+ only

## Install / run

```bash
git clone <your-repo-url> opencode-key-failover
cd opencode-key-failover
cp config.example.json failover-proxy.json
# edit failover-proxy.json: add your real keys (this file is gitignored)
node src/index.mjs
```

Or with npm scripts / CLI:

```bash
npm start
# or
node src/index.mjs --config ./my-config.json
npx oc-failover --help
```

Windows: `powershell -File scripts/start.ps1`
macOS/Linux: `bash scripts/start.sh`

Health check: `curl http://127.0.0.1:8787/__health`

## Configuration

Top level:

| Field | Default | Meaning |
|---|---|---|
| `listen` | `0.0.0.0:8787` | Address the proxy listens on |
| `notify` | `true` | Enable failure notifications |
| `notifyMethod` | `auto` | `auto`, `win`, `mac`, `linux`, `none` |
| `webhook` | `""` | Optional URL; POSTs `{title,message}` on each notification |
| `quarantineMs` | `60000` | How long a failed key is skipped. Set `0` to try all keys every time |
| `logFile` | `failover-proxy.log` | Log path (relative to config file) |
| `defaultRoute` | `""` | Route used when no path/header/host matches |
| `routes` | required | Map of route ID → route config |

Route fields:

| Field | Example | Meaning |
|---|---|---|
| `name` | `"My provider"` | Display name |
| `upstream` | `"https://api.example.com"` | Provider base URL (no trailing `/`) |
| `pathPrefix` | `"v1beta"` | Extra path inserted between host and client path |
| `keys` | `["sk-a","sk-b"]` | The keys to rotate |
| `auth` | `{"type":"bearer"}` | Auth style (see below) |
| `headers` | `{"anthropic-version":"2023-06-01"}` | Static headers added to every request |
| `retryOn` | `[401,403,429,500]` | Statuses that trigger the next key |

Auth types:

| `auth.type` | Injects | Extra fields |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <key>` | — |
| `header` | `<name>: <prefix><key>` | `name`, `prefix` |
| `query` | `?<name>=<key>` | `name` (e.g. `key`, `api_key`) |
| `basic` | `Authorization: Basic base64(user:key)` | `user` |
| `none` | nothing (pass-through) | — |

Incoming credential headers are always stripped before forwarding, so the harness's own key never leaks upstream. The client can use a dummy key like `unused`.

## Selecting a route

Any of these work (checked in this order):

1. **Path prefix** — point the base URL at `http://host:8787/<route>/v1` → request `/hcnsec/v1/chat/completions`.
2. **Header** — send `X-Failover-Provider: <route>` (useful if the client forbids path prefixes).
3. **Hostname** — use `http://<route>.localhost:8787/v1` (virtual host).
4. **Default route** — set `defaultRoute` and just use `http://host:8787/v1`.

`pathPrefix` on a route lets you handle providers whose base URL includes a path, e.g. `upstream: https://generativelanguage.googleapis.com` + `pathPrefix: v1beta`.

## Harness examples

**OpenCode** (`opencode.json`) — one route per custom provider:

```jsonc
{
  "provider": {
    "hcnsec": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/hcnsec/v1", "apiKey": "unused" },
      "models": { "kimi-k3": { "name": "kimi-k3" } }
    }
  }
}
```

For built-in providers, override instead: `"providers": { "openai": { "settings": { "baseURL": "http://127.0.0.1:8787/openai/v1" } } }`.

**Codex CLI / any tool using `OPENAI_BASE_URL`:**

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/myroute/v1 OPENAI_API_KEY=unused codex
```

**OpenAI SDK / LangChain / Aider / Cline / Continue:**

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/myroute/v1", api_key="unused")
```

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(base_url="http://127.0.0.1:8787/myroute/v1", api_key="unused")
```

**Anthropic-style harness** — use a route with `"auth": {"type":"header","name":"x-api-key"}` and point its custom endpoint at the proxy; add `anthropic-version` in `headers`.

## Notifications

- Windows: PowerShell balloon tip (`src/notify.ps1`)
- macOS: `osascript` notification
- Linux: `notify-send`
- Any platform: set `webhook` to receive JSON `{title, message, at}` — works for headless servers and Discord/Slack webhooks.
- Set `notify: false` to log only.

Failures always go to the log file with masked keys, e.g.:

```
[2026-01-01T00:00:00.000Z] Failover hcnsec - key failed: sk-oul...aFP9 returned HTTP 401. Trying next key.
[2026-01-01T00:00:00.000Z] [hcnsec] RECOVERED: sk-abc...xyz worked after 1 failed key(s)
```

## Security

- `failover-proxy.json` contains plaintext keys — it is gitignored. Never commit it.
- Restrict file permissions: `chmod 600 failover-proxy.json` on Unix.
- Keys are masked in logs, notifications, HTTP response headers, and error messages.
- The proxy binds `0.0.0.0` by default for LAN/container use; change to `127.0.0.1` if only local clients need it.
- Webhook URLs receive only titles/messages, never keys.

## Tests

```bash
npm test
```

Starts a local mock upstream and verifies bearer/header/query auth injection, bad-key → good-key failover, and the all-keys-failed 503 message.

## License

MIT — see [LICENSE](LICENSE).
