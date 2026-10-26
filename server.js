import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Locate the Devin CLI binary. Order:
//   1. DEVIN_BIN env override (absolute path or bare command name)
//   2. Windows: the CLI bundled inside Devin Desktop, resolved via
//      %LOCALAPPDATA% so it works under any user profile
//   3. `devin` on PATH (standalone install; the macOS/Linux default)
// Resolution runs once at startup so a missing CLI fails fast with a clear
// message instead of surfacing as `spawn … ENOENT` on the first request.
function findOnPath(exe) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, exe + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

function resolveDevinBin() {
  const override = process.env.DEVIN_BIN?.trim();
  if (override) {
    // Explicit path: must exist. Bare name: resolve against PATH.
    if (/[/\\]/.test(override)) return fs.existsSync(override) ? override : null;
    return findOnPath(override);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    const bundled = path.join(
      localAppData, "Programs", "Devin", "resources", "app",
      "extensions", "windsurf", "devin", "bin", "devin.exe",
    );
    if (fs.existsSync(bundled)) return bundled;
  }
  return findOnPath("devin");
}

const DEVIN_BIN = resolveDevinBin();
if (!DEVIN_BIN) {
  console.error(
    "[devin-shim] FATAL: Devin CLI not found. Install Devin Desktop or the " +
      "standalone CLI, run `devin auth login`, or set DEVIN_BIN in .env to the binary path.",
  );
  process.exit(1);
}
// Windows cannot spawn .cmd/.bat shims without a shell — only applies if PATH
// resolution landed on a wrapper rather than devin.exe itself.
const DEVIN_NEEDS_SHELL =
  process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(DEVIN_BIN).toLowerCase());
console.log(`[devin-shim] Devin CLI: ${DEVIN_BIN}${DEVIN_NEEDS_SHELL ? " (via shell)" : ""}`);
const DEVIN_MODEL = process.env.DEVIN_MODEL ?? "swe-2-high";
// SHIM_CONFIG selects the permission profile passed via --config:
//   safe     — local machine read-only; MCP tools allowed (default)
//   readonly — additionally denies mcp__* (no remote actions at all)
const SHIM_CONFIG = process.env.SHIM_CONFIG ?? "safe";
const READONLY_CONFIG = path.join(__dirname, `devin-${SHIM_CONFIG === "readonly" ? "readonly" : "safe"}.json`);
const TRANSPORT = process.env.TRANSPORT ?? "acp"; // "acp" | "print"
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
// SHIM_API_KEY accepts one or more keys, comma-separated; each entry may be
// "name:key" (name becomes the access-log identity) or a bare "key" (identity
// = first 6 chars). Alternatively, one key per env line via
// SHIM_API_KEY_<NAME>=<secret>. Both forms combine. Keys are never logged.
const API_KEYS = new Map(); // secret -> label
for (const e of (process.env.SHIM_API_KEY ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const i = e.indexOf(":");
  if (i > 0) API_KEYS.set(e.slice(i + 1), e.slice(0, i));
  else API_KEYS.set(e, `key:${e.slice(0, 6)}…`);
}
for (const [k, v] of Object.entries(process.env)) {
  const m = /^SHIM_API_KEY_([A-Za-z0-9_-]+)$/.exec(k);
  if (m && v.trim()) API_KEYS.set(v.trim(), m[1].toLowerCase());
}
const API_KEY = API_KEYS.size ? "set" : null; // truthy gate; real keys live in the map
const TIMEOUT_MS = Number(process.env.DEVIN_TIMEOUT_MS ?? 8 * 60 * 1000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 30 * 60 * 1000);
// Workspace root handed to sessions and the agent's persona. Defaults keep
// the shim a plain assistant: neutral cwd (not the repo) + "ask" mode.
const ACP_CWD = process.env.ACP_CWD ?? path.join(os.tmpdir(), "devin-shim-workspace");
const ACP_MODE = process.env.ACP_MODE ?? "smart"; // "ask" = Q&A only (no tools)

const MODEL = { id: DEVIN_MODEL, object: "model", created: 0, owned_by: "cognition" };

// ACP_BACKEND is set inside Devin Desktop sessions; if the spawned CLI sees it
// it ignores the on-disk credentials and demands ACP-host auth instead.
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "ACP_BACKEND"),
);

// ---------------------------------------------------------------------------
// Concurrency limiter (print transport) / prompt serialization
// ---------------------------------------------------------------------------

let running = 0;
const queue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}
function drain() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    job.fn().then(job.resolve, job.reject).finally(() => {
      running--;
      drain();
    });
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function flattenMessages(messages) {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
        : m.content ?? "";
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls
          .map((t) => `${t.function.name}(${t.function.arguments})`)
          .join(", ");
        return `ASSISTANT: ${content} [tool_calls: ${calls}]`;
      }
      const prefix = { system: "SYSTEM", user: "USER", assistant: "ASSISTANT", tool: "TOOL" }[m.role] ?? m.role.toUpperCase();
      return `${prefix}: ${content}`;
    })
    .join("\n\n");
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const c = messages[i].content;
      return Array.isArray(c)
        ? c.filter((p) => p.type === "text").map((p) => p.text).join("\n")
        : c ?? "";
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Multimodal: OpenAI content parts -> ACP prompt content blocks.
// `image_url` parts become {type:"image", data, mimeType} (data: URLs decode
// directly; http(s) URLs are fetched shim-side, 15s/20MB caps). `file` parts
// with text/* data decode inline as text. Anything else is dropped.
// ---------------------------------------------------------------------------

async function resolveImageUrl(url) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (m) return { data: m[2], mimeType: m[1] };
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`image fetch failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error("image exceeds 20MB");
  return { data: buf.toString("base64"), mimeType: (r.headers.get("content-type") ?? "image/png").split(";")[0] };
}

async function messageToBlocks(m) {
  const prefix = { system: "SYSTEM", user: "USER", assistant: "ASSISTANT", tool: "TOOL" }[m.role] ?? m.role.toUpperCase();
  const calls = m.role === "assistant" && m.tool_calls?.length
    ? ` [tool_calls: ${m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ")}]`
    : "";
  if (typeof m.content === "string" || m.content == null) {
    return [{ type: "text", text: `${prefix}: ${m.content ?? ""}${calls}` }];
  }
  const blocks = [];
  let first = true;
  const head = () => (first ? `${prefix}: ` : "");
  for (const p of m.content) {
    if (p.type === "text" && p.text) {
      blocks.push({ type: "text", text: `${head()}${p.text}${calls}` });
      first = false;
    } else if (p.type === "image_url" && p.image_url?.url) {
      const img = await resolveImageUrl(p.image_url.url);
      if (first) { blocks.push({ type: "text", text: `${prefix}:${calls}` }); first = false; }
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    } else if (p.type === "file" && p.file?.file_data) {
      const dm = /^data:([^;,]+);base64,(.+)$/s.exec(p.file.file_data);
      const txt = dm ? Buffer.from(dm[2], "base64").toString("utf8") : null;
      if (txt) {
        blocks.push({ type: "text", text: `${head()}[file ${p.file.filename ?? "attachment"}]:\n${txt}` });
        first = false;
      }
    }
  }
  if (!blocks.length) blocks.push({ type: "text", text: `${prefix}:${calls}` });
  return blocks;
}

async function messagesToBlocks(messages) {
  const out = [];
  for (const m of messages) out.push(...await messageToBlocks(m));
  return out;
}

async function lastUserBlocks(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messageToBlocks(messages[i]);
  }
  return null;
}

// ACP prompt result usage -> OpenAI chat usage. Fields pass through with
// real counts (incl. cached) when the transport reports them.
function realUsage(u, estPrompt, estCompletion) {
  if (!u) {
    return { prompt_tokens: estPrompt, completion_tokens: estCompletion, total_tokens: estPrompt + estCompletion, estimated: true };
  }
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.totalTokens,
    ...(u.cachedReadTokens ? { prompt_tokens_details: { cached_tokens: u.cachedReadTokens } } : {}),
  };
}

