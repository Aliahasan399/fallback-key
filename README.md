# fallback-key

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

One local proxy that gives a provider several API keys and switches to the next one when a key stops working.

## Use when

- A provider gives you more than one key and you want all of them used.
- A key gets revoked or rate limited and you do not want the session to stop.
- You want a clear message when every key for one provider fails.
- You use OpenCode, Codex CLI, an OpenAI SDK client, or any other agent that accepts a custom base URL.

## How it works

Start the proxy once and leave it running. Your agent keeps using the same model. The only change is the base URL, which now points at the proxy with the provider name in the path.

A request comes in. The proxy picks a key from that provider's list and forwards the call. A 401, a 429, a server error, or a network failure makes it try the next key on the same request. It stops when one key works or when the list runs out. If the list runs out, it answers with 503 and tells you which provider failed, how many keys it tried, and what each attempt returned. Keys are masked in that message.

The proxy has no OpenCode code in it. It forwards HTTP, so any harness that can set a base URL can use it.

## Install

```bash
git clone https://github.com/Aliahasan399/fallback-key.git
cd fallback-key
cp config.example.json failover-proxy.json
# add your real keys to failover-proxy.json (the file is gitignored)
node src/index.mjs
```

npm script or direct binary:

```bash
npm start
node src/index.mjs --config ./my-config.json
npx oc-failover --help
```

Windows: `powershell -File scripts/start.ps1`
macOS or Linux: `bash scripts/start.sh`

Health check: `curl http://127.0.0.1:8787/__health`

## Quick start

Once the proxy is running, point one provider at it. For OpenCode, edit `opencode.json`:

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

Then use the model like normal. The keys in your config rotate in the background.

## Configuration

Top level:

| Field | Default | Meaning |
|---|---|---|
| `listen` | `0.0.0.0:8787` | Address the proxy listens on |
| `notify` | `true` | Enable failure notifications |
| `notifyMethod` | `auto` | `auto`, `win`, `mac`, `linux`, `none` |
| `webhook` | `""` | Optional URL; POSTs `{title,message}` on each notification |
| `quarantineMs` | `60000` | How long a failed key is skipped. Set `0` to try all keys every time |
| `logFile` | `failover-proxy.log` | Log path, relative to the config file |
| `defaultRoute` | `""` | Route used when no path, header, or host matches |
| `routes` | required | Map of route ID to route config |

Each route takes:

| Field | Example | Meaning |
|---|---|---|
| `name` | `"My provider"` | Display name |
| `upstream` | `"https://api.example.com"` | Provider base URL, no trailing `/` |
| `pathPrefix` | `"v1beta"` | Extra path inserted between the host and the client path |
| `keys` | `["sk-a","sk-b"]` | The keys to rotate |
| `auth` | `{"type":"bearer"}` | Auth style, below |
| `headers` | `{"anthropic-version":"2023-06-01"}` | Static headers added to every request |
| `retryOn` | `[401,403,429,500]` | Statuses that trigger the next key |

Auth styles:

| `auth.type` | Injects | Extra fields |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <key>` | none |
| `header` | `<name>: <prefix><key>` | `name`, `prefix` |
| `query` | `?<name>=<key>` | `name`, for example `key` or `api_key` |
| `basic` | `Authorization: Basic base64(user:key)` | `user` |
| `none` | nothing, passed through | none |

Credential headers from the client are stripped before forwarding, so the agent's own key never reaches the provider. The client can use a dummy key such as `unused`.

## Selecting a route

Four ways work, checked in this order:

1. Path prefix. Point the base URL at `http://host:8787/<route>/v1`, so a request looks like `/hcnsec/v1/chat/completions`.
2. Request header. Send `X-Failover-Provider: <route>` when the client will not accept a path prefix.
3. Hostname. `http://<route>.localhost:8787/v1` works as a virtual host.
4. Default route. Set `defaultRoute`, then use `http://host:8787/v1` with no prefix.

The `pathPrefix` field covers providers whose base URL already contains a path. For example, `upstream: https://generativelanguage.googleapis.com` with `pathPrefix: v1beta`.

## Harness examples

For a built-in OpenCode provider, override its base URL:

```jsonc
{
  "providers": {
    "openai": { "settings": { "baseURL": "http://127.0.0.1:8787/openai/v1" } }
  }
}
```

Codex CLI, or anything that reads `OPENAI_BASE_URL`:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/myroute/v1 OPENAI_API_KEY=unused codex
```

OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/myroute/v1", api_key="unused")
```

LangChain:

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(base_url="http://127.0.0.1:8787/myroute/v1", api_key="unused")
```

Aider, Cline, and Continue take the same base URL and dummy key.

For an Anthropic-style harness, use a route with `"auth": {"type":"header","name":"x-api-key"}` and point its custom endpoint at the proxy. Add `anthropic-version` in `headers`.

## Notifications

Windows uses a PowerShell balloon tip from `src/notify.ps1`. macOS uses `osascript`, and Linux uses `notify-send`. Set `webhook` to POST every notification as JSON with `title`, `message`, and `at`, which also covers headless servers and Discord or Slack webhooks. Set `notify: false` if you only want the log.

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

## Contributing

Fork the repo, make your change on a branch, and run `npm test` before opening a pull request. Keep real keys out of commits.

## License

MIT. See [LICENSE](LICENSE).
