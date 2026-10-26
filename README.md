# devin-openai-shim

Local OpenAI-compatible API backed by the Devin CLI (SWE-2). The agent runs
**respond-only**: a dedicated permission config denies shell execution, file
edits, fetches, and MCP tools — no commands are ever run on your machine.

## Prerequisites

```bash
devin auth login   # one-time, browser flow
```

## Run

```bash
npm install
npm start          # http://127.0.0.1:8787
```

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/chat/completions` | OpenAI shape; `stream: true` returns a single-chunk SSE |
| GET  | `/v1/models` | Lists the configured model |
| GET  | `/health` | Queue/concurrency status |

## Example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"explain what a monad is"}]}'
```

Point any OpenAI client at `http://127.0.0.1:8787/v1` (any API key string
unless `SHIM_API_KEY` is set).

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `DEVIN_MODEL` | `swe-2-high` | Model passed to `devin --model` |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Bind address (keep localhost) |
| `SHIM_API_KEY` | unset (open) | If set, required as `Authorization: Bearer` |
| `MAX_CONCURRENT` | `2` | Parallel agent processes; excess requests queue |
| `DEVIN_TIMEOUT_MS` | `480000` | Per-request timeout |
| `DEVIN_BIN` | bundled CLI path | Override devin.exe location |

## Limitations

- Each request spawns a fresh agent — expect seconds of latency, not ms.
- No real token streaming; `stream` emits one chunk.
- Multi-turn history is flattened into a single prompt (no server-side memory).
- Confirm the exact model ID with `devin models list --format json` after login.