// Emulated function calling: describe tools in the prompt, ask for a JSON
// tool_call object, map it back to OpenAI shape.
function toolsPreamble(tools, toolChoice) {
  const specs = tools
    .filter((t) => t.type === "function")
    .map((t) => JSON.stringify(t.function))
    .join("\n");
  const forced = typeof toolChoice === "object" ? toolChoice?.function?.name : null;
  const mode = forced
    ? `must call the function "${forced}" and only it. You`
    : toolChoice === "required" ? "must" : toolChoice === "none" ? "must NOT" : "may, if needed,";
  return [
    `You ${mode} call a function. Available functions:`,
    specs,
    `If you call a function, respond with ONLY this JSON object and nothing else:`,
    `{"tool_call": {"name": "<function_name>", "arguments": <json object>}}`,
    `If you do not call a function, respond normally.`,
    ``,
  ].join("\n");
}

function parseToolCall(text, tools) {
  const m = text.match(/\{\s*"tool_call"\s*:\s*\{[\s\S]*\}\s*\}/);
  if (!m) return null;
  try {
    const { tool_call } = JSON.parse(m[0]);
    const valid = tools?.some((t) => t.function?.name === tool_call.name);
    return {
      id: `call_${crypto.randomBytes(12).toString("hex")}`,
      type: "function",
      index: 0, // required by strict OpenAI clients in streamed deltas
      function: {
        name: valid ? tool_call.name : tool_call.name, // pass through; hallucinated names still surface
        arguments: typeof tool_call.arguments === "string" ? tool_call.arguments : JSON.stringify(tool_call.arguments ?? {}),
      },
    };
  } catch {
    return null;
  }
}

function applyPostHoc(text, { stop, max_tokens, max_completion_tokens }) {
  const cap = max_tokens ?? max_completion_tokens;
  let out = text;
  for (const s of [].concat(stop ?? [])) {
    if (s) {
      const i = out.indexOf(s);
      if (i !== -1) out = out.slice(0, i);
    }
  }
  if (cap) {
    // rough token cap: ~4 chars/token
    out = out.slice(0, cap * 4);
  }
  return out;
}

const estimateTokens = (s) => Math.ceil((s ?? "").length / 4);

// ---------------------------------------------------------------------------
// Print transport: spawn `devin -p` per call. Stateless, no streaming.
// ---------------------------------------------------------------------------

function runDevinPrint(prompt, model = DEVIN_MODEL) {
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        const args = [
          "-p", prompt,
          "--model", model,
          "--config", READONLY_CONFIG,
          "--respect-workspace-trust", "false",
        ];
        const child = spawn(DEVIN_BIN, args, { cwd: __dirname, windowsHide: true, env: CHILD_ENV, shell: DEVIN_NEEDS_SHELL });
        let out = "", err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`devin timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out.trim());
          else {
            const e = new Error(`devin exited ${code}: ${err.trim() || out.trim()}`);
            reject(isAuthError(e) ? new Error(authRemedy(e)) : e);
          }
        });
      }),
  );
}

// ---------------------------------------------------------------------------
// ACP transport: one long-lived `devin acp` process, JSON-RPC over stdio
// (newline-delimited). Real streaming + persistent sessions.
// Agent->client requests (fs, terminal, permissions) are all refused, which
// enforces the read-only contract at the protocol level too.
// ---------------------------------------------------------------------------

class AcpClient {
  constructor(model) {
    this.model = model;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.chunkHandlers = new Map(); // sessionId -> fn(text)
    this.ready = null;
  }

  ensureStarted() {
    if (this.proc && !this.proc.killed) return this.ready;
    this.proc = spawn(
      DEVIN_BIN,
      ["--config", READONLY_CONFIG, "acp", "--model", this.model],
      { cwd: __dirname, windowsHide: true, stdio: ["pipe", "pipe", "inherit"], env: CHILD_ENV, shell: DEVIN_NEEDS_SHELL },
    );
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));
    this.proc.on("exit", () => this.onExit());
    this.proc.on("error", () => this.onExit());
    this.ready = this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "devin-openai-shim", version: "0.2.0" },
    });
    // NOTE: never proactively call `authenticate` — the agent advertises
    // browser PKCE methods even when stored credentials satisfy auth, and a
    // headless browser flow hangs forever, blocking every request. If the
    // backend genuinely needs auth, session/new fails and we surface it.
    return this.ready;
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/update") {
      const { sessionId, update } = msg.params ?? {};
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
        this.chunkHandlers.get(sessionId)?.(update.content.text);
      }
      return;
    }
    // Agent -> client request: refuse everything (read-only guarantee).
    if (msg.method && msg.id !== undefined) {
      const refused = msg.method === "session/request_permission"
        ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not allowed by shim" } };
      this.proc?.stdin.write(JSON.stringify(refused) + "\n");
    }
  }

  onExit() {
    const err = new Error("devin acp process exited");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.chunkHandlers.clear();
    this.proc = null;
    this.ready = null;
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) return reject(new Error("acp process not running"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`acp ${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async newSession() {
    await this.ensureStarted();
    try {
      const res = await this.request("session/new", { cwd: ACP_CWD, mcpServers: [] });
      // ACP mode selects the agent's built-in persona. "ask" is the plain
      // Q&A mode — without it the coding persona greets with "what would you
      // like to work on in <cwd>".
      if (ACP_MODE) {
        await this.request("session/set_mode", { sessionId: res.sessionId, modeId: ACP_MODE }).catch(() => {});
      }
      return res.sessionId;
    } catch (e) {
      if (isAuthError(e)) throw new Error(authRemedy(e));
      throw e;
    }
  }

  // Prompt with ACP content blocks [{type:"text"|"image",...}]. Resolves to the
  // raw result (includes real token usage); invokes onChunk per text delta.
  async prompt(sessionId, blocks, onChunk) {
    if (onChunk) this.chunkHandlers.set(sessionId, onChunk);
    try {
      return await this.request("session/prompt", { sessionId, prompt: blocks });
    } finally {
      this.chunkHandlers.delete(sessionId);
    }
  }
}

// One `devin acp` process per requested model — the CLI pins --model at
// spawn, so per-request model selection = a process pool. Lazily created on
// first use; each process carries its own sessions.
const acpClients = new Map(); // model -> AcpClient
function acpFor(model) {
  let c = acpClients.get(model);
  if (!c) { c = new AcpClient(model); acpClients.set(model, c); }
  return c;
}

// ---------------------------------------------------------------------------
// Auth recovery: when a spawned CLI reports "Not logged in", pop a real
// console window running `devin auth login` on the user's desktop. The login
// flow is interactive (browser PKCE or manual token) and needs a TTY — it
// cannot be driven headlessly — so the window is the honest handoff.
// Debounced so a burst of failing requests opens a single window.
// Disable with DEVIN_AUTO_LOGIN=0.
// ---------------------------------------------------------------------------
const AUTO_LOGIN = !/^(0|false|off)$/i.test(process.env.DEVIN_AUTO_LOGIN ?? "");
const AUTH_LOGIN_DEBOUNCE_MS = 60_000;
let lastLoginLaunch = 0;

const isAuthError = (e) =>
  /not logged in|auth(entication)? (required|failed|error)|\bunauthorized\b/i.test(e?.message ?? String(e));

function triggerAuthLogin() {
  if (!AUTO_LOGIN) return false;
  const now = Date.now();
  if (now - lastLoginLaunch < AUTH_LOGIN_DEBOUNCE_MS) return false;
  lastLoginLaunch = now;
  if (process.platform !== "win32") {
    console.warn("[devin-shim] auth required — run `devin auth login` in a terminal");
    return false;
  }
  // start "<title>" opens a real console window; cmd /k keeps it open so the
  // user sees the outcome. Inner doubled quotes survive cmd's quote stripping.
  spawn(
    `start "Devin Login" cmd /k ""${DEVIN_BIN}" auth login"`,
    { shell: true, detached: true, stdio: "ignore", windowsHide: true, env: CHILD_ENV },
  ).unref();
  console.log("[devin-shim] auth failure — launched `devin auth login` window");
  return true;
}

// Annotate the surfaced error and kick the login window when appropriate.
function authRemedy(e) {
  return triggerAuthLogin()
    ? `${e.message} — login window launched; complete it, then retry`
    : e.message;
}

// Request `model` -> a servable model id. Any model in the account catalog is
// accepted (each gets its own `devin acp` process); unknown ids are a 404.
// When the catalog itself is unreachable only DEVIN_MODEL is servable — it's
// the one model whose existence doesn't depend on a successful models list.
async function resolveModel(requested) {
  if (!requested || requested === DEVIN_MODEL) return { model: requested || DEVIN_MODEL };
  try {
    const { data } = await getCatalog();
    for (const fam of data.families ?? [])
      for (const v of fam.variants ?? [])
        if (v.model_uid === requested) return { model: requested };
    return { error: `model '${requested}' not found — see GET /v1/catalog for available models (default '${DEVIN_MODEL}')` };
  } catch {
    return { error: `model '${requested}' can't be verified (catalog unavailable); only '${DEVIN_MODEL}' is servable` };
  }
}

// Conversation -> ACP session map. `user` field (or x-session-id header) is
// the conversation key; without one, every call gets a fresh session and the
// full history is replayed as prompt text.
const sessions = new Map(); // key -> { sessionId, busy: Promise, touched }
function getSession(key) {
  let s = sessions.get(key);
  if (!s) {
    s = { sessionId: null, touched: Date.now() };
    sessions.set(key, s);
  }
  s.touched = Date.now();
  return s;
}
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, s] of sessions) if (s.touched < cutoff) sessions.delete(k);
}, 60_000).unref();

