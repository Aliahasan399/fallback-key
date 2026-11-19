# opencode-key-failover

This is a local proxy that lets one provider use several API keys instead of one. You keep using your agent the way you always do. It picks a model, the request lands on one route, and the proxy walks through that route's keys until one works. If a key fails, it sends the same request again with the next key. When every key on that route is dead, you get a 503 response and a notification.

It is just an HTTP proxy, with no OpenCode code inside it. Anything that can point a base URL at it can use it. OpenAI-style clients work out of the box. Anthropic, Gemini, and Azure style endpoints work as well once you set the matching auth header.

## What it does

- Each route has its own key list, and the proxy rotates those keys round-robin. Routes never share keys.
- A failed key triggers a retry of the same request. That happens on 401, 402, 403, 429, 5xx, or a network error.
- If all keys on the route fail, the response is 503 with a message naming the route and its upstream. The proxy never borrows a key from another provider.
- Every failed key gets logged and fires a notification. Keys in those messages are masked.
- A key that just failed is skipped for a while, controlled by `quarantineMs`. Set that to 0 if you want every key tried on every request.
- Auth styles are `bearer`, `header` (for example `x-api-key` or `api-key`), `query` (Gemini's `?key=`), `basic`, and `none`.
- A route can be chosen by path prefix, request header, hostname, or a default route.
- Streaming responses pass through unchanged.
- Notifications show as a balloon on Windows, use `osascript` on macOS, and use `notify-send` on Linux. A webhook works on any of them.
- No runtime dependencies. Node.js 18 or newer is enough.

## Install and run

```bash
git clone <your-repo-url> opencode-key-failover
cd opencode-key-failover
cp config.example.json failover-proxy.json
# edit failover-proxy.json: add your real keys (this file is gitignored)
node src/index.mjs
```

You can also use the npm script or call the binary directly:

```bash
npm start
# or
node src/index.mjs --config ./my-config.json
npx oc-failover --help
```

On Windows, run `powershell -File scripts/start.ps1`. On macOS or Linux, run `bash scripts/start.sh`.

To check that it is alive, call `curl http://127.0.0.1:8787/__health`.

## Configuration

Top level settings:

| Field | Default | Meaning |
|---|---|---|
| `listen` | `0.0.0.0:8787` | Address the proxy listens on |
| `notify` | `true` | Enable failure notifications |
| `notifyMethod` | `auto` | `auto`, `win`, `mac`, `linux`, `none` |
| `webhook` | `""` | Optional URL; POSTs `{title,message}` on each notification |
| `quarantineMs` | `60000` | How long a failed key is skipped. Set `0` to try all keys every time |
| `logFile` | `failover-proxy.log` | Log path (relative to config file) |
| `defaultRoute` | `""` | Route used when no path, header, or host matches |
| `routes` | required | Map of route ID to route config |

Each route takes these fields:

| Field | Example | Meaning |
|---|---|---|
| `name` | `"My provider"` | Display name |
| `upstream` | `"https://api.example.com"` | Provider base URL (no trailing `/`) |
| `pathPrefix` | `"v1beta"` | Extra path inserted between the host and the client path |
| `keys` | `["sk-a","sk-b"]` | The keys to rotate |
| `auth` | `{"type":"bearer"}` | Auth style, described below |
| `headers` | `{"anthropic-version":"2023-06-01"}` | Static headers added to every request |
| `retryOn` | `[401,403,429,500]` | Statuses that trigger the next key |

Auth styles:

| `auth.type` | Injects | Extra fields |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <key>` | (none) |
| `header` | `<name>: <prefix><key>` | `name`, `prefix` |
| `query` | `?<name>=<key>` | `name`, for example `key` or `api_key` |
| `basic` | `Authorization: Basic base64(user:key)` | `user` |
| `none` | nothing, passed through | (none) |

Credential headers from the client are stripped before forwarding, so the agent's own key never reaches the provider. The client can use a dummy key such as `unused`.

## Selecting a route

Four ways work, and the proxy checks them in this order:

1. Path prefix. Point the base URL at `http://host:8787/<route>/v1`, so a request looks like `/hcnsec/v1/chat/completions`.
2. Request header. Send `X-Failover-Provider: <route>` when the client will not accept a path prefix.
3. Hostname. `http://<route>.localhost:8787/v1` works as a virtual host.
4. Default route. Set `defaultRoute`, then use `http://host:8787/v1` with no prefix.

The `pathPrefix` field on a route covers providers whose base URL already contains a path. For example, `upstream: https://generativelanguage.googleapis.com` with `pathPrefix: v1beta`.

## Harness examples

For OpenCode, add one route per custom provider in `opencode.json`:

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

For a built-in provider, override its base URL instead: `"providers": { "openai": { "settings": { "baseURL": "http://127.0.0.1:8787/openai/v1" } } }`.

Codex CLI, or any tool that reads `OPENAI_BASE_URL`, only needs two variables:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/myroute/v1 OPENAI_API_KEY=unused codex
```

With the OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/myroute/v1", api_key="unused")
```

LangChain uses the same shape:

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(base_url="http://127.0.0.1:8787/myroute/v1", api_key="unused")
```

Aider, Cline, and Continue take that same base URL and dummy key.

For an Anthropic-style harness, use a route with `"auth": {"type":"header","name":"x-api-key"}` and point its custom endpoint at the proxy. Add `anthropic-version` in `headers`.

## Notifications

Windows uses a PowerShell balloon tip from `src/notify.ps1`. macOS uses `osascript`, and Linux uses `notify-send`. If you set `webhook`, every notification is POSTed as JSON with `title`, `message`, and `at`, which also covers headless servers and Discord or Slack webhooks. Set `notify: false` if you only want the log.

Failures always land in the log file, with keys masked:

```
[2026-01-01T00:00:00.000Z] Failover hcnsec - key failed: sk-oul...aFP9 returned HTTP 401. Trying next key.
[2026-01-01T00:00:00.000Z] [hcnsec] RECOVERED: sk-abc...xyz worked after 1 failed key(s)
```

## Security

`failover-proxy.json` holds your keys in plain text, and it is gitignored. Do not commit it. On Unix, `chmod 600 failover-proxy.json` is worth doing.

Keys are masked in logs, notifications, response headers, and error messages.

The proxy binds `0.0.0.0` by default so containers and other machines can reach it. Change that to `127.0.0.1` if only local clients need it. Webhooks receive the title and message only, never a key.

## Tests

`npm test` starts a local mock upstream. It checks bearer, header, and query auth injection, a bad key falling through to a good one, and the 503 response when all keys fail.

## License

MIT. See [LICENSE](LICENSE).
