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

## Failure Handling Assumptions
- Chat inference remains primary path; logging is non-blocking best effort.
- If ingestion fails, user chat still succeeds where possible.
- If provider fails, failed inference metadata still gets logged with error status.