async function acpChat(model, convKey, messages, onChunk) {
  const s = getSession(`${model}\n${convKey}`);
  const client = acpFor(model);
  // Serialize prompts per conversation.
  const prev = s.busy ?? Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    if (!s.sessionId) s.sessionId = await client.newSession();
    // ACP sessions keep context — send only the new user turn if the session
    // already has history, else the flattened transcript.
    const blocks = s.hasHistory ? (await lastUserBlocks(messages) ?? await messagesToBlocks(messages)) : await messagesToBlocks(messages);
    let acc = "";
    try {
      const r = await client.prompt(s.sessionId, blocks, (t) => { acc += t; onChunk?.(t); });
      s.hasHistory = true;
      return { text: acc, usage: r?.usage ?? null };
    } catch (e) {
      // Auth failure can't be fixed by recreating the session — kick the
      // login window and fail fast instead of a pointless replay.
      if (isAuthError(e)) throw new Error(authRemedy(e));
      // Session may have died with a restarted acp process — recreate once.
      s.sessionId = await client.newSession();
      s.hasHistory = false;
      acc = "";
      const r = await client.prompt(s.sessionId, await messagesToBlocks(messages), (t) => { acc += t; onChunk?.(t); });
      s.hasHistory = true;
      return { text: acc, usage: r?.usage ?? null };
    }
  });
  s.busy = job;
  return job;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "4mb" }));

// Permissive CORS: the shim binds to localhost anyway; this unblocks
// browser-based OpenAI clients.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-session-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Per-key access stats (in-memory; restart resets). One log line per
// authenticated request + one per denial — no per-chunk/body logging.
const accessLog = new Map(); // label -> {requests, last_at, last_route, last_ip, last_user}
const SKIP_LOG = new Set(["/health"]); // monitoring noise

function recordAccess(label, req) {
  const a = accessLog.get(label) ?? { requests: 0 };
  a.requests++;
  a.last_at = new Date().toISOString();
  a.last_route = `${req.method} ${req.path}`;
  a.last_ip = req.ip;
  a.last_user = req.body?.user ?? req.headers["x-session-id"] ?? null;
  accessLog.set(label, a);
  if (!SKIP_LOG.has(req.path)) {
    console.log(`[access] ${a.last_at} key=${label} ${a.last_route} ip=${req.ip}${a.last_user ? ` user=${a.last_user}` : ""}`);
  }
}

// Returns the configured key's label when the request carries a valid
// `Authorization: Bearer` key, else null. Used both for hard auth gating and
// for catalog's free-vs-paid visibility split.
function keyLabel(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const tb = Buffer.from(token);
  for (const [k, l] of API_KEYS)
    if (tb.length === k.length && crypto.timingSafeEqual(tb, Buffer.from(k))) return l;
  return null;
}

app.use((req, res, next) => {
  // Public routes: catalog is metadata (free models only without a key);
  // images/serve uses unguessable IDs and those clients never send auth.
  if (!API_KEYS.size || req.path === "/v1/catalog" || req.path.startsWith("/v1/images/serve/")) return next();
  const label = keyLabel(req);
  if (!label) {
    if (!SKIP_LOG.has(req.path)) console.log(`[access] ${new Date().toISOString()} DENIED ${req.method} ${req.path} ip=${req.ip}`);
    return res.status(401).json({ error: { message: "invalid api key", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  }
  recordAccess(label, req);
  next();
});

const openaiError = (res, status, message, type = "invalid_request_error") =>
  res.status(status).json({ error: { message, type, param: null, code: null } });

const unsupported = (name) => (_req, res) =>
  openaiError(res, 501, `${name} is not supported by this shim (backed by Devin CLI)`, "unsupported_endpoint");

function buildChoice(text, body, index = 0) {
  const toolCall = body.tools?.length ? parseToolCall(text, body.tools) : null;
  const clean = toolCall ? "" : applyPostHoc(text, body);
  return {
    index,
    message: {
      role: "assistant",
      content: toolCall ? null : clean,
      ...(toolCall ? { tool_calls: [toolCall] } : {}),
    },
    finish_reason: toolCall ? "tool_calls" : (body.max_tokens ?? body.max_completion_tokens) && clean.length >= (body.max_tokens ?? body.max_completion_tokens) * 4 ? "length" : "stop",
    _promptText: text,
  };
}

// Legacy `functions`/`function_call` params → normalize to tools/tool_choice.
function normalizeLegacyTools(body) {
  if (!body.tools?.length && body.functions?.length) {
    body.tools = body.functions.map((f) => ({ type: "function", function: f }));
  }
  if (body.tool_choice == null && body.function_call != null) {
    const fc = body.function_call;
    body.tool_choice = typeof fc === "object" ? { type: "function", function: { name: fc.name } }
      : fc === "none" || fc === "auto" ? fc
      : { type: "function", function: { name: fc } };
  }
}

async function generateOne(body, onChunk, convKeyOverride) {
  const { model, error } = await resolveModel(body.model);
  if (error) throw new Error(error);
  const convKey = convKeyOverride ?? body.user ?? body.__sessionHeader ?? crypto.randomUUID();
  const msgs = [...(body.messages ?? [])];
  if (body.tools?.length && body.tool_choice !== "none") {
    msgs.unshift({ role: "system", content: toolsPreamble(body.tools, body.tool_choice) });
  }
  if (body.response_format?.type === "json_object") {
    msgs.unshift({ role: "system", content: "Respond with a single valid JSON object only. No prose, no markdown fences." });
  }
  const r = TRANSPORT === "acp"
    ? await acpChat(model, convKey, msgs, onChunk)
    : await runDevinPrint(flattenMessages(msgs), model).then((text) => ({ text, usage: null }));
  return { ...r, model };
}

// Non-streaming core, shared by the route and the batch processor.
async function runChatCompletion(body) {
  normalizeLegacyTools(body);
  const n = Math.min(Math.max(body.n ?? 1, 1), 4);
  const baseKey = body.user ?? body.__sessionHeader ?? `anon:${crypto.randomUUID()}`;
  const results = await Promise.all(
    // n>1: each choice needs an independent session, not the shared convo
    Array.from({ length: n }, (_, i) => generateOne(body, undefined, `${baseKey}#${i}`)),
  );
  const estPrompt = estimateTokens(JSON.stringify(body.messages));
  const choices = results.map((r, i) => buildChoice(r.text, body, i));
  const promptToks = results.reduce((a, r) => a + (r.usage?.inputTokens ?? estPrompt), 0);
  const completionToks = results.reduce((a, r) => a + (r.usage?.outputTokens ?? estimateTokens(r.text)), 0);
  const cachedToks = results.reduce((a, r) => a + (r.usage?.cachedReadTokens ?? 0), 0);
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: results[0]?.model ?? body.model ?? DEVIN_MODEL,
    choices: choices.map(({ _promptText, ...c }) => c),
    usage: {
      prompt_tokens: promptToks,
      completion_tokens: completionToks,
      total_tokens: promptToks + completionToks,
      ...(cachedToks ? { prompt_tokens_details: { cached_tokens: cachedToks } } : {}),
      ...(results.every((r) => !r.usage) ? { estimated: true } : {}),
    },
  };
}

app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body ?? {};
  body.__sessionHeader = req.headers["x-session-id"];
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError(res, 400, "messages is required and must be a non-empty array");
  }
  const mv = await resolveModel(body.model);
  if (mv.error) return openaiError(res, 404, mv.error, "model_not_found");
  body.model = mv.model;
  normalizeLegacyTools(body);
  const n = Math.min(Math.max(body.n ?? 1, 1), 4); // cap: each choice = one agent run

  let heartbeat = null;
  try {
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
      const created = Math.floor(Date.now() / 1000);
      const send = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);

      send({ role: "assistant" });
      // SSE comment pings keep the connection alive across proxies while the
      // agent is silent (acp first-token latency can be many seconds).
      heartbeat = setInterval(() => res.write(": hb\n\n"), 15000);
      const { text, usage } = await generateOne(body, (t) => send({ content: t }));
      clearInterval(heartbeat);
      const choice = buildChoice(text, body);
      if (choice.message.tool_calls) send({ tool_calls: choice.message.tool_calls });
      send({}, choice.finish_reason);
      if (body.stream_options?.include_usage) {
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: body.model,
          choices: [], usage: realUsage(usage, estimateTokens(JSON.stringify(body.messages)), estimateTokens(text)),
        })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    res.json(await runChatCompletion(body));
  } catch (e) {
    if (heartbeat) clearInterval(heartbeat);
    if (res.headersSent) return res.end();
    openaiError(res, 502, e.message, "upstream_error");
  }
});

