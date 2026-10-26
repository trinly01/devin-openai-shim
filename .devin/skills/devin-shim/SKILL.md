---
name: devin-shim
description: Run, test, and modify the OpenAI-compatible API shim over the Devin CLI. Use when working on server.js, the permission config, or endpoint behavior.
---

# devin-openai-shim

Local OpenAI-compatible API (`/v1/chat/completions`, `/v1/responses`,
`/v1/models`, `/v1/catalog`, `/v1/files`, `/v1/batches`, `/v1/moderations`,
`/v1/images/generations`, `/v1/assistants`+`threads`+`runs`,
`/v1/conversations`, `/v1/embeddings` via proxy, `/health`) backed by the
Devin CLI running respond-only on SWE-2.

`/v1/responses` supports `instructions`, string/item-array `input`,
function tools, `previous_response_id` → resumes the same agent session
(real multi-turn), `stream` with the standard Responses event sequence,
`store`/`metadata` passthrough. Legacy `functions`/`function_call` params
normalize to `tools`/`tool_choice` in both endpoints.

## How it works

- Default transport is `devin acp` (`TRANSPORT=acp`): one long-lived JSON-RPC
  process over newline-delimited stdio. Sessions persist per conversation key
  (OpenAI `user` field or `x-session-id` header) → real multi-turn, and
  `session/update` chunks → real SSE streaming.
- Fallback transport `TRANSPORT=print` spawns `devin -p` per request
  (stateless, single-chunk stream, history flattened into the prompt).
- `SHIM_CONFIG` selects the permission profile passed via `--config`:
  `safe` (default, `devin-safe.json`) denies local `exec`/`edit`/`Write(**)`
  but **allows remote tools**: `mcp__*` (MCP servers in the CLI config —
  verified: Atlassian call returned real data) plus `web_search`/`webfetch`/
  `fetch`/`browser*` (verified: live web search). `readonly` also denies
  all of these — pure respond-only, no side effects anywhere.
  `Fetch(*)` is allowed in safe mode (browsing) but denied in readonly.
  The ACP layer additionally refuses every agent→client request
  (`fs/*`, `terminal/*`, `session/request_permission` → cancelled). Local
  machine stays read-only in both profiles — do not weaken either layer.
- `ACP_MODE` default is `smart` (tools available). `ask` mode exposes NO
  tools — remote actions are impossible in it.
- Emulations to know before debugging: `tools` are prompt-injected and parsed
  from a `{"tool_call":{...}}` reply; `stop`/`max_tokens` truncate post-hoc;
  `usage` is **real** on `acp` — `session/prompt` returns
  `inputTokens`/`outputTokens`/`totalTokens`/`cachedReadTokens` (surfaced
  incl. `prompt_tokens_details.cached_tokens`); `print` falls back to
  estimates flagged `estimated: true`. Sampling params are no-ops.
