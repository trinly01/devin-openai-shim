import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows: resolve the CLI bundled inside Devin Desktop. macOS/Linux: assume
// the standalone `devin` binary is on PATH (set DEVIN_BIN to override either).
const DEVIN_BIN =
  process.env.DEVIN_BIN ??
  (process.platform === "win32"
    ? String.raw`C:\Users\trinm\AppData\Local\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe`
    : "devin");
const DEVIN_MODEL = process.env.DEVIN_MODEL ?? "swe-2-high";
const READONLY_CONFIG = path.join(__dirname, "devin-readonly.json");
const TRANSPORT = process.env.TRANSPORT ?? "acp"; // "acp" | "print"
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const API_KEY = process.env.SHIM_API_KEY ?? null;
const TIMEOUT_MS = Number(process.env.DEVIN_TIMEOUT_MS ?? 8 * 60 * 1000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 30 * 60 * 1000);

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

// Emulated function calling: describe tools in the prompt, ask for a JSON
// tool_call object, map it back to OpenAI shape.
function toolsPreamble(tools, toolChoice) {
  const specs = tools
    .filter((t) => t.type === "function")
    .map((t) => JSON.stringify(t.function))
    .join("\n");
  const mode = toolChoice === "required" ? "must" : toolChoice === "none" ? "must NOT" : "may, if needed,";
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
      function: {
        name: valid ? tool_call.name : tool_call.name, // pass through; hallucinated names still surface
        arguments: typeof tool_call.arguments === "string" ? tool_call.arguments : JSON.stringify(tool_call.arguments ?? {}),
      },
    };
  } catch {
    return null;
  }
}

function applyPostHoc(text, { stop, max_tokens }) {
  let out = text;
  for (const s of [].concat(stop ?? [])) {
    if (s) {
      const i = out.indexOf(s);
      if (i !== -1) out = out.slice(0, i);
    }
  }
  if (max_tokens) {
    // rough token cap: ~4 chars/token
    out = out.slice(0, max_tokens * 4);
  }
  return out;
}

const estimateTokens = (s) => Math.ceil((s ?? "").length / 4);

// ---------------------------------------------------------------------------
// Print transport: spawn `devin -p` per call. Stateless, no streaming.
// ---------------------------------------------------------------------------

function runDevinPrint(prompt) {
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        const args = [
          "-p", prompt,
          "--model", DEVIN_MODEL,
          "--config", READONLY_CONFIG,
          "--respect-workspace-trust", "false",
        ];
        const child = spawn(DEVIN_BIN, args, { cwd: __dirname, windowsHide: true, env: CHILD_ENV });
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
          else reject(new Error(`devin exited ${code}: ${err.trim() || out.trim()}`));
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
  constructor() {
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
      ["--config", READONLY_CONFIG, "acp", "--model", DEVIN_MODEL],
      { cwd: __dirname, windowsHide: true, stdio: ["pipe", "pipe", "inherit"], env: CHILD_ENV },
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
    }).then(async (res) => {
      // If the agent demands auth, take the first offered method.
      const method = res?.authMethods?.[0];
      if (method?.id) await this.request("authenticate", { methodId: method.id });
      return res;
    });
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
    const res = await this.request("session/new", { cwd: __dirname, mcpServers: [] });
    return res.sessionId;
  }

  async prompt(sessionId, text, onChunk) {
    if (onChunk) this.chunkHandlers.set(sessionId, onChunk);
    try {
      return await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } finally {
      this.chunkHandlers.delete(sessionId);
    }
  }
}

const acp = new AcpClient();

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

async function acpChat(convKey, messages, onChunk) {
  const s = getSession(convKey);
  // Serialize prompts per conversation.
  const prev = s.busy ?? Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    if (!s.sessionId) s.sessionId = await acp.newSession();
    // ACP sessions keep context — send only the new user turn if the session
    // already has history, else the flattened transcript.
    const text = s.hasHistory ? lastUserText(messages) : flattenMessages(messages);
    let acc = "";
    try {
      await acp.prompt(s.sessionId, text, (t) => { acc += t; onChunk?.(t); });
      s.hasHistory = true;
      return acc;
    } catch (e) {
      // Session may have died with a restarted acp process — recreate once.
      s.sessionId = await acp.newSession();
      s.hasHistory = false;
      acc = "";
      await acp.prompt(s.sessionId, flattenMessages(messages), (t) => { acc += t; onChunk?.(t); });
      s.hasHistory = true;
      return acc;
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

app.use((req, res, next) => {
  if (!API_KEY || req.path === "/v1/catalog") return next(); // catalog is public
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: "invalid api key", type: "invalid_request_error" } });
  }
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
    finish_reason: toolCall ? "tool_calls" : body.max_tokens && clean.length >= body.max_tokens * 4 ? "length" : "stop",
    _promptText: text,
  };
}

