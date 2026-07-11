# Architecture Notes

## Ingestion Flow
1. User sends message from UI to `/api/chat`.
2. Chat API stores user message and fetches short context window.
3. LLM wrapper calls provider API and captures latency, usage, status, timestamps.
4. Wrapper asynchronously posts metadata to `/api/ingest`.
5. Ingestion endpoint validates payload (Zod), normalizes fields, stores in `InferenceLog`.

## Logging Strategy
- Best-effort near-real-time HTTP log shipping from wrapper to ingestion API.
- Store full operational metadata and short previews (not full raw prompts) for privacy and cost.
- Keep ingestion contract strict using schema validation.

## Scaling Considerations
- Move ingestion write path to queue/event bus for burst tolerance.
- Add async workers for enrichment and aggregation.
- Partition large log tables by date in production SQL engines.

## Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Prisma pooled connection (port 6543) |
| `DIRECT_URL` | Prisma direct connection for migrations (port 5432) |
| `REDIS_URL` | BullMQ/ioredis connection |
| `SESSION_SECRET` | HMAC-SHA256 key for signing session cookies — min 32 chars, keep secret |
| `LLM_PROVIDER` | Default provider: `gemini` or `grok` |
| `LLM_ROUTING_POLICY` | `manual` \| `cost` \| `latency` \| `quality` |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL` | Gemini model (default: `gemini-2.5-flash`) |
| `GROK_API_KEY` | x.ai Grok API key |
| `GROK_MODEL` | Grok model (default: `grok-3-mini`) |
| `INGEST_MAX_RETRIES` | BullMQ retry attempts (default: 5) |
| `INGEST_RETRY_DELAY_MS` | BullMQ initial backoff ms (default: 1000) |
| `PROMPT_PROFILE_KEY` | Active prompt profile key (default: `chat-default`) |
| `NEXT_PUBLIC_BASE_URL` | Base URL for internal sendLog HTTP call |
| `LLM_CONTEXT_WINDOW` | Messages included in LLM context (default: 8, clamped 4–64) |
| `LLM_MAX_OUTPUT_TOKENS` | Max tokens a model may emit per response (default: 2048, clamped 256–8192). Replaces the old hardcoded 900 that truncated long answers |
| `GEMINI_THINKING_BUDGET` | Gemini 2.5 thinking-token budget (default: 0 = disabled). Thinking tokens otherwise consume the output budget and break incremental streaming; raise only if you want visible reasoning |
| `SAFETY_REFUSAL_TEMPLATE` | Override default safety refusal message |
| `RATE_LIMIT_PER_MINUTE` | Per-user chat requests/minute (default: 20) |
| `RATE_LIMIT_PER_HOUR` | Per-user chat requests/hour (default: 200) |
| `RATE_LIMIT_PER_DAY` | Per-user chat requests/day (default: 1000) |
| `BUDGET_FALLBACK_PROVIDER` | Provider used when a user's budget triggers a DOWNGRADE (default: gemini) |
| `BUDGET_FALLBACK_MODEL` | Optional model override for the downgrade fallback provider (default: the provider's configured model) |
| `SEARCH_MAX_VECTORS` | Max message embeddings scanned per semantic search (default: 5000, min 100) |
| `EMBEDDING_BATCH_SIZE` | Messages embedded per embedding-worker batch (default: 50) |
| `EMBEDDING_CONCURRENCY` | Embedding worker job concurrency (default: 4) |
| `MAX_SCHEDULES_PER_USER` | Per-user cap on active `ScheduledPrompt` rows (default: 10) |
| `SCHEDULED_PROMPT_CONTEXT_CONVERSATIONS` | Recent conversations summarized as context for a scheduled prompt run (default: 5) |
| `SCHEDULED_PROMPT_CONCURRENCY` | Scheduled-prompt worker job concurrency (default: 2) |
| `SPEECH_STT_PROVIDER` | `openai` \| `gemini` (default: `openai` if `OPENAI_API_KEY` is set, else `gemini`) |
| `SPEECH_STT_MODEL` | STT model override (default: `whisper-1` for OpenAI, the configured Gemini model otherwise) |
| `SPEECH_TTS_PROVIDER` | Only `openai` is currently supported (default: `openai`) |
| `SPEECH_TTS_MODEL` | OpenAI TTS model (default: `tts-1`) |
| `SPEECH_TTS_VOICE` | OpenAI TTS voice (default: `alloy`) |
| `PROMPT_LAB_INTERVAL_MINUTES` | How often the prompt-lab worker re-evaluates running experiments (default: 60) |
| `PROMPT_LAB_CONCURRENCY` | Prompt-lab worker job concurrency (default: 2) |

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
