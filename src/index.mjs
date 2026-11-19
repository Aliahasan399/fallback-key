#!/usr/bin/env node
/**
 * opencode-key-failover
 * Harness-agnostic local proxy: rotates many API keys for one provider/route,
 * retries the SAME model request with the next key on failure, and notifies
 * when a key fails or when all keys for that route fail.
 *
 * No OpenCode-specific dependency: any client that can point an OpenAI-style
 * (or Anthropic/Gemini/Azure-style) base URL at this proxy can use it.
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Readable } from "node:stream"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VERSION = "1.0.0"

// Parse --config before resolving the config path.
const ci = process.argv.indexOf("--config")
if (ci >= 0 && process.argv[ci + 1]) process.env.FAILOVER_CONFIG = process.argv[ci + 1]
const RETRYABLE_DEFAULT = [401, 402, 403, 429, 500, 502, 503, 504]
const DOWN = new Map()       // `${route}:${key}` -> cooldown expiry ms
const LAST_NOTIFY = new Map()
let rr = 0

/* ------------------------------------------------------------------ config */

function configCandidates() {
  return [
    process.env.FAILOVER_CONFIG,
    path.join(process.cwd(), "failover-proxy.json"),
    path.join(os.homedir(), ".config", "opencode", "failover-proxy.json"),
  ].filter(Boolean)
}

function resolveConfigPath() {
  for (const p of configCandidates()) if (fs.existsSync(p)) return p
  return configCandidates()[0]
}

const CONFIG_PATH = resolveConfigPath()
const CONFIG_DIR = path.dirname(CONFIG_PATH)

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8")
  const cfg = JSON.parse(raw)
  if (!cfg.routes || typeof cfg.routes !== "object") {
    throw new Error(`No "routes" object found in ${CONFIG_PATH}`)
  }
  return cfg
}

/* ------------------------------------------------------------------- utils */

function mask(key) {
  if (!key) return "<empty>"
  return key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***"
}

