# Neuretina

A modular, event-driven TypeScript service that periodically researches topics you care about,
compiles a neutral report, turns it into speech, and delivers it as a voice message.

Built on **Bun** (runtime, SQLite, HTTP server, cron), **TypeScript 7**, **Svelte 5**, and an
event bus that every subsystem publishes to from the ground up.

## How it works

```
scheduler (Bun.cron, jobs in SQLite)          Matrix message (reply chain resolved)
   └─> workflow runner: persists a run, dispatches triggers ──────────┘
        briefing workflow                          qa workflow
          research agent (code mode: writes one program per run)
            └─ run_code ─┬─ search.*       → Perplexity / Exa
                         ├─ finance.*      → Perplexity / Yahoo Finance
                         ├─ search.bluesky  → AT Protocol searchPosts
                         └─ past_reports     → SQLite report history
          compiler LLM → neutral markdown report + spoken narration
          follow-up subagents → implications/context → recompile
          Qwen3-TTS    → speech audio (local server)
          Matrix       → voice message (MSC3245)
                                                                       ▼
                            every step publishes typed events → EventBus → SQLite event log
                                                              │
                                          Svelte UI ◄─────────┴── WS /api/ws
                                            (commands, live events, live status)
```

### Architecture

| Layer | Location | Purpose |
| --- | --- | --- |
| Core | `src/core` | event bus + persisted event store, scheduler, workflow registry, workflow runner, trigger dispatcher, logger, errors |
| Capabilities | `src/capabilities` | provider-agnostic interfaces: `LlmProvider`, `SearchProvider`, `FinanceProvider`, `TextToSpeechProvider`, `MessagingProvider` |
| Providers | `src/providers` | concrete integrations (OpenAI-compatible LLM, Perplexity/Exa web search, Perplexity/Yahoo finance data, Bluesky, local Qwen3-TTS, Matrix; the ElevenLabs module is kept but unused) |
| Domain | `src/domain` | SQLite repositories: contexts, workflow runs, generic artifacts (reports and their audio are artifacts), topics, scheduled jobs |
| Agents | `src/agents` | generic `Agent` tool-calling runtime + `CodeModeTool` (sandboxed code mode) and the search/finance/report tools it wraps |
| Workflows | `src/workflows` | `BriefingWorkflow` (research → compile → TTS → delivery) and `QuestionWorkflow` (Matrix follow-up answers) |
| Command handlers | `src/commands` | application message handlers (contexts, topics, jobs, reports, workflows, runs) |
| API | `src/api` | bidirectional WebSocket for the UI (commands, events, status), webhook gateway for external ingress, static UI |
| UI | `web` | Svelte 5 + Vite frontend built on the **M3 Svelte** Material 3 design system |

Adding a provider means implementing one interface and wiring it in `src/kernel/Kernel.ts`.
Adding an agent capability means implementing `Tool` and passing it to an `Agent`.

### Swapping implementations

Everything the engine depends on externally sits behind a small interface, and
`src/kernel/Kernel.ts` is the only place that picks concrete implementations:

| Capability | Interface | Default implementation |
| --- | --- | --- |
| LLM text generation | `LlmProvider` (`src/capabilities/llm`) | `OpenAiCompatibleLlmProvider` (OpenCode Go) |
| Web search | `SearchProvider` (`src/capabilities/search`) | `PerplexitySearchProvider`, `ExaSearchProvider` |
| Social search | `SearchProvider` | `BlueskySearchProvider` |
| Financial data | `FinanceProvider` (`src/capabilities/finance`) | `PerplexityFinanceProvider`, `YahooFinanceProvider` |
| Speech | `TextToSpeechProvider` (`src/capabilities/tts`) | `QwenTtsProvider` (local server) |
| Messaging | `MessagingProvider` (`src/capabilities/messaging`) | `MatrixMessagingProvider` |
| Persistence | `EventLog`, `ArtifactStore`, `TopicStore`, `ReportStore`, `JobStore`, `KeyValueStore`, `ContextStore`, `WorkflowRunStore` | SQLite repositories (`src/domain`, `src/core/events`) |

`createKernel()` accepts overrides for every provider (`llm`, `searchProviders`, `socialSearch`,
`financeProviders`, `tts`, `messaging`) and for storage (`stores: { events, artifacts, topics, reports, jobs,
kv, contexts, runs }`) — override all stores and the kernel never opens SQLite (`kernel.db` is
`null`). No consumer imports a concrete provider or database: workflows, agents, tools and command
handlers only know the interfaces. Providers may implement an optional `verify()` (checked with
`isVerifiable`) so startup validation runs through the interface instead of reaching into config or
HTTP details.

### Code mode (efficient tool use)

The researcher does not call search tools one by one. It gets a single `run_code` tool and writes one
small JavaScript program per run. The program executes in a sandboxed Bun subprocess where the tools
are exposed as async functions — `search.perplexity`, `search.exa`, `search.bluesky`,
`finance.perplexity`, `finance.yahoo`, `past_reports`, `past_report` — and reaches the engine's real providers over a stdio bridge. Only the
program's return value and captured `console.log` output come back to the model, so searches run in
parallel with `Promise.all`, results are filtered, merged and trimmed in code, and just the compact
findings enter the model context. Tool calls never throw: a failed provider call resolves to
`{ error, results: [], reports: [], data: [], answer: "" }`, so one flaky search (a Bluesky 504, a
finance timeout) cannot abort the program — the code carries on with whatever succeeded. This is
the pattern behind Cloudflare's Code Mode and the CodeAct
paper: it removes the per-search model round-trip (and the intermediate results) that dominate token
and latency cost.

