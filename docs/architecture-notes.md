# Architecture Notes

## Two-Tier Inference

Primary inference targets any OpenAI-compatible endpoint (`LLM_BASE_URL` +
`LLM_CHAT_MODEL`), with `LLM_SMALL_MODEL` used for background jobs (safety/quality
LLM-judge, ambient insights, prompt-lab challenger generation). Gemini
(`GEMINI_API_KEY` + `GEMINI_MODEL`) is a pure backup: `getProviderPlan()` in
`src/lib/llm.ts` always returns `[primary, gemini]` filtered to whichever is
configured, never a routing-policy choice. `executeWithFailover()` only switches to
gemini when no token has been emitted yet and the error is a typed network failure or
429/5xx status; once streaming starts, errors are rethrown rather than retried on
another provider. Legacy providers (grok/openai/anthropic/ollama) are excluded from
`configuredProviders()` unless `ENABLE_EXTRA_PROVIDERS=true`, and even then are only
reachable via an explicit `providerOverride` (e.g. race mode) — never part of automatic
failover.

## Ingestion Flow
1. User sends message from UI to `/api/chat`.
2. Chat API stores user message and fetches short context window.
3. LLM wrapper calls the provider adapter and captures latency, usage, status, timestamps, tagged with a fresh `crypto.randomUUID()` `eventId`.
4. `sendLog()` (fire-and-forget, never awaited) enqueues the event in-process onto BullMQ's `inference-ingest` queue when `REDIS_URL` is set; on any failure, or when Redis isn't configured at all, it writes the `InferenceLog` row directly via `src/lib/log-sink.ts`.
5. When present, `worker:ingest` drains the queue and performs the same write. Both paths upsert on `eventId` (unique on `InferenceLog`), so a log is idempotent regardless of which path wrote it.
6. `POST /api/ingest` is a separate, token-authenticated (`x-ingest-token` == `INGEST_TOKEN`, 503 if unset) HTTP endpoint for **external** log producers only — the app's own logging never calls it over HTTP.

## Logging Strategy
- Fire-and-forget by contract: the request path never awaits log dispatch.
- Resilient by design: Redis absence or a queue failure degrades to a direct DB write rather than dropping the log.
- Store full operational metadata and short previews (not full raw prompts) for privacy and cost.
- Keep ingestion contract strict using schema validation (shared `logSchema` in `src/lib/ingest-schema.ts`).

## Scaling Considerations
- Move ingestion write path to queue/event bus for burst tolerance.
- Add async workers for enrichment and aggregation.
- Partition large log tables by date in production SQL engines.

## Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Prisma pooled connection (port 6543) |
| `DIRECT_URL` | Prisma direct connection for migrations (port 5432) |
| `REDIS_URL` | BullMQ/ioredis connection. Optional — logging, rate limiting, and collab pub/sub all degrade gracefully without it |
| `SESSION_SECRET` | HMAC-SHA256 key for signing session cookies — min 32 chars, keep secret |
| `LLM_BASE_URL` | Primary inference endpoint, any OpenAI-compatible `/v1` base URL (vLLM/SGLang/Ollama/etc.) |
| `LLM_API_KEY` | API key for the primary endpoint, if it requires one (defaults to a dummy value for unauthenticated self-hosted endpoints) |
| `LLM_CHAT_MODEL` | Flagship model served by the primary endpoint |
| `LLM_SMALL_MODEL` | Cheaper/faster model on the same endpoint for background jobs (judging, moderation, titles, insights). Falls back to `LLM_CHAT_MODEL` |
| `LLM_TEMPERATURE` | Chat sampling temperature (default: 0.9, clamped 0–2). Tool-calling turns always use a fixed 0.2 regardless of this setting |
| `LLM_COST_IN_PER_1K` / `LLM_COST_OUT_PER_1K` | $/1k tokens for the primary endpoint, for budget tracking (default: 0 — self-hosted inference has no metered bill by default) |
| `GEMINI_API_KEY` | Backup provider — only used when the primary endpoint fails pre-first-token |
| `GEMINI_MODEL` | Gemini model (default: `gemini-2.5-flash`) |
| `GEMINI_THINKING_BUDGET` | Gemini 2.5 thinking-token budget (default: 0 = disabled). Thinking tokens otherwise consume the output budget and break incremental streaming; raise only if you want visible reasoning |
| `ENABLE_EXTRA_PROVIDERS` | Set `true` to expose grok/openai/anthropic/ollama in `configuredProviders()` (still manual-override-only, never part of automatic failover) |
| `GROK_API_KEY` / `GROK_MODEL` | x.ai Grok (legacy/manual only) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI cloud (legacy/manual only) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic cloud (legacy/manual only) |
| `ANTHROPIC_THINKING_BUDGET_TOKENS` | Anthropic extended-thinking budget (default: 4096; must stay below `LLM_MAX_OUTPUT_TOKENS`) |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | Direct Ollama adapter (legacy/manual only — prefer `LLM_BASE_URL` pointed at Ollama's `/v1` endpoint for the primary path instead) |
| `EMBEDDING_BASE_URL` | OpenAI-compatible `/embeddings` endpoint (defaults to `LLM_BASE_URL` if unset) |
| `EMBEDDING_MODEL` | Real embedding model name (e.g. `nomic-embed-text`, `bge-m3`). Unset → hash-vector fallback (`hash-tf-512`) |
| `EMBEDDING_DIM` | Real embedding vector dimension (default: 768). Must match the model's output and the pgvector column width |
| `WHISPER_BASE_URL` / `WHISPER_API_KEY` | Self-hosted OpenAI-compatible STT endpoint (primary transcription path) |
| `INGEST_TOKEN` | Required header value (`x-ingest-token`) for external producers on `POST /api/ingest`; route 503s if unset |
| `INGEST_MAX_RETRIES` | BullMQ retry attempts (default: 5) |
| `INGEST_RETRY_DELAY_MS` | BullMQ initial backoff ms (default: 1000) |
| `SAFETY_JUDGE` | Set `llm` to classify via `LLM_SMALL_MODEL` on the primary endpoint (zod-validated, fails open to the regex path). Default: regex only |
| `QUALITY_JUDGE` | Set `llm` to rubric-score via `LLM_SMALL_MODEL` (fails open to the heuristic scorer). Default: heuristic only |
| `PROMPT_PROFILE_KEY` | Active prompt profile key (default: `chat-default`) |
| `NEXT_PUBLIC_BASE_URL` | Public base URL (used by client-side fetches; no longer used for internal log shipping — see Ingestion Flow) |
| `LLM_CONTEXT_WINDOW` | Messages included in LLM context (default: 8, clamped 4–64) |
| `LLM_MAX_OUTPUT_TOKENS` | Max tokens a model may emit per response (default: 2048, clamped 256–8192) |
| `SAFETY_REFUSAL_TEMPLATE` | Override default safety refusal message |
| `RATE_LIMIT_PER_MINUTE` | Per-user chat requests/minute (default: 20) |
| `RATE_LIMIT_PER_HOUR` | Per-user chat requests/hour (default: 200) |
| `RATE_LIMIT_PER_DAY` | Per-user chat requests/day (default: 1000) |
| `BUDGET_FALLBACK_PROVIDER` | Optional explicit override for the DOWNGRADE budget action; must be a configured provider or it's ignored |
| `BUDGET_FALLBACK_MODEL` | Optional model override for the downgrade fallback (default: `primary`'s `LLM_SMALL_MODEL`, else `gemini`, else whatever else is configured) |
| `SEARCH_MAX_VECTORS` | Max message embeddings scanned per semantic search when falling back to the hash-vector path (default: 5000, min 100). The pgvector path scores in SQL and isn't subject to this cap |
| `EMBEDDING_BATCH_SIZE` | Messages embedded per embedding-worker batch (default: 50) |
| `EMBEDDING_CONCURRENCY` | Embedding worker job concurrency (default: 4) |
| `MAX_SCHEDULES_PER_USER` | Per-user cap on active `ScheduledPrompt` rows (default: 10) |
| `SCHEDULED_PROMPT_CONTEXT_CONVERSATIONS` | Recent conversations summarized as context for a scheduled prompt run (default: 5) |
| `SCHEDULED_PROMPT_CONCURRENCY` | Scheduled-prompt worker job concurrency (default: 2) |
| `SPEECH_STT_PROVIDER` | `whisper` \| `gemini` (default: `whisper` if `WHISPER_BASE_URL` is set, else `gemini` if `GEMINI_API_KEY` is set, else transcription 501s) |
| `SPEECH_STT_MODEL` | STT model override |
| `SPEECH_TTS_PROVIDER` | Only `openai` is currently supported (default: `openai`) |
| `SPEECH_TTS_MODEL` | OpenAI TTS model (default: `tts-1`) |
| `SPEECH_TTS_VOICE` | OpenAI TTS voice (default: `alloy`) |
| `PROMPT_LAB_INTERVAL_MINUTES` | How often the prompt-lab worker re-evaluates running experiments (default: 60) |
| `PROMPT_LAB_CONCURRENCY` | Prompt-lab worker job concurrency (default: 2) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Used by `npm run seed:admin` to create/update the admin account |

## Live Collaborative Sessions (Phase 20)

- No new env vars — reuses `REDIS_URL` for pub/sub in addition to BullMQ.
- Membership model: `Conversation.userId` owner is always `OWNER` rank; explicit `ConversationMember` rows (`OWNER|COLLABORATOR|VIEWER`) are only created for invited collaborators. `assertConversationAccess()` in `src/lib/collab.ts` centralizes every conversation-scoped authorization check that used to be an inline `findFirst({ userId })`.
- Transport: `GET /api/conversations/:id/events` is a long-lived SSE response subscribed to Redis `PUBLISH collab:{id}` via a dedicated per-request `ioredis` subscriber connection (SUBSCRIBE requires its own connection, separate from the cached publish/lock client). Events: `message_created`, `token`, `thought`, `presence` (20s heartbeat), `annotation_updated` (reserved, not yet emitted).
- Serverless deployments (e.g. Vercel) kill long-lived SSE connections — expect the events subscription to be re-established client-side on a fixed cadence in production; the client `EventSource` in `ChatUI.tsx` does not currently implement `Last-Event-ID` reconnection, so a dropped connection loses in-flight presence state until the next event.
- Only one member may have an in-flight chat send per collaborative conversation: `acquireSendLock`/`releaseSendLock` in `src/lib/collab.ts` wrap `POST /api/chat` with a Redis `SET NX EX` lock (30s TTL safety net), released as soon as generation completes/aborts/errors.

## Failure Handling Assumptions
- Chat inference remains primary path; logging is non-blocking best effort.
- If ingestion fails, user chat still succeeds where possible.
- If provider fails, failed inference metadata still gets logged with error status.