async function generateOne(body, onChunk, convKeyOverride) {
  const convKey = convKeyOverride ?? body.user ?? body.__sessionHeader ?? crypto.randomUUID();
  const msgs = [...(body.messages ?? [])];
  if (body.tools?.length && body.tool_choice !== "none") {
    msgs.unshift({ role: "system", content: toolsPreamble(body.tools, body.tool_choice) });
  }
  if (body.response_format?.type === "json_object") {
    msgs.unshift({ role: "system", content: "Respond with a single valid JSON object only. No prose, no markdown fences." });
  }
  return TRANSPORT === "acp" ? acpChat(convKey, msgs, onChunk) : runDevinPrint(flattenMessages(msgs));
}

app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body ?? {};
  body.__sessionHeader = req.headers["x-session-id"];
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError(res, 400, "messages is required and must be a non-empty array");
  }
  if (body.model && body.model !== DEVIN_MODEL) {
    return openaiError(res, 404, `model '${body.model}' not found (shim serves '${DEVIN_MODEL}')`, "model_not_found");
  }
  const n = Math.min(Math.max(body.n ?? 1, 1), 4); // cap: each choice = one agent run

  try {
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
      const created = Math.floor(Date.now() / 1000);
      const send = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: DEVIN_MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);

      send({ role: "assistant" });
      let first = true;
      const text = await generateOne(body, (t) => {
        if (first) { send({ content: t }); first = false; }
        else send({ content: t });
      });
      const choice = buildChoice(text, body);
      if (choice.message.tool_calls) send({ tool_calls: choice.message.tool_calls });
      send({}, choice.finish_reason);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const baseKey = body.user ?? body.__sessionHeader ?? crypto.randomUUID();
    const texts = await Promise.all(
      // n>1: each choice needs an independent session, not the shared convo
      Array.from({ length: n }, (_, i) => generateOne(body, undefined, `${baseKey}#${i}`)),
    );
    const promptTokens = estimateTokens(JSON.stringify(body.messages));
    const choices = texts.map((t, i) => buildChoice(t, body, i));
    res.json({
      id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: DEVIN_MODEL,
      choices: choices.map(({ _promptText, ...c }) => c),
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: texts.reduce((a, t) => a + estimateTokens(t), 0),
        get total_tokens() { return this.prompt_tokens + this.completion_tokens; },
      },
    });
  } catch (e) {
    if (res.headersSent) return res.end();
    openaiError(res, 502, e.message, "upstream_error");
  }
});

app.get("/v1/models", (_req, res) => res.json({ object: "list", data: [MODEL] }));
app.get("/v1/models/:id", (req, res) =>
  req.params.id === DEVIN_MODEL ? res.json(MODEL) : openaiError(res, 404, "model not found"),
);

// ---------------------------------------------------------------------------
// Public model catalog: `devin models list --format json`, cached 5 min.
// No auth — safe read-only metadata.
// ---------------------------------------------------------------------------
const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = null; // { at, data, stale }

function runModelsList() {
  return new Promise((resolve, reject) => {
    const child = spawn(DEVIN_BIN, ["models", "list", "--format", "json"], {
      cwd: __dirname, windowsHide: true, env: CHILD_ENV,
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("models list timed out")); }, 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `devin models list exited ${code}`));
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
    const filter = String(req.query.filter ?? "all").toLowerCase(); // all|free|paid|recommended
    const tier = req.query.tier?.toLowerCase();                     // free|low|med|high
    const q = req.query.q?.toLowerCase();
    const models = [];
    for (const fam of data.families ?? []) {
      for (const v of fam.variants ?? []) {
        const free = /free/i.test(v.cost_tier ?? "");
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
          served: v.model_uid === DEVIN_MODEL,
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
      filters: { filter, tier: tier ?? null, q: q ?? null },
      stale,
      count: models.length,
      data: models,
    });
  } catch (e) {
    openaiError(res, 502, `catalog unavailable: ${e.message}`, "upstream_error");
  }
});
app.get("/health", (_req, res) =>
  res.json({ ok: true, transport: TRANSPORT, running, queued: queue.length, sessions: sessions.size }),
);

// Everything else in the OpenAI surface: explicit 501 instead of silent 404.
for (const p of [
  "/v1/responses", "/v1/embeddings", "/v1/images/:rest", "/v1/audio/:rest",
  "/v1/files", "/v1/files/:id", "/v1/fine_tuning/:rest", "/v1/batches",
  "/v1/moderations", "/v1/assistants", "/v1/threads",
]) {
  app.all(p, unsupported(p));
}

app.listen(PORT, HOST, () => {
  console.log(`devin-openai-shim listening on http://${HOST}:${PORT}`);
  console.log(`model: ${DEVIN_MODEL} | transport: ${TRANSPORT} | concurrency: ${MAX_CONCURRENT} | auth: ${API_KEY ? "on" : "off"}`);
});