// ---------------------------------------------------------------------------
// POST /v1/responses — OpenAI Responses API (default surface of newer SDKs).
// Supported: instructions, string|item-array input, function tools +
// tool_choice, previous_response_id chaining, max_output_tokens, stream with
// the standard event sequence, store/metadata passthrough, text.format.
// ---------------------------------------------------------------------------

const respStore = new Map(); // resp_id -> conversation key (previous_response_id)

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const msgs = [];
  for (const it of input ?? []) {
    if (it.role && it.type === undefined) { // plain chat-style {role, content}
      msgs.push({ role: it.role, content: it.content });
      continue;
    }
    if (it.type === "message") {
      const parts = Array.isArray(it.content) ? it.content : [{ text: String(it.content) }];
      // Map Responses input parts onto chat content parts so images/files flow.
      const content = parts.map((p) => {
        if (p.type === "input_image" && p.image_url) return { type: "image_url", image_url: { url: p.image_url } };
        if (p.type === "input_file" && p.file_data) return { type: "file", file: { file_data: p.file_data, filename: p.filename } };
        return { type: "text", text: p.text ?? "" };
      });
      msgs.push({ role: it.role ?? "user", content });
    } else if (it.type === "function_call") {
      msgs.push({ role: "assistant", content: "", tool_calls: [{ id: it.call_id, type: "function", function: { name: it.name, arguments: it.arguments } }] });
    } else if (it.type === "function_call_output") {
      msgs.push({ role: "tool", content: typeof it.output === "string" ? it.output : JSON.stringify(it.output) });
    }
    // reasoning/web_search_call/etc. items carry no text — skipped
  }
  return msgs;
}

const rid = (p) => `${p}_${crypto.randomBytes(12).toString("hex")}`;

function buildResponse(id, text, body, usage, status = "completed") {
  const toolCall = body.tools?.length ? parseToolCall(text, body.tools) : null;
  const clean = toolCall ? "" : applyPostHoc(text, body);
  const output = toolCall
    ? [{ type: "function_call", id: rid("fc"), call_id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments, status: "completed" }]
    : [{ id: rid("msg"), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: clean, annotations: [] }] }];
  const it = usage?.inputTokens ?? estimateTokens(JSON.stringify(body.messages));
  const ot = usage?.outputTokens ?? estimateTokens(toolCall ? toolCall.function.arguments : clean);
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status,
    model: body.model ?? DEVIN_MODEL, output, output_text: clean,
    usage: {
      input_tokens: it, output_tokens: ot, total_tokens: usage?.totalTokens ?? it + ot,
      ...(usage?.cachedReadTokens ? { input_tokens_details: { cached_tokens: usage.cachedReadTokens } } : {}),
      ...(!usage ? { estimated: true } : {}),
    },
    store: body.store ?? true, metadata: body.metadata ?? {},
    previous_response_id: body.previous_response_id ?? null,
  };
}

// Shared Responses normalization: returns {convKey, normBody} or {error}.
function normalizeResponsesRequest(body, sessionHeader) {
  let convKey;
  if (body.previous_response_id) {
    convKey = respStore.get(body.previous_response_id);
    if (!convKey) return { error: `previous_response_id '${body.previous_response_id}' not found` };
  } else {
    convKey = `resp:${body.user ?? sessionHeader ?? crypto.randomUUID()}`;
  }
  const normBody = {
    model: body.model,
    messages: [
      ...(body.instructions ? [{ role: "system", content: body.instructions }] : []),
      ...responsesInputToMessages(body.input),
    ],
    tools: (body.tools ?? []).map((t) =>
      t.type === "function" && !t.function
        ? { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters, strict: t.strict } }
        : t),
    tool_choice: body.tool_choice,
    max_tokens: body.max_output_tokens,
    user: body.user,
    previous_response_id: body.previous_response_id ?? null,
    store: body.store,
    metadata: body.metadata,
    response_format: body.text?.format?.type === "json_object" || body.text?.format?.type === "json_schema"
      ? { type: "json_object" } : undefined,
  };
  return { convKey, normBody };
}