- Request `model` is validated: must equal `DEVIN_MODEL` or the shim returns
  `404 model_not_found`. (The ACP process is spawned with `--model` once, so
  per-request model switching isn't possible — no passthrough.)
- Multimodal input (acp only): `image_url` content parts → ACP `image` blocks
  (data: URLs decode directly; http(s) fetched shim-side, 15 s / 20 MB caps);
  `file` parts with text/* base64 inline as text. ACP `initialize` reports
  `promptCapabilities.image: true`, `audio: false` — whether the model
  *sees* images is backend-model dependent (SWE-2 accepts them; quality
  varies). Image delivery depends on the readonly `read` tool: the CLI saves
  pasted images to temp files and the agent reads them — do not deny `read`.

## Run / test

```bash
npm install
npm start                                # http://127.0.0.1:8787
K=$(sed -n 's/^SHIM_API_KEY_MAIN=//p' .env | tr -d '\r')   # key from .env
curl http://127.0.0.1:8787/health -H "Authorization: Bearer $K"   # smoke test
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

When `SHIM_API_KEY` is set it guards every route except `/v1/catalog` and
`/v1/images/serve/:id` —
requests without `Authorization: Bearer` get 401. Multi-key formats (combine):
comma-separated `name:key,name2:key2` on `SHIM_API_KEY`, or one per line
`SHIM_API_KEY_<NAME>=<secret>` (env files are line-based — no multi-line
values). Names identify callers in
the single-line `[access]` log (timestamp, key label, route, IP, `user`/
`x-session-id`) and `GET /v1/access` (per-key request count + last-seen).
Denials are logged too; `/health` and image-serve routes skip logging.

Requires `devin auth login` to have been run once — browser flow, the user
must do it (it reuses their existing Devin browser session; typically one
click, no password re-entry). The login menu is interactive — it needs a
real TTY, so on Windows an agent shell **cannot** drive it; the user must
run it in their own terminal (CMD/PowerShell: `& "<bundled path>" auth login`). **Devin Desktop sign-in does NOT satisfy
this** — Desktop and CLI keep separate credential stores. If
`devin auth status` says "Not logged in", nothing else will work. If
`devin` isn't on PATH on Windows, the bundled binary lives at
`%LOCALAPPDATA%\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe`.

## Platform notes

- **Windows**: `server.js` defaults `DEVIN_BIN` to the CLI bundled in Devin
  Desktop. Credentials at `%APPDATA%\devin\credentials.toml`; user config at
  `%APPDATA%\devin\config.json`.
- **macOS/Linux**: `DEVIN_BIN` defaults to `devin` on PATH (standalone
  installer). Credentials at `~/.config/devin/credentials.toml`; user config
  at `~/.config/devin/config.json`.
- Node 18+ on both. Everything else is platform-neutral.

## Extended surface (emulated where honest, 501 where not)

- `/v1/files` — real disk storage under `.data/files/` + `.data/files.json`
  index; multipart and JSON-base64 uploads.
- `/v1/batches` — real async JSONL processor over our own chat-completions /
  responses cores (`runChatCompletion`, `normalizeResponsesRequest` +
  `generateOne`); output becomes a `file-*`.
- `/v1/moderations` — one agent turn classifying into the omni category set.
- `/v1/images/generations` — model writes SVG; `b64_json` or `url` served by
  the shim (`/v1/images/serve/:id` is auth-exempt, unguessable IDs).
- `/v1/assistants|threads|runs` — in-memory stores; a run sends the thread
  through `generateOne` keyed `thread:<id>` → persistent session, then
  appends the assistant reply; `steps` returns `[]`.
- `/v1/conversations` — trivial store.
- `/v1/embeddings` — **proxy only**: set `EMBEDDINGS_UPSTREAM` (+ optional
  `EMBEDDINGS_KEY`) to any OpenAI-compatible endpoint; without it → 501.
- Still 501 by necessity: audio (`promptCapabilities.audio: false`),
  fine_tuning, vector_stores (needs real embeddings), realtime, uploads,
  videos, evals, containers, images/edits+variations.

## Env vars

`DEVIN_MODEL` (default `swe-2-high`), `TRANSPORT` (`acp`|`print`), `PORT`,
`HOST`, `SHIM_API_KEY`, `MAX_CONCURRENT` (print only), `DEVIN_TIMEOUT_MS`,
`SESSION_TTL_MS`, `DEVIN_BIN`, `SHIM_CONFIG` (default `safe` →
`devin-safe.json`; `readonly` → `devin-readonly.json`), `EMBEDDINGS_UPSTREAM`,
`EMBEDDINGS_KEY`, `ACP_MODE` (default `smart`), `ACP_CWD` (default temp dir —
the cwd becomes the workspace the coding persona names in replies, so don't
point it at a repo unless you want "let's work on &lt;repo&gt;" greetings).

## Public catalog endpoint

`GET /v1/catalog` is **exempt from `SHIM_API_KEY` auth** — it only exposes
`devin models list --format json` metadata (cached 5 min, stale-served on
CLI failure). Filters (composable): `?filter=all|free|paid|recommended`,
`?tier=free|low|med|high`, `?q=<substr>`. `recommended` = free tier or the
configured `DEVIN_MODEL`. Only `swe-2-{high,medium,max}` are `cost_tier:
"Free"`; everything else bills credits. `served: true` marks the model the
shim actually runs.

## Token optimization

- The CLI already does async compaction (`DEVIN_COMPACTION_THRESHOLDS` =
  `<spawn>,<apply>,<hard>` absolute token counts; `SIDEKICK_*` for fusion)
  and prompt caching internally — both tunable via env passthrough to the
  spawned child.
- The shim's own lever: conversation keys (`user` / `x-session-id` /
  `previous_response_id`) keep ACP sessions alive so only the new turn is
  sent. Stateless calls re-send flattened history — inherent to the OpenAI
  model, mitigated only by session reuse.
- `TRANSPORT=print` resends the full transcript per call; avoid for
  multi-turn workloads.

## Verified clients

Confirmed working end-to-end (chat + SSE streaming, 2026-10-26):

- **Directus 11** "OpenAI Compatible Provider":
  Base URL `http://127.0.0.1:8787/v1`, API Key = `SHIM_API_KEY` from `.env`,
  no custom headers, model `swe-2-high` (only ID the shim serves).
  If Directus runs in Docker use `http://host.docker.internal:8787/v1` —
  `127.0.0.1` inside a container doesn't reach the host.
- **curl** non-streaming and `stream:true` requests (see Run/test above).
- **Cloudflare Tunnel** → `https://ai.zyberlab.com/v1` verified end-to-end
  (health 200 with auth, 401 without) 2026-10-26.

## Public exposure (this deployment)

`ai.zyberlab.com` → Cloudflare Tunnel `devin-llm` (ID
`76820579-dde5-492b-826e-1a47fc7b03d4`) → `http://localhost:8787`. The
tunnel's ingress is **cloud-managed** (daemon logs `Updated to new
configuration` from Cloudflare, ignoring local yml edits) — add/remove public
hostnames in the Zero Trust dashboard or tunnel app, not the yml. Local
config: `%APPDATA%\com.administrator.tunnel-cloudflared-desktop\accounts\
zyberlab.com\devin-llm.yml`. Externally `HOST` stays `127.0.0.1`; the tunnel
is the only exposure and `SHIM_API_KEY` auth is what guards the public route.

## Reference documentation

For anything about the CLI itself — flags, permission-rule syntax, model IDs,
auth flows, sandbox behavior — **invoke the built-in `devin-cli` skill**. It
resolves the official bundled docs directory per platform automatically;
do not hardcode docs paths in this repo (they differ between the Windows
Devin Desktop bundle and the standalone macOS/Linux install).

Canonical topics and where they live in those docs:

- Permission syntax (`Exec`, `Read`, `Write`, `Fetch`, `mcp__*`, tool names):
  `reference/permissions.mdx`
- Global flags (`-p`, `--model`, `--config`, `--respect-workspace-trust`):
  `reference/commands.mdx`
- Config file format (`permissions`, `agent.model`): `reference/configuration/config-file.mdx`
- Model selection: `models.mdx`; auth: `enterprise/devin-auth.mdx`

## Gotchas

- `devin auth status` must show logged in before endpoints will respond.
- **`ACP_BACKEND` env var:** when set (always true inside Devin Desktop
  sessions/terminals), the CLI ignores `credentials.toml` and every command —
  including `auth status` — reports "Not logged in". `server.js` strips it from
  spawned children (`CHILD_ENV`); strip it too when checking auth from a
  Desktop shell: `env -u ACP_BACKEND devin auth status`.
- **Never call `authenticate` proactively.** `initialize` may advertise
  `authMethods` (e.g. `devin-browser`) even when stored credentials are
  already valid — calling it launches a browser PKCE flow inside a headless
  spawned process that never completes, blocking `ready` and hanging EVERY
  request until the timeout. Just attempt `session/new`; if it fails with an
  auth error, surface `devin auth login` as the remedy.
- **`devin acp` does not accept `--config`** (only `--model`, `--agent-type`,
  `--refusal-fallback`). `--config` is a global flag and must precede the
  subcommand: `devin --config devin-readonly.json acp --model ...`.
- ACP sessions are per-process: if `devin acp` exits, the shim recreates the
  session on next prompt and replays the flattened history once.
- ACP reference (method names, `session/update` chunk shape):
  https://agentclientprotocol.com — JSON-RPC 2.0, newline-delimited frames.
- In `print` mode, a permission prompt can't render — anything not
  auto-approved or denied may hang until `DEVIN_TIMEOUT_MS`. Keep the deny
  list complete.
- Verify the model ID with `devin models list --format json`.
- Restarting: killing the npm shell leaves `node server.js` alive holding
  port 8787 (`EADDRINUSE` on next start). Kill it by PID:
  `netstat -ano | findstr :8787` → `taskkill /PID <pid> /F`.
- **Cloudflare error 1033 / stale tunnel route:** a hostname CNAME'd to a
  *deleted* tunnel can't be re-pointed by name (`route dns` says "already
  configured" and skips). Fix: `cloudflared tunnel route dns
  --overwrite-dns <tunnel-ID> <hostname>` — the explicit ID bypasses the
  name-based ownership check. cert.pem authenticates tunnel ops but NOT
  general DNS/zone API calls (`Invalid request headers`), so record deletes
  still need the dashboard.
- `cloudflared` on Windows won't auto-update and warns it can't load the
  system CA pool — harmless for tunnels to localhost origins.