Guardrails: an inactivity timeout (60 s without progress) plus a hard wall-clock cap (3 min), a
tool-call budget (12 per program, plus the agent's own), clipped result and log sizes, and a screen
that rejects code touching `fetch`, `process`,
`Bun`, dynamic imports, `eval` and friends. The subprocess gets a stripped environment (no API keys)
and the worker removes network/process globals before evaluating the program. This is a sandbox of
convenience, not a hardened security boundary — model code still runs with the engine user's file
permissions, so the screening, budgets and timeout are the real controls. The follow-up Q&A agent
keeps direct tool calls, since it only needs one or two simple lookups.

### Artifacts (generic outputs)

Every workflow output is stored as a generic **artifact** in one `artifacts` table — text payloads
(markdown, JSON, plain text) and binary payloads (audio) alike. An artifact carries its `kind`,
`name`, `content_type`, `metadata` (JSON), the `workflow` and `correlationId` of the run that
produced it, its `contextId`, and an optional `parentId` pointing at the artifact it belongs to.
Nothing in the storage layer is report-specific; any future research workflow can persist its
outputs the same way.

Reports are the first typed view over that storage (`src/domain/reports/ReportRepository.ts`):

- the report is a `report` artifact: markdown as `content`, topics/narration/sources in `metadata`;
- its speech is an `audio` artifact whose `parentId` is the report, with `reportId`/`durationMs` in
  metadata;
- the report artifact references it back through `metadata.audioArtifactId`, and `report.get` /
  `report.list` expose both ids (`artifactId`, `audioArtifactId`), so everything is traceable
  end-to-end: workflow run → report artifact → audio artifact;
- deleting the report artifact cascades to its audio.

The generic surface is available over the webhook: `artifact.list` (filter by `kind`, `workflow`,
`parentId`, `correlationId`, `contextId`), `artifact.get`, `artifact.content`, `artifact.data`
(base64 data URL) and `artifact.delete`. `artifact.created` / `artifact.deleted` events carry the
artifact id, kind and parent, so the event log records every output of every run. The existing
`report.*` commands are a convenience view over the same rows. There is no migration from the old
`reports` table — nothing is deployed yet, so pre-artifacts databases are rejected at boot: delete
the database file and start fresh.

### Workflows, contexts and runs

Workflows are **code-registered** definitions (`src/workflows`, registered in
`src/kernel/Kernel.ts`) implementing the `Workflow` interface — an id, a description, an optional
`contextId`, optional extra trigger bindings, and a `run(input, context)` method. The registry only
stores definitions; execution lives in `WorkflowRunner`.

- **Contexts** are named scopes that own topics, scheduled jobs, workflow runs and artifacts (all
  carry a `context_id`). The first context is `default`; the briefing workflow and the
  seeded job live there. `context.list` returns each context with its topic/job/run/artifact counts.
- **Workflow runs** are persisted in `workflow_runs`: id (= the run's correlation id, which every
  event, status entry and artifact references), workflow, context, trigger kind, trigger detail,
  status (`running` / `succeeded` / `failed` / `skipped`), input, output, error and timestamps.
  Every trigger goes through `WorkflowRunner.start()`, which creates the record, publishes
  `workflow.started` / `workflow.finished` / `workflow.failed` (all carrying `contextId` and
  `trigger`), and finishes the record. A run whose output contains `{"skipped": true}` is marked
  `skipped` (the "nothing relevant found" path).
- **Triggers:** scheduled jobs (cron) and manual runs are implicit; workflows can add extra
  bindings, e.g. `QuestionWorkflow` binds `matrix` with `when: (detail) => detail.replyToBot`.
  `TriggerDispatcher.dispatch(kind, …)` fans a trigger out to every bound workflow and returns the
  finished runs; a failing workflow never breaks the others.
- **Per-run activity:** status entries carry the run's correlation id, and the Workflows UI tab
  filters the live activity feed to a single run and lists the artifacts it produced
  (`workflow.run.list`, `workflow.run.get` — the latter includes the run's artifacts). The top
  Activity card keeps showing the live overview of the newest run.

The Workflows tab is a drill-down: pick a workflow from the list (context filter on top, **Run
now** per workflow), then pick a run from that workflow's runs sidebar, then inspect the run —
live status feed, output/error preview and the artifacts it produced. Clicking an artifact opens
it in a right-hand drawer: reports render as markdown with citation pills, audio plays inline,
images preview, other artifacts show their text or metadata. `workflow.list`,
`workflow.run.list`, `workflow.run.get` and `workflow.run` (manual trigger, optional `contextId`)
are also available over the webhook.

## Quick start

```bash
bun install
cp .env.example .env        # fill in the keys (see below)
bun run dev                 # API on :8080
bun run dev:web             # Svelte dev server on :5173 (proxies /api)
```

Production-style run:

```bash
bun run build:web
bun run start
```

Quality gates:

```bash
bun run typecheck
bun test
```

## Integrations setup

LLM, web-search, finance and Bluesky credentials are **per-user settings** (Settings in the UI) and
cannot be set through the deployment environment; the notes below say what to obtain and where to
paste it.

### LLM (OpenAI-compatible)

- **Settings → LLM** manages the LLM connections: **Add connection** offers **OpenCode**
  (`https://opencode.ai/zen/go/v1`, model `deepseek-v4.1-flash`), **OpenAI**
  (`https://api.openai.com/v1`), **OpenRouter** (`https://openrouter.ai/api/v1`) and **Ollama**
  (`http://localhost:11434/v1`, no API key). One connection is one provider+model pairing; add
  several to switch models without retyping keys. Any other OpenAI-compatible endpoint (vLLM, a
  proxy, …) works too — pick the closest preset and edit the base URL and model. **Test** calls
  `GET {baseUrl}/models` through the connection (`llm.provider.verify`).
- **Active provider** is the one setting that picks which configured connection runs the agents,
  labelled `{provider} - {model}` (e.g. `OpenAI - gpt-5`); empty uses the first connection. While
  nothing is configured the engine falls back to the default OpenCode pairing, and the startup
  check reports the LLM as skipped.
- For OpenCode Go subscribe at https://opencode.ai/auth and paste the key into the connection.
  OpenCode endpoints require a client user agent and a stable `x-opencode-session` id per
  conversation; the engine detects `opencode.ai`/`opencode.com` and sends both automatically. Other
  endpoints only get the user agent.
- Connections (including API keys) are stored as user settings, so **export/import configuration**
  carries them to another installation.
- `bun run check:llm` sends one tiny completion through the active connection to verify the
  key/endpoint end-to-end.

### Decision models (Jev / Clef)

The engine uses a **decision model** where a step needs one calibrated choice instead of generated
text — today the event tag step of the briefing pipeline (pick an existing tag, or ask for a new
one). Besides the optional local Laya model (source runs only), hosted connections are configured
in **Settings → Decision models**:

- **Add connection** offers the two providers that share the Jev/SystemOne API:
  - **TypeSafe (Jev)** — endpoint `https://api.typesafe.ai/v1/systemone`, model `jev-latest`,
    authenticate with a TypeSafe API key.
  - **Cloudflare (Clef)** — the account's Workers AI run endpoint
    (`…/accounts/<account>/ai/run/@cf/cloudflare/clef`), model `clef` or `clef-flash`,
    authenticate with a Workers AI API token.
  Any other server speaking the same state-plus-typed-questions API works too (edit the endpoint).
- **Active model** is the one setting that picks which configured connection decides. Options are
  labelled `{provider} - {model name}` (e.g. `TypeSafe - jev-latest`). Empty uses the local Laya
  model when available, otherwise the LLM categorizer; an unavailable or failing model always falls
  back the same way, so a dead endpoint never breaks a run.
- **Test** sends one cheap yes/no question through the connection (`decision.model.verify`) and
  reports the provider's answer or its error inline.
- Connections (including API keys) are stored as user settings, so **export/import configuration**
  carries them to another installation. Laya itself stays configured through the `LAYA_*`
  environment variables and only runs from source: the Docker image ships neither the model nor
  the ONNX runtime, so pull it with `bun run laya:pull` and run locally to use it.

### Web search (Perplexity, Exa)

- **Settings → Web search** manages the web-search connections: **Add connection** offers
  **Perplexity** (`https://api.perplexity.ai`) and **Exa** (`https://api.exa.ai`), each with its own
  API key. One connection per provider; **Test** runs a cheap probe query through the connection.
- **Active provider** picks which configured connection the single-search call sites use (the
  Wikipedia tool, the startup check and fallbacks); empty uses the first connection. Every
  configured provider still becomes its own `search.<provider>` tool (`search.perplexity`,
  `search.exa`), so the researcher can cross-check both indexes in one program.
- Perplexity: create an API key at https://perplexity.ai and paste it into the connection.
- Exa: request a key at https://exa.ai; Exa's neural/keyword index is independent of Perplexity's.
- **Web search:** the agent calls `POST {baseUrl}/search` and receives raw ranked results
  (`title`, `url`, `snippet`, `date`) — no LLM answer in the loop. Searches are limited to the last
  3 days (`DEFAULT_SEARCH_RECENCY`, one of `hour`/`day`/`3days`/`week`/`month`/`year`; the 3-day
  window uses Perplexity's publication-date filter) and to English
  (`DEFAULT_BRIEF_LANGUAGE` → `search_language_filter`).
- **Reputable-source filter:** Perplexity searches send its `search_domain_filter` allowlist, so
  results come from Wikipedia, major wires and outlets with strong correction records, quality
  tech/science press and `.gov` primary sources. Root domains match their subdomains and `.gov`
  matches the whole TLD. Exa connections take the same allowlist as exact `includeDomains` entries
  (TLDs and paths cannot be expressed there and are dropped). Tune it with `DEFAULT_SEARCH_DOMAINS`
  (comma-separated, max 20) or set it to `off` to search the whole web; the researcher can also
  pass `scope: "open"` per query when a topic needs an official or niche page (release notes, docs).
- Bluesky is always available as `search.bluesky`.
- Connections (including API keys) are stored as user settings, so **export/import configuration**
  carries them to another installation.

### Finance data (Perplexity, Yahoo Finance)

- **Settings → Finance data** manages the finance connections: **Add connection** offers
  **Perplexity** (`https://api.perplexity.ai`, Agent API model `perplexity/glm-5.3-flash`) and
  **Yahoo Finance** (`https://query1.finance.yahoo.com`, no API key). One connection per provider;
  every configured provider becomes its own `finance.<provider>` tool (`finance.perplexity`,
  `finance.yahoo`). **Test** runs one live lookup.
- **Perplexity** uses the Agent API (`POST {baseUrl}/v1/agent`) with the `finance_search` tool,
  which returns a synthesized answer plus structured data — quotes, financial statements, earnings,
  guidance, analyst estimates, ownership — with citation-ready `perplexity.ai/finance/…` source
  links that flow into the report's source list. The default model `perplexity/glm-5.3-flash` is the
  best open-weight model on Vals AI Finance Agent v2 (57.9%, ahead of DeepSeek V4 Pro 0813 at
  50.4%, Kimi K3 at 54.4% and MiniMax M3 at 48.3%) and the cheapest capable option. The research
  agent and compiler keep running on the active LLM provider (`deepseek-v4.1-flash` by default).
- **Yahoo Finance** is keyless: the public search endpoint resolves tickers from the question and
  the public chart endpoint returns price, change, day and 52-week ranges, volume and the quote
  timestamp; sources link to `finance.yahoo.com/quote/<ticker>`.
- Perplexity finance lookups are a beta, per-invocation billed tool (see Perplexity's docs) and
  must be enabled for your key; if a lookup fails the researcher continues with web/social results
  and the error is visible in the activity feed.

### Speech (Qwen3-TTS or ElevenLabs)

Speech is a per-user choice: **Settings → Speech → Provider** picks `qwen` (local) or
`elevenlabs`. Both implement the same `TextToSpeechProvider` protocol, so workflows, delivery and
the UI are provider-agnostic. All speech settings below are per-user UI settings; the environment
cannot set them.

**Qwen (local, default):** a local Qwen3-TTS server speaking the OpenAI `POST /audio/speech`
interface — no text leaves the machine. Any of the common servers works: vLLM-Omni
(`vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --omni`), Qwen3-TTS-Openai-Fastapi,
qwen3-tts-server, or a similar wrapper.

- `QWEN_TTS_BASE_URL` — server base URL including `/v1` (required; e.g.
  `http://127.0.0.1:8880/v1`). Speech is skipped entirely when it is unset, and reports are
  delivered as text.
- `QWEN_TTS_MODEL` — model name; most local servers accept and ignore it (`tts-1`).
- `QWEN_TTS_VOICE` — preset speaker (`Ryan`, `vivian`, `serena`, …) or an OpenAI alias
  (`alloy`, `nova`, …); the server maps aliases.
- `QWEN_TTS_FORMAT` — `opus` (default) renders as a native voice bubble in Matrix clients;
  `wav`/`mp3`/`flac`/`aac`/`pcm` also work. Many local servers ignore the format and always
  return WAV; the engine detects that and converts to Ogg/Opus with ffmpeg when ffmpeg is on
  `PATH` (falling back to the server's audio if it is not).
- `QWEN_TTS_SPEED`, `QWEN_TTS_LANGUAGE` (e.g. `English`) and `QWEN_TTS_API_KEY` are optional.
- `QWEN_TTS_TIMEOUT_MS` (default 600000) bounds one synthesis request. CPU inference runs several
  times slower than real time (a GGML 0.6B model manages roughly 5-6x real time on a 12-core
  desktop CPU), so a report can take minutes; GPU servers answer in seconds.
- Some GGML-based servers (e.g. `qwentts.cpp`) reject `response_format: "opus"` and only serve
  `wav`/`pcm`. Keep `QWEN_TTS_FORMAT=opus` and set `QWEN_TTS_REQUEST_FORMAT=wav`: the server is
  asked for WAV and the engine converts it to Ogg/Opus locally with ffmpeg, so the Matrix voice
  bubble still works. Without ffmpeg the WAV is delivered unchanged.
- The local ffmpeg is discovered on `PATH`; `FFMPEG_PATH` pins an explicit binary (handy when the
  server process was started before ffmpeg was installed).
- `bun run check:tts` verifies the endpoint (`GET /models`) and synthesizes one short sentence.
- Resilient by default: transient failures (429/5xx, network errors) are retried twice with
  backoff and error messages include the server's own explanation. If speech generation still
  fails, the compiled report is **delivered as a text message instead** — a flaky TTS call never
  throws away a good report.

**ElevenLabs:** set the provider to `elevenlabs` and add `KEY_ELEVENLABS` (plus optionally
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_SPEED`) in the same settings group. The
provider speaks the same protocol, so nothing else changes.

The ElevenLabs provider module is kept in the repo but unused; its `ELEVENLABS_*` settings are
ignored.

### Bluesky / AT Protocol search

What you need:

1. A Bluesky account (a dedicated bot account is fine) and its **handle** — paste it in
   **Settings → Bluesky**.
2. An **app password** for that account — same settings group.
   Create it in Bluesky: *Settings → App Passwords → Add App Password* (format `xxxx-xxxx-xxxx-xxxx`).
3. **No PDS URL needed.** Leave it empty and the provider auto-discovers the PDS
   from the account's DID document (`plc.directory` / `did:web`). This works whether the account is
   hosted on `bsky.social`, on a shard like `*.host.bsky.network`, or on a third-party PDS. Set it
   explicitly only if you want to pin a specific host.

   To answer the obvious question: `https://bsky.social` is the *entryway* and still works for
   Bluesky-hosted accounts, including shard-hosted ones (`auriporia.us-west.host.bsky.network`) —
   the entryway routes the login to the right shard. Auto-discovery makes the choice irrelevant.

The provider logs in with `com.atproto.server.createSession`, refreshes the session automatically,
and searches via `app.bsky.feed.searchPosts` on your PDS (the officially recommended route for
authenticated reads). Transient upstream failures (502/503/…) are retried with backoff, and if the
PDS search endpoint still fails the provider falls back to the public AppView instead of failing
the whole research run.

Without credentials it falls back to the public AppView, but Bluesky currently load-sheds
unauthenticated `searchPosts` with `HTTP 403`, so app-password auth is strongly recommended.

### Delivery channels

Reports are delivered through configurable **delivery channels** (Settings → Delivery tab; the
former `MATRIX_*` environment variables are gone — on the first boot after an upgrade the old
Matrix configuration is migrated into a channel automatically). Three channel types exist:

- **Matrix** — config: `homeserverUrl`, a delivery target — `roomId`, or `dmUserId` (a
  `@user:server` Matrix ID: the bot opens the DM room with that user on the first delivery and
  reuses it afterwards, tracked via its `m.direct` account data) — and credentials (`accessToken`
  **or** `username` + `password`), plus an optional `allowedSenders` list (comma-separated Matrix
  IDs; empty allows anyone in the room). The app logs in with `m.login.password` on first use and
  caches the token (re-login on 401). Many newer clients (including Sable) no longer show the
  access token in their settings UI, so the reliable way is the login API:

  ```bash
  curl -X POST https://matrix.illegal.trading/_matrix/client/v3/login \
    -H "Content-Type: application/json" \
    -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"bot"},
         "password":"your-password"}'
  ```

  The response contains `access_token` — use that. (Synapse also accepts an app/user access
  token created via admin tooling.) A static token never expires unless the server expires it.

  **Quoting warning (when pasting a password from a `.env` file):** Bun expands `$VAR` inside
  `.env` values **regardless of quoting** — a password like `Correct$Horse#1` is silently altered
  on load ("Invalid identifier or password" at login). Write literal `$` as `\$` and quote values
  containing `#` (in Coolify, set values in the UI instead — they are passed as-is).

  **Important:** the room must **not be end-to-end encrypted**. A plain HTTP bot cannot produce
  Megolm keys; E2EE rooms would require a full crypto stack. Create an unencrypted room (or an
  unencrypted DM) for deliveries. At delivery time the audio is uploaded via the authenticated
  media API (`/_matrix/client/v1/media/upload`, legacy fallback included) and sent as an
  `m.audio` message annotated with `org.matrix.msc3245.voice` (plus `org.matrix.msc1767.audio`
  duration), which Element and other clients render as a voice message with waveform/play button.

- **Discord** — config: `webhookUrl`. Text is posted as the webhook message content (truncated to
  Discord's 2000-character limit); the delivery event id is the created message id. Discord
  channels receive text only — the voice pass delivers the summary with a note instead of audio.

- **Email** — config: `host`, `port?`, `secure?`, `username?`/`password?`, `from`, `to` (SMTP via
  nodemailer). The summary goes out as text (+HTML when available); the voice pass attaches the
  audio file.

Channels are attachable to **step outputs** (`workflow_delivery_channels`, several channels per
output and several channels of the same type are fine; the Workflows tab shows a "Send to" switch
per deliverable output). The briefing workflow delivers the summary as formatted text, the voice
message when speech synthesis succeeded, and — when a channel is assigned to the Timeline output —
the timeline as a monospace code block: aligned dates and times in plain text, wrapped in
`<pre><code>` for Matrix and email. Each pass records one delivery row per channel with its status
(`delivery.list`). `delivery.channel.verify` runs a live pre-flight (Matrix identity + room
membership, webhook reachability, SMTP handshake).

Every step of a customizable workflow also carries a **Stop after here** switch: the run executes
everything up to and including that step, delivers its outputs, and starts no later step. The
editor collapses the remaining steps into a "N steps not enabled due to stopping step" summary.
The stop step is stored on the user workflow row (`stop_after`) and can be cleared at any time.

### Matrix chat commands

When a matrix delivery channel exists, the bot listens in its room via `/sync` long-polling and
reacts to text messages:

| Command | Effect |
| --- | --- |
| `/start <task id or name>` | runs a scheduled task immediately (off schedule); replies again when it finishes or fails |
| `/list` | lists scheduled tasks (name, workflow, cron, state, short id) and workflows |
| `/status` | shows integration configuration status |
| `/help` | usage |

Details: the sync position is persisted (SQLite `kv` table), so restarts never replay history or
re-execute old commands; the bot ignores its own messages; the channel's `allowedSenders` config
can restrict who may issue commands — by default anyone in the room can. Sync errors back off
and resume automatically, and a re-login transparently resets the sync position.

**Follow-up questions:** every allowed message is handed to the trigger dispatcher (plain messages
are still treated as commands). The `qa` workflow is bound to Matrix messages that are replies to
(quotes of) one of the bot's own messages — the report summary, a notice, or one of its answers —
and answers with a short **text** answer, never a voice message. The trigger resolves the whole
reply chain (`m.in_reply_to` upwards, capped at 10 events / 8k characters, oldest first) and
passes it to the workflow, so "what about that?" still has a referent. The qa workflow is a normal
persisted run: it appears in the Workflows tab with its activity and artifacts, and a failed run
gets a "Sorry, I couldn't answer that: …" reply.

### Web UI

The frontend is built entirely on the [M3 Svelte](https://github.com/KTibow/m3-svelte) Material 3
design system (buttons, text fields, lists, tabs, cards, chips, snackbars), themed with the M3
baseline palette in light and dark mode (`web/src/app.css`) plus the Google Sans Flex font.
Only truly custom pieces are hand-styled (the dense event log and the audio element), and even
those use the M3 design tokens.

The whole app is a full-width three-pane layout: a navigation rail on the left (sections plus a
single engine-health pill — green `Online` when the event stream is live and every integration is
configured, amber `Partial` when the stream is live but integrations are missing, red `Offline`
when the live event stream is down), a content list in the middle, and a details pane on the right.
Lists never overflow their rows: long names, overlines and supporting lines ellipsize.

The **Settings tab** edits integration keys, URLs, models and research defaults. Values are stored
in the SQLite key/value store and applied immediately (the kernel rebuilds its providers on save).
The environment always wins: a `.env` variable shadows the database value, rows overridden this way
show an amber warning icon (hover explains which variable wins), and **Reset** deletes the stored
override so the value falls back to `.env` or the built-in default.

**Every navigation state lives in the URL** (`web/src/lib/router.svelte.ts`, history API, no hash):
the active tab, the open item and the filters are path segments and query parameters, e.g.
`/reports/<id>?source=…`, `/topics/<id>`, `/jobs/<id>`, `/artifacts/<id>?q=…`,
`/events/<id>?topic=…` and `/workflows/<workflow>/<run>?context=…&artifact=…`. Links are shareable —
opening a workflow-run or artifact URL lands directly on it — and browser back/forward work
throughout. **Run now** (Reports, Scheduled tasks and Workflows) jumps straight to the new run, so
its live activity starts streaming without any extra clicks; `workflow.run` / `job.run` return the
run id before the run finishes so the UI can navigate to it.

The Reports list shows each report with colour-coded badges (topic count, source count, audio
availability). The details view shows the full summary, plays the stored audio, offers
**Re-send** to deliver the report through delivery channels again (formatted summary + voice),
**Generate voice**
for text-only reports, and can **delete** a report behind an M3 confirmation dialog.

The Workflows tab shows contexts, workflow definitions (with **Run now**), recent runs and — when
you open a run — its live per-run activity feed, output/error preview and the artifacts it
produced. Run status is shown as a single icon: a spinner while running, a green check when done,
a grey skip icon when nothing was found, a red error icon when it failed. A run can be cancelled
while it is running (`workflow.run.cancel`, or the **Cancel** button in the run detail): the
workflow stops at its next checkpoint — in-flight provider calls are aborted where possible — and
then the run and every artifact it produced so far are deleted. A run can also be deleted behind a
confirmation dialog that asks whether its artifacts should go with it (kept artifacts stay in the
Artifacts tab). The Activity card at the top keeps showing the live overview of everything running.
Run activity is persisted in SQLite, so a run's feed is still there after a restart; anything that
was mid-flight when the process stopped is marked as interrupted.

The Artifacts tab lists every workflow output with a text search over content, names and metadata.
Opening an artifact renders it (markdown reports with citation pills, inline audio, image previews,
text or metadata) and offers **Open run** to jump to the run that produced it and **Delete** to
remove it (children like a report's audio go with it). The same view backs the artifact drawer in
the Workflows tab.

## Topics and scheduled tasks

- **Topics** are managed in the UI (or by sending `topic.create` / `topic.update` /
  `topic.delete` / `topic.list` through the webhook), including a **mute toggle** in the list and
  the details pane — muted topics are excluded from every briefing until unmuted. One LLM-planned
  research run covers all topics at once (they may overlap), the compiler merges everything into a
  single report, and the researcher can pull concrete market numbers (quotes, revenue, margins,
  guidance, estimates) through the finance tools (Perplexity's Agent API, or keyless Yahoo Finance
  quotes) when a topic involves a public company or the markets.
- **Delivery is two messages by default:** the compiled summary as a formatted text message
  (markdown rendered to Matrix `formatted_body`) followed by the voice message. The summary is
  written for spoken delivery under a hard brevity budget (under ~150 words) — the compiler is
  TTS-aware (speakable sentences, symbols written out, everyday expressions kept neutral) and the
  narration is derived from the summary itself, so the audio reads the same text minus the links.
- **Anonymous report links:** delivered summaries append a "View this Report" link carrying a
  per-report token (`APP_URL/reports/<id>?token=…`). Recipients without an account open that report
  in a read-only view with no navigation; the token unlocks that one report only.
- **Inline citations:** the compiler receives the numbered source list together with the research
  notes and cites every factual claim with a marker like `[4]`. The UI renders those markers as
  small clickable numbered pills linking to the source, and the Matrix text message turns them
  into clickable links. The markers are stripped from the spoken narration automatically, and the
  grouped source list below the report stays as the full reference.
- **Voice is optional per run:** scheduled tasks accept `{"generateAudio": false}` (the Jobs UI
  has a mic toggle at creation and per task) — text-only runs skip TTS entirely and deliver just
  the formatted summary. The Reports view only reads and manages stored reports.
- **Voice on demand:** a text-only report can get its audio later from the Reports view
  (*Generate voice*) or via `report.audio.generate { id }` — the speech is generated, stored, and
  automatically sent to Matrix as a voice message. `regenerate: true` forces new audio,
  `deliver: false` only generates. The Reports view also has a **Re-send** button, and
  `report.send { id }` does the same over the webhook.
- **Relevance-checked research:** the researcher agent finishes with a `{"found": <bool>, "notes":
  …}` verdict, and its tool budget is capped. Search engines return junk even for nonsense
  queries, so if no topic yields *relevant* material the workflow writes **no summary and sends
  no audio** — instead you get a plain text notice listing the topics and the exact queries that
  were tried. Topics that found nothing are marked as missing when other topics did have
  material. The same notice path is used when the agent runs out of steps or returns empty notes,
  and the compiler is never allowed to store an empty report.
- **Follow-up research:** once the first draft exists, a planner model looks for claims that deserve
  a deeper look — implications, causes, missing context — and dispatches up to three subagents (one
  question each). Every subagent can use Wikipedia, the reputable web search, social search and past
  reports and returns compact findings with attributions; their sources are merged into the report's
  source list and a short **"Implications" section is appended** to the report — which is also read
  aloud with the rest. If nothing qualifies, or the follow-ups find nothing, the draft is kept
  unchanged, and a failed follow-up never throws away a good report.
- **Primary-source upgrades:** after the implications are settled, one more research agent hunts for
  **primary sources** behind the report's claims — the official announcement, company blog or IR page,
  filing, documentation or government publication instead of the news coverage about it. When it
  finds one it replaces the matching entry in the source list (citation numbers stay stable) and may
  adjust the claim's wording to match the primary source more precisely. Source counts and the word
  budget are capped, and a failed or fruitless pass always keeps the draft as it is.
- **Cost tracking:** every workflow step reports what it spent. Costs are never configured: a line
  is priced only when the provider reports an exact cost with the response (Perplexity search and
  finance do; Exa and Yahoo Finance do not), otherwise the usage is recorded as unpriced. Free
  social search is not tracked. The per-step breakdown is stored on the run, and the run activity
  feed shows each task's cost sum (unpriced usage counts as $0.00).
- Disable both post-draft passes with `DEFAULT_FOLLOWUP_RESEARCH=false`.
- **Scheduled tasks** live in SQLite and use `Bun.cron` (standard 5-field expressions, in the
  server's `TZ`). Runs never overlap; every run's result is recorded and every step is emitted as
  an event.
- On first boot a default job for the first registered workflow is seeded with `DEFAULT_BRIEF_CRON`
  (default daily 07:00). Edit it in the UI, or create additional tasks — any registered workflow
  can be scheduled (currently `briefing`).
- Workflows accept an input object, e.g. `{"topics": ["Rust"], "deliver": false}` for a
  research-only run.

## Message gateway

There are **no REST endpoints**. Data flows two ways: one bidirectional WebSocket for the UI, and
an HTTP webhook for external systems.

- **`/api/ws`** — the one WebSocket, used by the UI for everything. The client sends commands as
  `{ id, type, payload }` frames and the server answers with `{ type: "result", id, result }` or
  `{ type: "error", id, error, code }`. The same socket pushes the ephemeral live status feed
  (see "Live activity feed") **and every persisted domain event as it happens**; after a
  reconnect the client backfills the gap with `event.pull { since }`. The UI never polls and never
  calls an HTTP command endpoint.
- **`POST /api/webhook`** — the external ingress: integrations and scripts post messages here and
  receive the handler result in the HTTP response. `GET /api/webhook` returns `200` with the
  available message types and doubles as the liveness probe.

Message envelope (identical for webhook messages and WebSocket commands):

```json
{ "type": "topic.create", "payload": { "name": "Rust" }, "correlationId": "optional-uuid" }
```

The gateway publishes `message.received` (audit, except for read-only types; its `source` names the
ingress, `ui` or `webhook`) and dispatches the message to its handler. Over HTTP the result comes
back **in the same response**:

```json
{ "ok": true, "type": "topic.create", "correlationId": "…", "result": { "id": "…" } }
```

Triggers answer before the work is done: `workflow.run` and `job.run` return
`{ started: true, runId, … }` — the run is persisted synchronously, so the id can be fetched
(`workflow.run.get`) or linked right away.

HTTP errors use proper status codes (`400` validation, `404` unknown type, `502` provider failure)
with `{ "ok": false, "error": "…", "code": "…" }`; the WebSocket reports the same `error` and
`code` in its error frame. Types starting with `hook.*` are fire-and-forget: they are forwarded to
the bus as `hook.<channel>` events and answered with `202` (or an accepted result frame).

Read-only message types (`event.*`, `*.list`, `*.get`, `artifact.search`, `report.audio`,
`config.get`) are "quiet": they generate no audit events, so streaming/polling can never feed
itself. Settings edits (`settings.set/clear`) are quiet too — their payload carries secrets, so the
change is audited through the value-free `settings.updated` event instead.

Built-in message types: `config.get`, `settings.list/set/clear`, `context.list`,
`topic.list/create/update/delete`, `job.list/create/update/delete/run`,
`workflow.list/run/run.list/run.get/run.delete`, `report.list/get/audio/audio.generate/send/delete`,
`artifact.list/search/get/content/data/delete`, `timeline.event.list`, `event.pull`. Adding one is
`router.register("my.type", handler)` in `src/commands/registerCommands.ts`.

## Live activity feed

The `/api/ws` WebSocket pushes a status feed to the UI (broadcast by
`src/core/status/StatusHub.ts`, persisted through `status_entries` so it survives restarts)
alongside the commands and domain events it already carries:

- On connect the client receives a `snapshot`, then incremental `entry` messages.
- Entries cover coarse workflow spans (`Researching "<topic>"`, `Compiling report`,
  `Generating speech`, follow-up spans, job lifecycle, skipped/failed notices) **and every tool
  call made inside a step**: each `agent.tool.*` invocation becomes a `tool` child entry with its
  full input and output. Code-mode programs keep the attempted code in the entry's input, and the
  sandbox's own tool calls are nested under the `run_code` entry.
- Follow-up questions stay visible after completion: the question is kept as the span's detail
  (and in the finished text), with the research agent's tool calls nested underneath.
- Running entries show an animated M3 spinner; the list is **strictly chronological top to
  bottom** (running and settled interleaved by start time), with sub-activities indented under
  the span that owns them.
- Tool entries render collapsible **Input & output** sections (code shown as a code block,
  failures expanded by default); task details (e.g. the follow-up question) render inline.
- When nothing is running the header chip shows `idle`, otherwise the running count.
- The feed keeps the last ~500 entries, auto-reconnects, and re-syncs via snapshot. If the
  WebSocket is unavailable (stopped backend, strict proxy), the UI simply shows no live status;
  everything else keeps working.

## Startup validation

On boot (controlled by `STARTUP_CHECK`, default `true`) the engine validates every configured
integration. The results are logged and shown in the activity feed; with `STARTUP_ANNOUNCE=true`
(default **off**) a summary is also sent as a text message to the Matrix room:

- `llm` — `GET /models` on the LLM endpoint (no tokens spent)
- `web-search` — the first configured web-search connection: a cheap probe query where the
  provider supports one, otherwise a single live search
- `bluesky` — a real `searchPosts` call through the PDS (skipped in public mode)
- `tts` — the local Qwen3-TTS server answers on `{QWEN_TTS_BASE_URL}/models`
- `matrix` — active pre-flight against the first enabled matrix delivery channel: resolves
  credentials (login if needed), `whoami`, and confirms the bot is **joined to the target room**;
  skipped when no matrix channel exists
- unconfigured integrations are reported as `skipped` (not failures); each check has a 20s timeout

Every check and the summary are published as events (`system.check.completed`,
`system.validation.completed`, `system.startup.announced` / `system.startup.announce_failed`), so
they show up in the Live events view. A failed Matrix announce does not crash the boot.

## Events

Everything publishes to the event bus: `topic.*`, `job.*`, `workflow.started/finished/failed/deleted`,
`agent.*` (including
`agent.tool.invoked/succeeded/failed`), `artifact.created/deleted`, `report.*`, `tts.synthesized`,
`delivery.updated` / `delivery.status`, `settings.updated`, `hook.received`, `chat.*` (commands,
`chat.message.received` for every allowed
message, and follow-up Q&A), `system.*`. Events are
persisted in SQLite (`events` table) and streamed to the UI over the WebSocket as they happen;
`event.pull` (`{ since, limit }`, also served on the webhook) backfills what a reconnect missed,
which is what makes the Svelte live view resumable.

Known topics are typed in `src/core/events/AppEvents.ts`. Arbitrary topics (e.g. inbound hooks)
are supported.

## Accounts and per-user data

Everything is scoped to the logged-in account. The admin account (`ADMIN_USERNAME`, default
`admin`) owns the original database (`DB_PATH`); every other account gets its own SQLite file under
`<DB_PATH dir>/users/<username>.db`. Stores, providers, settings, event log, status feed, Matrix
channel and scheduler all come from that per-user runtime, so one account can never read another's
data. Today the shared `AUTH_GLOBAL_PASSWORD` logs in as the admin; per-user auth methods (OIDC)
will resolve other accounts into the same runtime mechanism.

Provider credentials (LLM, web search, finance, Bluesky) are user-owned settings and are ignored if
set in the deployment environment. Other defaults (`TZ`, cron, search window, TTS endpoint, …)
remain deployment-level and can still be overridden per account in the UI.

## Authentication

The site is open until `AUTH_GLOBAL_PASSWORD` is set, either in the environment or in the UI
(Settings → Access). With a password configured, every data API call requires it; the UI still
loads its (data-free) shell so it can show the login gate, and the browser keeps an HttpOnly,
SameSite=Lax session cookie signed with `AUTH_SESSION_SECRET`. Without an explicit secret the
signing key derives from the password, so changing the password logs everyone out.
`AUTH_SESSION_TTL_HOURS` controls the session lifetime (default 720 = 30 days). The login endpoint
is rate-limited per client address to 5 requests per minute (answering `429` with `Retry-After`),
and failed logins are additionally throttled (10 failures per 5 minutes).

Mechanisms are pluggable providers (`src/auth/AuthProvider.ts`); the global password is the only
one implemented so far. OIDC and per-user accounts (separate users, config and data per user) will
plug in as additional providers and put the user id into the session's `subject` — today everything
is one global principal. The `GET /api/webhook` probe stays public so container healthchecks work;
all POSTs, the WebSocket feed and every other API endpoint are gated.

## Deployment (Coolify + Pangolin)

The `Dockerfile` builds the Svelte UI and runs the server on the Bun slim image.

- **Port:** `8080`. Point Coolify's healthcheck at `/api/webhook` (the image also ships a
  `HEALTHCHECK` that probes it).
- **Volume:** mount a volume at `/app/data` (SQLite database, `DB_PATH=/app/data/app.db`).
- **Env:** all variables from `.env.example` (`TZ` controls cron and report dates; `STARTUP_CHECK`
  controls the boot validation + startup message).
- **Pangolin:** `AUTH_GLOBAL_PASSWORD` can protect the site directly (see Authentication); Pangolin
  can add its own layer on top. The UI runs entirely over the `/api/ws` WebSocket, so the proxy must
  forward WebSocket upgrades (`Upgrade`/`Connection` headers and long-lived connections); Pangolin
  handles this by default. No SSE and no long-poll timeouts needed.
- **CI image:** `.github/workflows/docker.yml` builds a multi-arch image (`linux/amd64`,
  `linux/arm64`) and publishes it to `ghcr.io/<owner>/<repo>` on pushes to `main` and `v*` tags
  (`latest` tracks `main`; pull requests only build, they don't push).

```bash
docker build -t neuretina .
docker run --rm -p 8080:8080 -v neuretina-data:/app/data --env-file .env neuretina
```

To run the published image instead, use the bundled `docker-compose.yml`; it pulls
`ghcr.io/targoninc/neuretina:latest`, keeps the database in `/mnt/neuretina-data` on the host and
carries the whole environment in the service definition (no `.env` file needed):

```bash
# fill in the empty secrets in docker-compose.yml first
docker compose up -d
```

On Coolify, create a Docker Compose resource from this repository, set the same values in the
compose file (Coolify lets you edit it) and create `/mnt/neuretina-data` on the host.