app.post("/v1/responses", async (req, res) => {
  const body = req.body ?? {};
  const mv = await resolveModel(body.model);
  if (mv.error) return openaiError(res, 404, mv.error, "model_not_found");
  body.model = mv.model;
  if (body.input === undefined || body.input === null) {
    return openaiError(res, 400, "input is required");
  }
  const { convKey, normBody, error } = normalizeResponsesRequest(body, req.headers["x-session-id"]);
  if (error) return openaiError(res, 400, error);
  if (!normBody.messages.length) return openaiError(res, 400, "input produced no messages");

  const respId = rid("resp");
  let heartbeat = null;
  try {
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const ev = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      const msgId = rid("msg"), part = { type: "output_text", text: "", annotations: [] };
      const item = { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] };

      ev("response.created", { response: { ...buildResponse(respId, "", normBody, null, "in_progress"), output: [] } });
      ev("response.in_progress", { response: { id: respId, status: "in_progress" } });
      ev("response.output_item.added", { output_index: 0, item });
      ev("response.content_part.added", { item_id: msgId, output_index: 0, content_index: 0, part });
      heartbeat = setInterval(() => res.write(": hb\n\n"), 15000);
      const { text, usage } = await generateOne(normBody, (t) => ev("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: t }), convKey);
      clearInterval(heartbeat);

      const final = buildResponse(respId, text, normBody, usage);
      if (final.output[0].type === "function_call") {
        const fc = final.output[0];
        ev("response.output_item.added", { output_index: 0, item: { ...fc, status: "in_progress" } });
        ev("response.function_call_arguments.done", { item_id: fc.id, output_index: 0, arguments: fc.arguments });
        ev("response.output_item.done", { output_index: 0, item: fc });
      } else {
        ev("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text: final.output_text });
        ev("response.content_part.done", { item_id: msgId, output_index: 0, content_index: 0, part: { ...part, text: final.output_text } });
        ev("response.output_item.done", { output_index: 0, item: { ...item, status: "completed", content: [{ ...part, text: final.output_text }] } });
      }
      ev("response.completed", { response: final });
      respStore.set(respId, convKey);
      return res.end();
    }

    const { text, usage } = await generateOne(normBody, undefined, convKey);
    const final = buildResponse(respId, text, normBody, usage);
    respStore.set(respId, convKey);
    res.json(final);
  } catch (e) {
    if (heartbeat) clearInterval(heartbeat);
    if (res.headersSent) return res.end();
    openaiError(res, 502, e.message, "upstream_error");
  }
});

// Every catalog model is servable — each spawns its own acp process on first
// request. Falls back to just DEVIN_MODEL when the catalog is unreachable.
app.get("/v1/models", async (_req, res) => {
  try {
    const { data } = await getCatalog();
    const models = [];
    for (const fam of data.families ?? [])
      for (const v of fam.variants ?? [])
        models.push({ id: v.model_uid, object: "model", created: 0, owned_by: "cognition" });
    res.json({ object: "list", data: models.length ? models : [MODEL] });
  } catch {
    res.json({ object: "list", data: [MODEL] });
  }
});
app.get("/v1/models/:id", async (req, res) => {
  if (req.params.id === DEVIN_MODEL) return res.json(MODEL);
  const mv = await resolveModel(req.params.id);
  mv.error
    ? openaiError(res, 404, "model not found")
    : res.json({ id: mv.model, object: "model", created: 0, owned_by: "cognition" });
});

// ---------------------------------------------------------------------------
// Public model catalog: `devin models list --format json`, cached 5 min.
// No auth — safe read-only metadata.
// ---------------------------------------------------------------------------
const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = null; // { at, data, stale }

function runModelsList() {
  return new Promise((resolve, reject) => {
    const child = spawn(DEVIN_BIN, ["models", "list", "--format", "json"], {
      cwd: __dirname, windowsHide: true, env: CHILD_ENV, shell: DEVIN_NEEDS_SHELL,
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("models list timed out")); }, 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const e = new Error(err.trim() || `devin models list exited ${code}`);
        return reject(isAuthError(e) ? new Error(authRemedy(e)) : e);
      }
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

async function getCatalog() {
  if (catalogCache && Date.now() - catalogCache.at <= CATALOG_TTL_MS) return catalogCache;
  try {
    catalogCache = { at: Date.now(), data: await runModelsList(), stale: false };
  } catch (e) {
    if (catalogCache) { catalogCache.stale = true; return catalogCache; }
    throw e;
  }
  return catalogCache;
}

app.get("/v1/catalog", async (req, res) => {
  try {
    const { data, stale } = await getCatalog();
    // Free models are public metadata; anything that bills credits requires
    // a shim API key. No key configured at all → open shim → everything is
    // visible to everyone.
    const authed = !API_KEYS.size || keyLabel(req) != null;
    const filter = String(req.query.filter ?? "all").toLowerCase(); // all|free|paid|recommended
    if (!authed && filter === "paid")
      return openaiError(res, 401, "paid model listing requires Authorization: Bearer <key>", "invalid_request_error");
    const tier = req.query.tier?.toLowerCase();                     // free|low|med|high
    const q = req.query.q?.toLowerCase();
    const models = [];
    for (const fam of data.families ?? []) {
      for (const v of fam.variants ?? []) {
        const free = /free/i.test(v.cost_tier ?? "");
        if (!authed && !free) continue; // hide paid tiers from the public view
        const m = {
          model: v.model_uid,
          label: v.label,
          family: fam.slug,
          aliases: fam.aliases ?? [],
          description: v.description ?? null,
          free,
          recommended: free || v.model_uid === DEVIN_MODEL,
          cost_tier: v.cost_tier ?? null,
          cost_summary: v.cost_summary ?? null,
          context_tokens: v.max_context_tokens ?? null,
          output_tokens: v.max_output_tokens ?? null,
          is_new: !!v.is_new,
          is_beta: !!v.is_beta,
          served: true, // any catalog model is servable — it gets its own acp process
          default: v.model_uid === DEVIN_MODEL,
        };
        const t = (v.cost_tier ?? "").toLowerCase();
        if (filter === "free" && !free) continue;
        if (filter === "paid" && free) continue;
        if (filter === "recommended" && !m.recommended) continue;
        if (tier && !(t === "free" ? tier === "free" : t.startsWith(tier))) continue;
        if (q && !`${m.model} ${m.label} ${m.family}`.toLowerCase().includes(q)) continue;
        models.push(m);
      }
    }
    res.json({
      object: "list",
      served_model: DEVIN_MODEL,
      authenticated: authed,          // false → free models only
      filters: { filter, tier: tier ?? null, q: q ?? null },
      stale,
      count: models.length,
      data: models,
    });
  } catch (e) {
    openaiError(res, 502, `catalog unavailable: ${e.message}`, "upstream_error");
  }
});
// Authenticated: per-key access stats — who called what last.
app.get("/v1/access", (_req, res) =>
  res.json({
    object: "list",
    data: [...accessLog.entries()].map(([key, a]) => ({ key, ...a })),
  }));
app.get("/health", (_req, res) =>
  res.json({ ok: true, transport: TRANSPORT, running, queued: queue.length, sessions: sessions.size }),
);

// ===========================================================================
// Extended OpenAI surface — emulated where the backend allows, honest 501
// where it doesn't.
// ===========================================================================

fs.mkdirSync(ACP_CWD, { recursive: true });

const DATA_DIR = path.join(__dirname, ".data");
const FILES_DIR = path.join(DATA_DIR, "files");
const IMAGES_DIR = path.join(DATA_DIR, "images");
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Minimal multipart/form-data parser (enough for OpenAI file uploads).
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const boundary = (req.headers["content-type"] ?? "").split("boundary=")[1];
      if (!boundary) return reject(new Error("multipart: missing boundary"));
      const buf = Buffer.concat(chunks);
      const sep = Buffer.from(`--${boundary}`);
      const parts = {};
      let pos = buf.indexOf(sep);
      while (pos >= 0) {
        pos += sep.length;
        if (buf[pos] === 0x2d) break; // trailing --
        if (buf[pos] === 0x0d) pos += 2; // CRLF
        const next = buf.indexOf(sep, pos);
        const seg = buf.slice(pos, next < 0 ? buf.length : next);
        const hdrEnd = seg.indexOf("\r\n\r\n");
        const hdr = seg.slice(0, hdrEnd).toString("latin1");
        let data = seg.slice(hdrEnd + 4);
        if (data.length >= 2 && data[data.length - 2] === 0x0d) data = data.slice(0, -2);
        const name = /name="([^"]+)"/.exec(hdr)?.[1];
        const filename = /filename="([^"]*)"/.exec(hdr)?.[1];
        if (name) parts[name] = { filename, data };
        pos = next;
      }
      resolve(parts);
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Files — local disk storage. Real endpoint, real persistence.
// ---------------------------------------------------------------------------
const filesIndex = new Map(); // id -> meta
const filesIndexPath = path.join(DATA_DIR, "files.json");
try {
  for (const m of JSON.parse(fs.readFileSync(filesIndexPath, "utf8"))) filesIndex.set(m.id, m);
} catch { /* fresh store */ }
const saveFilesIndex = () =>
  fs.writeFileSync(filesIndexPath, JSON.stringify([...filesIndex.values()], null, 0));

