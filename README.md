# devin-openai-shim

Local OpenAI-compatible API backed by the Devin CLI (SWE-2). The agent runs
**respond-only**: a dedicated permission config denies shell execution, file
edits, fetches, and MCP tools, and agent→client callbacks (fs, terminal,
permission requests) are refused at the protocol level — no commands are ever
run on your machine.

## Prerequisites

```bash
devin auth login   # one-time, browser flow — verify with `devin auth status`
```

> **Important:** signing into Devin Desktop does **not** log in the CLI —
> they keep separate credential stores (Desktop's is inside Electron app
> storage; the CLI's is `%APPDATA%\devin\credentials.toml` /
> `~/.config/devin/credentials.toml`). The browser flow reuses your existing
> Devin session, so it's typically one click, but it must be run once per
> machine. The token does not expire by default.

If `devin` isn't on PATH on Windows, use the bundled binary:

```bash
"C:\Users\<you>\AppData\Local\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe" auth login
```

## Platform compatibility

| | Windows | macOS / Linux |
|---|---|---|
| CLI binary | Resolved from Devin Desktop bundle automatically | `devin` must be on PATH (standalone installer) — or set `DEVIN_BIN` |
| Credentials | `%APPDATA%\devin\credentials.toml` | `~/.config/devin/credentials.toml` |
| User config | `%APPDATA%\devin\config.json` | `~/.config/devin/config.json` |
| Runtime | Node 18+ | Node 18+ |

Install the CLI on macOS/Linux with:

```bash
curl -fsSL https://cli.devin.ai/install.sh | bash
```

## Architecture

Two transports, selected by `TRANSPORT`:

| `acp` (default) | `print` |
|---|---|
| One long-lived `devin acp` process (JSON-RPC/stdio) | Spawns `devin -p` per request |
| Real streamed chunks | Single-chunk SSE (fake streaming) |
| Persistent sessions → real multi-turn | Stateless; history replayed as text |
| Recovers sessions after process restart | — |

## Run

```bash
npm install
npm start          # http://127.0.0.1:8787
```

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/chat/completions` | Full request surface; see compat matrix |
| GET  | `/v1/models` · `/v1/models/:id` | Lists the configured model |
| GET  | `/v1/catalog` | **Public (no auth)** — full account model catalog |
| GET  | `/health` | Transport, queue, live session count |
| ANY  | other `/v1/*` (embeddings, images, files…) | Explicit `501 unsupported_endpoint` |

### `GET /v1/catalog` — public

Proxies `devin models list --format json` (5-min cache). Query params
combine (AND):

| Param | Values |
|-------|--------|
| `filter` | `all` (default) · `free` · `paid` · `recommended` |
| `tier` | `free` · `low` · `med` · `high` — matches `cost_tier` |
| `q` | substring match on model id / label / family |

`recommended` is a shim-side heuristic: `cost_tier == "Free"` or the model
currently served (`served: true`). Each entry carries `free`,
`recommended`, `cost_tier`, `cost_summary`, `context_tokens`, `is_new`,
`is_beta`, `aliases`, `family`.

## Request compatibility

| Param | Behavior |
|-------|----------|
| `model` | ✅ validated — must equal `DEVIN_MODEL`, else `404 model_not_found` |
| `messages` | ✅ full roles incl. `tool` results |
| `stream` | ✅ real deltas (acp) / single chunk (print) |
| `n` | ✅ up to 4, each on an independent session |
| `user` / `x-session-id` | ✅ conversation key → persistent session (multi-turn) |
| `stop` | ✅ truncation on first match |
| `max_tokens` | ⚠️ post-hoc truncation (~4 chars/token) |
| `response_format: json_object` | ✅ prompt-enforced + JSON-only reply |
| `tools` / `tool_choice` | ⚠️ **emulated** — described in prompt, model replies `{"tool_call":{...}}` → mapped to OpenAI `tool_calls` |
| `temperature`, `top_p`, penalties, `seed`, `logprobs` | ❌ accepted, ignored — the CLI exposes no sampling controls |
| `usage` | ⚠️ estimated (~chars/4); the CLI doesn't report tokens |

## Example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $SHIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"explain what a monad is"}]}'
```

Point any OpenAI client at `http://127.0.0.1:8787/v1` (any API key string
unless `SHIM_API_KEY` is set — when set it guards **all** routes, including
`/health`).

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `DEVIN_MODEL` | `swe-2-high` | Model passed to `devin --model` |
| `TRANSPORT` | `acp` | `acp` (persistent, streaming) or `print` (spawn per call) |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Bind address (keep localhost) |
| `SHIM_API_KEY` | unset (open) | If set, required as `Authorization: Bearer` |
| `MAX_CONCURRENT` | `2` | Parallel agent runs (print transport); excess requests queue |
| `DEVIN_TIMEOUT_MS` | `480000` | Per-request timeout |
| `SESSION_TTL_MS` | `1800000` | Idle conversation eviction |
| `DEVIN_BIN` | per-OS default | Override devin binary location |

## Limitations

- No sampling controls exist on the backend — `temperature` etc. are no-ops.
- `usage` token counts are estimates.
- Function calling is prompt-emulated: good for simple clients, not
  guaranteed-format like OpenAI's constrained decoding.
- Confirm the exact model ID with `devin models list --format json` after login.
