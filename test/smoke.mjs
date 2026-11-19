// Smoke test: mock upstream + proxy, validates auth injection and failover.
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(__dirname)
const UPSTREAM_PORT = 18787
const PROXY_PORT = 18788
const CONFIG = path.join(os.tmpdir(), "oc-failover-test-config.json")

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let failures = 0
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`)
  if (!ok) failures++
}

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost")
  const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    || req.headers["x-api-key"] || u.searchParams.get("api_key") || u.searchParams.get("key") || ""
  if (key.includes("BAD")) {
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "bad key" }))
    return
  }
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({
    path: u.pathname,
    authorization: req.headers.authorization || null,
    xApiKey: req.headers["x-api-key"] || null,
    query: u.search,
  }))
})

const cfg = {
  listen: `127.0.0.1:${PROXY_PORT}`,
  notify: false,
  quarantineMs: 60000,
  logFile: path.join(os.tmpdir(), "oc-failover-test.log"),
  routes: {
    bearer: { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, keys: ["BAD-bearer", "GOOD-bearer"], auth: { type: "bearer" } },
    header: { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, keys: ["BAD-header", "GOOD-header"], auth: { type: "header", name: "x-api-key", prefix: "" } },
    query: { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, keys: ["BAD-query", "GOOD-query"], auth: { type: "query", name: "api_key" } },
    allbad: { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, keys: ["BAD-1"], auth: { type: "bearer" } },
  },
}
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2))

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/__health`)
      if (r.ok) return true
    } catch {}
    await sleep(150)
  }
  return false
}

const proxy = spawn(process.execPath, [path.join(ROOT, "src", "index.mjs"), "--config", CONFIG], { cwd: ROOT, stdio: "ignore" })

try {
  await new Promise(r => mock.listen(UPSTREAM_PORT, "127.0.0.1", r))
  if (!await waitHealth()) throw new Error("proxy did not become healthy")

  const base = `http://127.0.0.1:${PROXY_PORT}`

  const r1 = await fetch(`${base}/bearer/v1/echo`)
  const b1 = await r1.json()
  check("bearer: bad key -> good key returns 200", r1.status === 200, `status=${r1.status}`)
  check("bearer: good key injected", b1.authorization === "Bearer GOOD-bearer", String(b1.authorization))
  check("bearer: failover headers present", !!r1.headers.get("x-failover-used-key"))

  const r2 = await fetch(`${base}/header/v1/echo`)
  const b2 = await r2.json()
  check("header: x-api-key injected from pool", b2.xApiKey === "GOOD-header", String(b2.xApiKey))

  const r3 = await fetch(`${base}/query/v1/echo`)
  const b3 = await r3.json()
  check("query: api_key injected", b3.query.includes("api_key=GOOD-query"), b3.query)

  const r4 = await fetch(`${base}/v1/echo`, { headers: { "x-failover-provider": "bearer" } })
  check("route selection via header works", r4.status === 200, `status=${r4.status}`)

  const r5 = await fetch(`${base}/allbad/v1/echo`)
  const b5 = await r5.json()
  check("all keys failed -> 503 with message", r5.status === 503 && /All 1 API key/.test(b5.error?.message || ""), `status=${r5.status}`)

  const r6 = await fetch(`${base}/unknown/v1/echo`)
  check("unknown route -> 400", r6.status === 400, `status=${r6.status}`)
} catch (e) {
  failures++
  console.error("ERROR", e)
} finally {
  proxy.kill("SIGTERM")
  mock.close()
  try { fs.unlinkSync(CONFIG) } catch {}
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)