function fileObject(m) {
  return { id: m.id, object: "file", bytes: m.bytes, created_at: m.created_at, filename: m.filename, purpose: m.purpose };
}

async function storeFile(data, filename, purpose) {
  const id = `file-${crypto.randomBytes(12).toString("hex")}`;
  fs.writeFileSync(path.join(FILES_DIR, id), data);
  const meta = { id, bytes: data.length, created_at: Math.floor(Date.now() / 1000), filename: filename ?? id, purpose: purpose ?? "user_data" };
  filesIndex.set(id, meta);
  saveFilesIndex();
  return meta;
}

app.post("/v1/files", async (req, res) => {
  try {
    if ((req.headers["content-type"] ?? "").includes("multipart/form-data")) {
      const parts = await readMultipart(req);
      if (!parts.file?.data?.length) return openaiError(res, 400, "multipart 'file' part is required");
      const meta = await storeFile(parts.file.data, parts.file.filename, parts.purpose?.data?.toString());
      return res.json(fileObject(meta));
    }
    // JSON fallback: {file_data: "<base64|data-url>", filename, purpose}
    const b = req.body ?? {};
    const dm = /^data:[^;,]+;base64,(.+)$/s.exec(b.file_data ?? "")?.[1] ?? b.file_data;
    if (!dm) return openaiError(res, 400, "file_data (base64) required for JSON uploads");
    const meta = await storeFile(Buffer.from(dm, "base64"), b.filename, b.purpose);
    res.json(fileObject(meta));
  } catch (e) {
    openaiError(res, 400, `file upload failed: ${e.message}`);
  }
});
app.get("/v1/files", (_req, res) =>
  res.json({ object: "list", data: [...filesIndex.values()].map(fileObject) }));
app.get("/v1/files/:id", (req, res) =>
  filesIndex.has(req.params.id) ? res.json(fileObject(filesIndex.get(req.params.id))) : openaiError(res, 404, "file not found", "file_not_found"));
app.get("/v1/files/:id/content", (req, res) => {
  const m = filesIndex.get(req.params.id);
  const fp = m && path.join(FILES_DIR, m.id);
  if (!fp || !fs.existsSync(fp)) return openaiError(res, 404, "file content not found", "file_not_found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${m.filename}"`);
  fs.createReadStream(fp).pipe(res);
});
app.delete("/v1/files/:id", (req, res) => {
  const m = filesIndex.get(req.params.id);
  if (!m) return openaiError(res, 404, "file not found", "file_not_found");
  fs.rmSync(path.join(FILES_DIR, m.id), { force: true });
  filesIndex.delete(m.id);
  saveFilesIndex();
  res.json({ id: m.id, object: "file", deleted: true });
});

// ---------------------------------------------------------------------------
// Batches — real async processing of JSONL files through our own endpoints.
// ---------------------------------------------------------------------------
const batches = new Map();

async function runBatchItem(item) {
  const url = item.url ?? "";
  try {
    if (url.includes("/v1/chat/completions")) {
      return { status_code: 200, request_id: `req_${crypto.randomBytes(8).toString("hex")}`, body: await runChatCompletion(item.body ?? {}) };
    }
    if (url.includes("/v1/responses")) {
      const { convKey, normBody, error } = normalizeResponsesRequest(item.body ?? {}, `batch:${crypto.randomUUID()}`);
      if (error) return { status_code: 400, body: { error: { message: error } } };
      const respId = rid("resp");
      const { text, usage } = await generateOne(normBody, undefined, convKey);
      const final = buildResponse(respId, text, normBody, usage);
      respStore.set(respId, convKey);
      return { status_code: 200, request_id: `req_${crypto.randomBytes(8).toString("hex")}`, body: final };
    }
    return { status_code: 404, body: { error: { message: `endpoint '${url}' not supported in batches`, type: "invalid_request_error" } } };
  } catch (e) {
    return { status_code: 502, body: { error: { message: e.message, type: "upstream_error" } } };
  }
}

async function processBatch(b) {
  b.status = "in_progress";
  b.in_progress_at = Math.floor(Date.now() / 1000);
  const inputPath = path.join(FILES_DIR, b.input_file_id);
  const outId = `file-${crypto.randomBytes(12).toString("hex")}`;
  const outLines = [];
  try {
    const lines = fs.readFileSync(inputPath, "utf8").split("\n").filter((l) => l.trim());
    b.request_counts.total = lines.length;
    for (const line of lines) {
      if (b.status === "cancelling" || b.status === "cancelled") break;
      let item = {};
      try { item = JSON.parse(line); } catch { /* malformed → error row below */ }
      const response = item.method === "POST" || !item.method ? await runBatchItem(item) : { status_code: 400, body: { error: { message: "only POST batch items are supported" } } };
      outLines.push(JSON.stringify({ id: `batch_req_${crypto.randomBytes(8).toString("hex")}`, custom_id: item.custom_id ?? null, response, error: null }));
      if (response.status_code < 300) b.request_counts.completed++; else b.request_counts.failed++;
    }
    const outBuf = Buffer.from(outLines.join("\n") + "\n");
    fs.writeFileSync(path.join(FILES_DIR, outId), outBuf);
    filesIndex.set(outId, { id: outId, bytes: outBuf.length, created_at: Math.floor(Date.now() / 1000), filename: `${b.id}_output.jsonl`, purpose: "batch_output" });
    saveFilesIndex();
    b.output_file_id = outId;
    b.status = b.status === "cancelling" ? "cancelled" : "completed";
  } catch (e) {
    b.status = "failed";
    b.errors = { object: "list", data: [{ code: "processing_error", message: e.message }] };
  }
  b[b.status === "completed" ? "completed_at" : b.status === "cancelled" ? "cancelled_at" : "failed_at"] = Math.floor(Date.now() / 1000);
}

app.post("/v1/batches", async (req, res) => {
  const { input_file_id, endpoint, completion_window } = req.body ?? {};
  const m = filesIndex.get(input_file_id);
  if (!m) return openaiError(res, 400, `input_file_id '${input_file_id}' not found`);
  if (!["/v1/chat/completions", "/v1/responses"].includes(endpoint))
    return openaiError(res, 400, `endpoint '${endpoint}' not supported (allowed: /v1/chat/completions, /v1/responses)`);
  const b = {
    id: `batch_${crypto.randomBytes(12).toString("hex")}`, object: "batch",
    input_file_id, endpoint, completion_window: completion_window ?? "24h",
    status: "validating", created_at: Math.floor(Date.now() / 1000),
    metadata: req.body.metadata ?? {},
    request_counts: { total: 0, completed: 0, failed: 0 },
  };
  batches.set(b.id, b);
  processBatch(b).catch(() => {});
  b.status = "validating"; // processBatch may have raced to completion on small inputs
  res.json({ ...b });
});
app.get("/v1/batches", (req, res) =>
  res.json({ object: "list", data: [...batches.values()].slice(-Number(req.query.limit ?? 20)) }));
app.get("/v1/batches/:id", (req, res) =>
  batches.has(req.params.id) ? res.json(batches.get(req.params.id)) : openaiError(res, 404, "batch not found", "batch_not_found"));
app.post("/v1/batches/:id/cancel", (req, res) => {
  const b = batches.get(req.params.id);
  if (!b) return openaiError(res, 404, "batch not found", "batch_not_found");
  if (["in_progress", "validating"].includes(b.status)) b.status = "cancelling";
  res.json(b);
});

// ---------------------------------------------------------------------------
// Moderations — LLM-emulated classifier. Emits the full OpenAI category set.
// ---------------------------------------------------------------------------
const MOD_CATEGORIES = [
  "sexual", "hate", "harassment", "self-harm", "sexual/minors",
  "hate/threatening", "violence/graphic", "self-harm/intent",
  "self-harm/instructions", "harassment/threatening", "violence",
];

app.post("/v1/moderations", async (req, res) => {
  const inputs = Array.isArray(req.body?.input) ? req.body.input : [req.body?.input ?? ""];
  const results = [];
  try {
    for (const input of inputs) {
      const { text } = await generateOne({
        messages: [
          { role: "system", content: `You are an OpenAI omni-moderation classifier. For the input text reply with ONLY a JSON object: {"flagged":boolean,"categories":{<cat>:boolean},"category_scores":{<cat>:0..1}} covering exactly these categories: ${MOD_CATEGORIES.join(",")}. No prose.` },
          { role: "user", content: typeof input === "string" ? input : JSON.stringify(input) },
        ],
      }, undefined, `mod:${crypto.randomUUID()}`);
      const m = /\{[\s\S]*\}/.exec(text)?.[0];
      const parsed = m ? JSON.parse(m) : {};
      const categories = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, !!parsed.categories?.[c]]));
      const scores = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, Number(parsed.category_scores?.[c] ?? 0)]));
      results.push({
        flagged: parsed.flagged ?? Object.values(categories).some(Boolean),
        categories, category_scores: scores,
      });
    }
    res.json({ id: `modr-${crypto.randomBytes(12).toString("hex")}`, model: req.body?.model ?? "omni-moderation-emulated", results });
  } catch (e) {
    openaiError(res, 502, `moderation failed: ${e.message}`, "upstream_error");
  }
});

// ---------------------------------------------------------------------------
// Images — emulated: the model writes SVG. b64_json always available; "url"
// response_format serves the SVG from this shim (localhost reachability only).
// ---------------------------------------------------------------------------
async function generateImage(promptText) {
  const { text } = await generateOne({
    messages: [{ role: "user", content: `You are an SVG artist. Produce an SVG image for this request, replying with ONLY the SVG markup (no prose, no fences):\n${promptText}` }],
  }, undefined, `img:${crypto.randomUUID()}`);
  const m = /<svg[\s\S]*<\/svg>/.exec(text)?.[0];
  if (!m) throw new Error("model did not return SVG");
  return m;
}

app.post("/v1/images/generations", async (req, res) => {
  const { prompt, n: reqN = 1, size, quality, style, background, response_format } = req.body ?? {};
  if (!prompt) return openaiError(res, 400, "prompt is required");
  const n = Math.min(Math.max(reqN, 1), 4);
  const fullPrompt = [prompt, size && `size ${size}`, quality && `quality ${quality}`, style && `style ${style}`, background && `background ${background}`].filter(Boolean).join("; ");
  try {
    const data = [];
    for (let i = 0; i < n; i++) {
      const svg = await generateImage(fullPrompt);
      if (response_format === "url") {
        const id = `img-${crypto.randomBytes(12).toString("hex")}`;
        fs.writeFileSync(path.join(IMAGES_DIR, `${id}.svg`), svg);
        data.push({ url: `http://${HOST}:${PORT}/v1/images/serve/${id}` });
      } else {
        data.push({ b64_json: Buffer.from(svg).toString("base64"), revised_prompt: prompt });
      }
    }
    res.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (e) {
    openaiError(res, 502, `image generation failed: ${e.message}`, "upstream_error");
  }
});
app.get("/v1/images/serve/:id", (req, res) => {
  const fp = path.join(IMAGES_DIR, `${req.params.id}.svg`);
  if (!fs.existsSync(fp)) return openaiError(res, 404, "image not found");
  res.setHeader("Content-Type", "image/svg+xml");
  fs.createReadStream(fp).pipe(res);
});