function logLine(cfg, text) {
  const file = cfg.logFile
    ? (path.isAbsolute(cfg.logFile) ? cfg.logFile : path.join(CONFIG_DIR, cfg.logFile))
    : path.join(CONFIG_DIR, "failover-proxy.log")
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`) } catch {}
}

function webhookNotify(cfg, title, message) {
  if (!cfg.webhook) return
  try {
    fetch(cfg.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, message, at: new Date().toISOString() }),
    }).catch(() => {})
  } catch {}
}

function desktopNotify(cfg, title, message) {
  const method = (cfg.notifyMethod || "auto").toLowerCase()
  if (method === "none") return
  try {
    if (process.platform === "win32" && method !== "mac" && method !== "linux") {
      const script = path.join(__dirname, "notify.ps1")
      spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
        "-File", script, "-Title", title, "-Message", message], { detached: true, stdio: "ignore" }).unref()
      return
    }
    if (process.platform === "darwin" && method !== "win" && method !== "linux") {
      const safe = (s) => s.replace(/["\\]/g, "\\$&")
      spawn("osascript", ["-e", `display notification "${safe(message)}" with title "${safe(title)}"`],
        { detached: true, stdio: "ignore" }).unref()
      return
    }
    if (method !== "win" && method !== "mac") {
      spawn("notify-send", [title, message], { detached: true, stdio: "ignore" }).unref()
    }
  } catch {}
}

function notify(cfg, title, message, throttleKey) {
  const now = Date.now()
  if (throttleKey && now - (LAST_NOTIFY.get(throttleKey) || 0) < 5 * 60 * 1000) return
  if (throttleKey) LAST_NOTIFY.set(throttleKey, now)
  logLine(cfg, `${title}: ${message}`)
  webhookNotify(cfg, title, message)
  if (cfg.notify === false) return
  desktopNotify(cfg, title, message)
}

/* -------------------------------------------------------------- route logic */

function resolveRoute(req, cfg) {
  const u = new URL(req.url, "http://localhost")
  const m = u.pathname.match(/^\/([^/]+)(\/.*)?$/)
  let id = null
  let rest = u.pathname + u.search

  if (m && cfg.routes[m[1]]) {
    id = m[1]
    rest = (m[2] || "/") + u.search
  }

  const headerID = req.headers["x-failover-provider"]
  if (!id && headerID && cfg.routes[headerID]) id = headerID

  if (!id && req.headers.host) {
    const host = String(req.headers.host).split(":")[0]
    const sub = host.split(".")[0]
    if (cfg.routes[sub]) id = sub
  }

  if (!id && cfg.defaultRoute && cfg.routes[cfg.defaultRoute]) id = cfg.defaultRoute

  return id ? { id, route: cfg.routes[id], rest } : null
}

function buildTarget(route, rest, key, auth) {
  const base = new URL(route.upstream)
  const prefix = String(route.pathPrefix || "").replace(/^\/+|\/+$/g, "")
  const rel = rest.replace(/^\/+/, "")
  const target = new URL("/" + [prefix, rel].filter(Boolean).join("/"), base)

  const type = String(auth?.type || "bearer").toLowerCase()
  if (type === "query") {
    target.searchParams.set(auth.name || "api_key", key)
  }
  return target
}

function authHeaders(headers, key, auth) {
  // Remove any credential the client sent so it can't leak upstream.
  for (const h of ["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key"]) {
    delete headers[h]
  }
  const type = String(auth?.type || "bearer").toLowerCase()
  if (type === "bearer") {
    headers.authorization = `Bearer ${key}`
  } else if (type === "header") {
    headers[auth.name || "x-api-key"] = `${auth.prefix || ""}${key}`
  } else if (type === "basic") {
    const user = auth.user || ""
    headers.authorization = `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`
  }
  // type "none" / "query": nothing injected in headers (query handled in buildTarget)
  return headers
}

function forwardHeaders(req, route, upstream) {
  const headers = { ...req.headers, host: upstream.host }
  for (const h of ["content-length", "expect", "connection", "keep-alive", "proxy-connection",
    "transfer-encoding", "upgrade", "te", "trailer"]) delete headers[h]
  for (const [k, v] of Object.entries(route.headers || {})) headers[k.toLowerCase()] = v
  return headers
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/__health") {
      const cfg = loadConfig()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, version: VERSION, config: CONFIG_PATH, routes: Object.keys(cfg.routes) }))
      return
    }

    const cfg = loadConfig()
    const found = resolveRoute(req, cfg)
    if (!found) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `No route matched. Use /<route>/v1/..., X-Failover-Provider header, <route>.localhost host, or set defaultRoute. Available: ${Object.keys(cfg.routes).join(", ")}` } }))
      return
    }

    const { id, route, rest } = found
    const auth = route.auth || {}
    const keys = (route.keys || []).filter(Boolean)
    if (!keys.length) {
      res.writeHead(503, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `No keys configured for route '${id}' in ${CONFIG_PATH}` } }))
      return
    }

    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    const retryOn = new Set(route.retryOn || RETRYABLE_DEFAULT)
    const start = rr++
    const tag = (k) => `${id}:${k}`
    const now = Date.now()
    const rotated = keys.map((_, i) => keys[(start + i) % keys.length])
    const usable = rotated.filter(k => !DOWN.has(tag(k)) || DOWN.get(tag(k)) <= now)
    const cooling = rotated.filter(k => DOWN.has(tag(k)) && DOWN.get(tag(k)) > now)
    const sequence = [...usable, ...cooling]

    const attempts = []

    for (const key of sequence) {
      const upstream = new URL(route.upstream)
      const target = buildTarget(route, rest, key, auth)
      const headers = authHeaders(forwardHeaders(req, route, upstream), key, auth)

      try {
        const fres = await fetch(target, {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
        })

        if (fres.status >= 200 && fres.status < 300) {
          DOWN.delete(tag(key))
          if (attempts.length) {
            const failed = attempts.map(a => a.key).join(", ")
            logLine(cfg, `[${id}] RECOVERED: ${mask(key)} worked after ${attempts.length} failed key(s): ${failed}`)
            notify(cfg, `Failover ${id} - recovered`, `${mask(key)} worked; ${failed} failed.`, `${id}:recovered`)
          }
          const outHeaders = {}
          for (const [k, v] of fres.headers) {
            if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue
            outHeaders[k] = v
          }
          if (attempts.length) {
            outHeaders["X-Failover-Route"] = id
            outHeaders["X-Failover-Used-Key"] = mask(key)
            outHeaders["X-Failover-Failed-Keys"] = attempts.map(a => a.key).join(", ")
          }
          res.writeHead(fres.status, outHeaders)
          if (fres.body) Readable.fromWeb(fres.body).pipe(res)
          else res.end()
          return
        }

        const text = await fres.text().catch(() => "")
        attempts.push({ key: mask(key), status: fres.status, body: text.slice(0, 200) })
        if (keys.length > 1) DOWN.set(tag(key), Date.now() + (cfg.quarantineMs ?? 60000))
        notify(cfg, `Failover ${id} - key failed`, `${mask(key)} returned HTTP ${fres.status}. Trying next key.`, `${id}:${key}:${fres.status}`)

        if (!retryOn.has(fres.status)) {
          res.writeHead(fres.status, { "content-type": fres.headers.get("content-type") || "application/json" })
          res.end(text)
          return
        }
      } catch (e) {
        const detail = e.cause ? String(e.cause) : String(e)
        attempts.push({ key: mask(key), error: detail })
        if (keys.length > 1) DOWN.set(tag(key), Date.now() + (cfg.quarantineMs ?? 60000))
        notify(cfg, `Failover ${id} - key failed`, `${mask(key)}: ${detail}. Trying next key.`, `${id}:${key}:net`)
      }
    }

    notify(cfg, `Failover ${id} - ALL KEYS FAILED`, `All ${keys.length} key(s) for '${id}' failed.`, `${id}:allfailed`)
    res.writeHead(503, { "content-type": "application/json" })
    res.end(JSON.stringify({
      error: {
        message: `All ${keys.length} API key(s) failed for route '${id}' (${route.upstream}).`,
        route: id,
        upstream: route.upstream,
        attempts,
      },
    }, null, 2))
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: String(e) } }))
  }
})

/* ---------------------------------------------------------------------- CLI */

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION)
  process.exit(0)
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`opencode-key-failover ${VERSION}
Usage: oc-failover [options]
  --config <path>   config file (or FAILOVER_CONFIG env)
  --help, -h        this help
  --version, -v     version
Config search order: --config, FAILOVER_CONFIG, ./failover-proxy.json,
  ~/.config/opencode/failover-proxy.json`)
  process.exit(0)
}
const cfg = loadConfig()
const [host, port] = String(cfg.listen || "0.0.0.0:8787").split(":")
server.listen(Number(port), host, () => {
  console.log(`opencode-key-failover ${VERSION} listening on http://${host}:${port}`)
  console.log(`config: ${CONFIG_PATH}`)
  console.log(`routes: ${Object.keys(cfg.routes).join(", ")}`)
})
