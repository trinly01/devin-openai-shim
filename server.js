import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVIN_BIN =
  process.env.DEVIN_BIN ??
  String.raw`C:\Users\trinm\AppData\Local\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe`;
const DEVIN_MODEL = process.env.DEVIN_MODEL ?? "swe-2-high";
const READONLY_CONFIG = path.join(__dirname, "devin-readonly.json");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const API_KEY = process.env.SHIM_API_KEY ?? null;
const TIMEOUT_MS = Number(process.env.DEVIN_TIMEOUT_MS ?? 8 * 60 * 1000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);

const app = express();
app.use(express.json({ limit: "4mb" }));

app.use((req, res, next) => {
  if (!API_KEY) return next();
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: "invalid api key", type: "invalid_request_error" } });
  }
  next();
});

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

// Flatten OpenAI messages into a single prompt. Each devin -p call is a
// fresh agent, so history is replayed as transcript text.
function flattenMessages(messages) {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
        : m.content ?? "";
      return `${m.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function runDevin(prompt) {
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        const args = [
          "-p", prompt,
          "--model", DEVIN_MODEL,
          "--config", READONLY_CONFIG,
          "--respect-workspace-trust", "false",
        ];
        const child = spawn(DEVIN_BIN, args, { cwd: __dirname, windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`devin timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out.trim());
          else reject(new Error(`devin exited ${code}: ${err.trim() || out.trim()}`));
        });
      }),
  );
}

function completionPayload(text) {
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: DEVIN_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

app.post("/v1/chat/completions", async (req, res) => {
  const { messages, stream } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "messages array required", type: "invalid_request_error" } });
  }

  try {
    const text = await runDevin(flattenMessages(messages));

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const chunk = {
        id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: DEVIN_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      };
      const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    res.json(completionPayload(text));
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: "upstream_error" } });
  }
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: DEVIN_MODEL, object: "model", created: 0, owned_by: "cognition" }],
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, running, queued: queue.length }));

app.listen(PORT, HOST, () => {
  console.log(`devin-openai-shim listening on http://${HOST}:${PORT}`);
  console.log(`model: ${DEVIN_MODEL} | concurrency: ${MAX_CONCURRENT} | auth: ${API_KEY ? "on" : "off"}`);
});