// ---------------------------------------------------------------------------
// Assistants + Threads + Runs — in-memory stores; runs execute through the
// shim keyed by thread id (persistent ACP session → real multi-turn).
// ---------------------------------------------------------------------------
const assistants = new Map();
const threads = new Map();
const runs = new Map();

const asstObject = (a) => ({
  id: a.id, object: "assistant", created_at: a.created_at, name: a.name ?? null,
  description: a.description ?? null, model: a.model ?? DEVIN_MODEL,
  instructions: a.instructions ?? null, tools: a.tools ?? [],
  tool_resources: a.tool_resources ?? {}, metadata: a.metadata ?? {},
  temperature: a.temperature ?? null, top_p: a.top_p ?? null, response_format: a.response_format ?? "auto",
});

app.post("/v1/assistants", (req, res) => {
  const a = { id: `asst_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000), ...req.body };
  assistants.set(a.id, a);
  res.json(asstObject(a));
});
app.get("/v1/assistants", (req, res) =>
  res.json({ object: "list", data: [...assistants.values()].map(asstObject), first_id: null, last_id: null, has_more: false }));
app.get("/v1/assistants/:id", (req, res) =>
  assistants.has(req.params.id) ? res.json(asstObject(assistants.get(req.params.id))) : openaiError(res, 404, "assistant not found"));
app.post("/v1/assistants/:id", (req, res) => {
  const a = assistants.get(req.params.id);
  if (!a) return openaiError(res, 404, "assistant not found");
  Object.assign(a, req.body);
  res.json(asstObject(a));
});
app.delete("/v1/assistants/:id", (req, res) =>
  assistants.delete(req.params.id) ? res.json({ id: req.params.id, object: "assistant.deleted", deleted: true }) : openaiError(res, 404, "assistant not found"));

const msgObject = (m) => ({
  id: m.id, object: "thread.message", created_at: m.created_at, thread_id: m.thread_id,
  status: "completed", role: m.role,
  content: [{ type: "text", text: { value: m.text, annotations: [] } }],
  attachments: [], metadata: m.metadata ?? {},
});

function newThread(body = {}) {
  const t = { id: `thread_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000), metadata: body.metadata ?? {}, tool_resources: body.tool_resources ?? {}, messages: [] };
  for (const m of body.messages ?? []) {
    t.messages.push({ id: `msg_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000), thread_id: t.id, role: m.role ?? "user", text: typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text?.value ?? p.text ?? "").join("\n"), metadata: m.metadata ?? {} });
  }
  threads.set(t.id, t);
  return t;
}
const threadObject = (t) => ({ id: t.id, object: "thread", created_at: t.created_at, metadata: t.metadata, tool_resources: t.tool_resources });

app.post("/v1/threads", (req, res) => {
  const t = newThread(req.body);
  res.json({ ...threadObject(t) });
});
app.post("/v1/threads/runs", async (req, res) => {
  // create-thread-and-run convenience endpoint
  const t = newThread(req.body.thread);
  const run = await startRun(t, req.body);
  res.json(run);
});
app.get("/v1/threads/:id", (req, res) =>
  threads.has(req.params.id) ? res.json(threadObject(threads.get(req.params.id))) : openaiError(res, 404, "thread not found"));
app.post("/v1/threads/:id", (req, res) => {
  const t = threads.get(req.params.id);
  if (!t) return openaiError(res, 404, "thread not found");
  Object.assign(t.metadata, req.body.metadata ?? {});
  res.json(threadObject(t));
});
app.delete("/v1/threads/:id", (req, res) =>
  threads.delete(req.params.id) ? res.json({ id: req.params.id, object: "thread.deleted", deleted: true }) : openaiError(res, 404, "thread not found"));

app.post("/v1/threads/:id/messages", (req, res) => {
  const t = threads.get(req.params.id);
  if (!t) return openaiError(res, 404, "thread not found");
  const m = { id: `msg_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000), thread_id: t.id, role: req.body.role ?? "user", text: typeof req.body.content === "string" ? req.body.content : (req.body.content ?? []).map((p) => p.text?.value ?? p.text ?? "").join("\n"), metadata: req.body.metadata ?? {} };
  t.messages.push(m);
  res.json(msgObject(m));
});
app.get("/v1/threads/:id/messages", (req, res) => {
  const t = threads.get(req.params.id);
  if (!t) return openaiError(res, 404, "thread not found");
  res.json({ object: "list", data: [...t.messages].reverse().map(msgObject), first_id: null, last_id: null, has_more: false });
});
app.get("/v1/threads/:id/messages/:mid", (req, res) => {
  const t = threads.get(req.params.id);
  const m = t?.messages.find((x) => x.id === req.params.mid);
  if (!m) return openaiError(res, 404, "message not found");
  res.json(msgObject(m));
});

async function startRun(t, body) {
  const a = assistants.get(body.assistant_id);
  if (!a) return { error: `assistant '${body.assistant_id}' not found` };
  const r = {
    id: `run_${crypto.randomBytes(12).toString("hex")}`, object: "thread.run",
    created_at: Math.floor(Date.now() / 1000), thread_id: t.id, assistant_id: a.id,
    status: "queued", model: a.model ?? DEVIN_MODEL, instructions: body.instructions ?? a.instructions ?? null,
    tools: a.tools ?? [], metadata: body.metadata ?? {}, usage: null,
    expires_at: Math.floor(Date.now() / 1000) + 600,
  };
  runs.set(r.id, r);
  (async () => {
    r.status = "in_progress";
    try {
      const msgs = [
        ...(r.instructions ? [{ role: "system", content: r.instructions }] : []),
        // New-thread run: full history; continuing run: only latest user turn
        ...(t.messagesSent ? [{ role: t.messages.at(-1).role === "assistant" ? "user" : t.messages.at(-1).role, content: t.messages.at(-1).text }] : t.messages.map((m) => ({ role: m.role, content: m.text }))),
      ];
      const { text, usage } = await generateOne({ messages: msgs, model: r.model }, undefined, `thread:${t.id}`);
      t.messagesSent = true;
      const reply = { id: `msg_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000), thread_id: t.id, role: "assistant", text: applyPostHoc(text, {}), metadata: {} };
      t.messages.push(reply);
      r.status = "completed";
      r.completed_at = Math.floor(Date.now() / 1000);
      if (usage) r.usage = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens };
    } catch (e) {
      r.status = "failed";
      r.failed_at = Math.floor(Date.now() / 1000);
      r.last_error = { code: "server_error", message: e.message };
    }
  })();
  return r;
}

app.post("/v1/threads/:id/runs", async (req, res) => {
  const t = threads.get(req.params.id);
  if (!t) return openaiError(res, 404, "thread not found");
  if (!t.messages.length) return openaiError(res, 400, "can't execute run without messages");
  const r = await startRun(t, req.body);
  if (r.error) return openaiError(res, 404, r.error);
  res.json(r);
});
app.get("/v1/threads/:id/runs", (req, res) =>
  res.json({ object: "list", data: [...runs.values()].filter((r) => r.thread_id === req.params.id), first_id: null, last_id: null, has_more: false }));
app.get("/v1/threads/:id/runs/:rid", (req, res) => {
  const r = runs.get(req.params.rid);
  if (!r || r.thread_id !== req.params.id) return openaiError(res, 404, "run not found");
  res.json(r);
});
app.post("/v1/threads/:id/runs/:rid/cancel", (req, res) => {
  const r = runs.get(req.params.rid);
  if (!r || r.thread_id !== req.params.id) return openaiError(res, 404, "run not found");
  if (r.status === "queued" || r.status === "in_progress") r.status = "cancelling";
  res.json(r);
});
app.get("/v1/threads/:id/runs/:rid/steps", (req, res) =>
  res.json({ object: "list", data: [], first_id: null, last_id: null, has_more: false }));

// ---------------------------------------------------------------------------
// Conversations — trivial store backing the Responses `conversation` param.
// ---------------------------------------------------------------------------
const convs = new Map();
const convObject = (c) => ({ id: c.id, object: "conversation", created_at: c.created_at, metadata: c.metadata });

app.post("/v1/conversations", (req, res) => {
  const c = { id: `conv_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000), metadata: req.body?.metadata ?? {}, items: req.body?.items ?? [] };
  convs.set(c.id, c);
  res.json(convObject(c));
});
app.get("/v1/conversations/:id", (req, res) =>
  convs.has(req.params.id) ? res.json(convObject(convs.get(req.params.id))) : openaiError(res, 404, "conversation not found"));
app.post("/v1/conversations/:id", (req, res) => {
  const c = convs.get(req.params.id);
  if (!c) return openaiError(res, 404, "conversation not found");
  Object.assign(c.metadata, req.body.metadata ?? {});
  res.json(convObject(c));
});
app.delete("/v1/conversations/:id", (req, res) =>
  convs.delete(req.params.id) ? res.json({ id: req.params.id, object: "conversation.deleted", deleted: true }) : openaiError(res, 404, "conversation not found"));
app.get("/v1/conversations/:id/items", (req, res) => {
  const c = convs.get(req.params.id);
  if (!c) return openaiError(res, 404, "conversation not found");
  res.json({ object: "list", data: c.items, first_id: null, last_id: null, has_more: false });
});
app.post("/v1/conversations/:id/items", (req, res) => {
  const c = convs.get(req.params.id);
  if (!c) return openaiError(res, 404, "conversation not found");
  c.items.push(...(req.body.items ?? []));
  res.json({ object: "list", data: req.body.items ?? [], first_id: null, last_id: null, has_more: false });
});

// ---------------------------------------------------------------------------
// Embeddings — passthrough proxy. Devin exposes no embedding model; when
// EMBEDDINGS_UPSTREAM is set (any OpenAI-compatible endpoint, e.g. Ollama
// :11434/v1), requests proxy there verbatim. Otherwise honest 501.
// ---------------------------------------------------------------------------
const EMB_UPSTREAM = process.env.EMBEDDINGS_UPSTREAM ?? null;
const EMB_KEY = process.env.EMBEDDINGS_KEY ?? null;

app.post("/v1/embeddings", async (req, res) => {
  if (!EMB_UPSTREAM) {
    return openaiError(res, 501, "embeddings requires EMBEDDINGS_UPSTREAM (an OpenAI-compatible embeddings endpoint) — the Devin CLI exposes no embedding model", "unsupported_endpoint");
  }
  try {
    const r = await fetch(`${EMB_UPSTREAM}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(EMB_KEY ? { Authorization: `Bearer ${EMB_KEY}` } : {}) },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(60_000),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    openaiError(res, 502, `embeddings upstream failed: ${e.message}`, "upstream_error");
  }
});

// Remaining surface: explicit 501 instead of silent 404. These need
// infrastructure the backend doesn't have (audio models, training, websockets).
for (const p of [
  "/v1/audio/:rest", "/v1/fine_tuning/:rest", "/v1/vector_stores/:rest",
  "/v1/uploads/:rest", "/v1/realtime/:rest", "/v1/videos/:rest",
  "/v1/evals/:rest", "/v1/containers/:rest", "/v1/images/edits", "/v1/images/variations",
]) {
  app.all(p, unsupported(p));
}

app.listen(PORT, HOST, () => {
  console.log(`devin-openai-shim listening on http://${HOST}:${PORT}`);
  console.log(`model: ${DEVIN_MODEL} | transport: ${TRANSPORT} | config: ${SHIM_CONFIG} | mode: ${ACP_MODE} | concurrency: ${MAX_CONCURRENT} | auth: ${API_KEYS.size ? `on (${API_KEYS.size} key${API_KEYS.size > 1 ? "s" : ""})` : "off"}`);
});
