# Ollive AI

A Next.js 15 + PostgreSQL + BullMQ application for LLM inference logging, chat, and management.

- Multi-turn chat UI with streaming, RAG, tool calling, and generative widgets
- **Two-tier inference**: a self-hosted OpenAI-compatible endpoint as primary, Gemini as an automatic backup
- Structured telemetry with resilient, queue-backed ingestion (falls back to a direct DB write when Redis is unavailable)
- Prompt versioning, A/B experiments, and safety moderation (regex or LLM-judge)
- Per-user workspaces, RBAC, budgets, and collaborative sessions

## Architecture: two-tier inference

Production inference targets **any OpenAI-compatible endpoint** — vLLM, SGLang, or a
serverless-GPU provider exposing the same API shape — via `LLM_BASE_URL` +
`LLM_CHAT_MODEL` (flagship) and `LLM_SMALL_MODEL` (background jobs: judging,
moderation, titles). The code has no vendor-specific branches for this path; it's
plain OpenAI-SDK-with-a-baseURL.

**Gemini is a pure backup** (`GEMINI_API_KEY` + `GEMINI_MODEL`), used automatically only
when the primary endpoint fails *before any token has streamed back* — once a response
starts streaming, the request never switches providers mid-flight.

Legacy providers (Grok, OpenAI, Anthropic, Ollama) still exist as adapters but are
excluded from automatic routing unless you set `ENABLE_EXTRA_PROVIDERS=true`; even then
they're only reachable via an explicit provider override (e.g. race mode), never part of
the failover plan.

For local development without a real GPU endpoint, run the `ollama` Docker Compose
profile and point `LLM_BASE_URL` at it.

## Tech Stack
- Next.js 15 (App Router, TypeScript)
- Prisma ORM + PostgreSQL (pgvector for real embeddings, JSON hash-vector fallback)
- BullMQ + Redis for ingestion, embeddings, and background workers
- Zod for validation at every API boundary

## Setup
1. Install dependencies:
```bash
npm install
```
2. Copy env file and fill in the primary endpoint + backup key:
```bash
cp .env.example .env
```
```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB_NAME?sslmode=require"
SESSION_SECRET="<32+ random chars>"

LLM_BASE_URL="http://localhost:11434/v1"   # vLLM/Ollama/etc.
LLM_CHAT_MODEL="qwen2.5:7b"
LLM_SMALL_MODEL=""                          # optional, defaults to LLM_CHAT_MODEL

GEMINI_API_KEY=""                           # optional backup
GEMINI_MODEL="gemini-2.5-flash"

REDIS_URL="redis://localhost:6379"          # optional — logs fall back to a direct DB write without it
```
3. Apply DB migrations:
```bash
npx prisma migrate deploy
```
4. Seed an admin user:
```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me npm run seed:admin
```
5. Run app:
```bash
npm run dev
```
6. Open `http://localhost:3000`

The minimum viable config is just `DATABASE_URL`, `SESSION_SECRET`, and `LLM_BASE_URL` +
`LLM_CHAT_MODEL` — no Redis, no Gemini key required. Chat, tools, RAG, and quality
scoring all work; logs are written directly to Postgres instead of queued.

## Docker Compose
```bash
cp .env.example .env
docker compose up --build
```
Brings up Postgres (with pgvector), Redis, the app, and every background worker. Add
`--profile ollama` for a local OpenAI-compatible LLM endpoint, or `--profile whisper` for
a local speech-to-text endpoint:
```bash
docker compose --profile ollama --profile whisper up --build
docker compose exec ollama ollama pull qwen2.5:7b
```

## Architecture Overview
- UI calls `/api/chat` (SSE streaming or sync JSON, depending on `Accept`/`toolsEnabled`)
- Chat route persists messages, resolves the system prompt (+ RAG context), and assembles a short context window
- `src/lib/llm.ts` picks the provider plan (`[primary, gemini]`, filtered to what's configured) and calls the adapter
- Inference metadata is logged fire-and-forget: enqueued onto BullMQ when Redis is configured, otherwise written directly to `InferenceLog`
- A background worker (`worker:ingest`) drains the queue when present; either path is idempotent on a per-request `eventId`

## Schema Design Decisions
- `Conversation`: top-level chat session with status (`active`/`paused`) and optional collaboration
- `ChatMessage`: normalized chat history by role and timestamp
- `InferenceLog`: operational telemetry, unique on `eventId` for idempotent writes
- `KnowledgeChunk` / `MessageEmbedding`: hash-vector fallback (`embedding`/`vector` JSON columns) plus a real `embeddingVector` pgvector column populated when an embedding endpoint is configured

## Logging + Ingestion
- Fire-and-forget by contract — the request path never awaits log dispatch.
- `sendLog()` enqueues in-process onto BullMQ when `REDIS_URL` is set; on any failure, or when Redis isn't configured at all, it writes `InferenceLog` directly.
- `/api/ingest` is for **external** log producers only (requires `x-ingest-token` matching `INGEST_TOKEN`); the app's own logging never calls it over HTTP.
- Idempotency: every logging call generates a `crypto.randomUUID()` `eventId` up front; both the worker and the direct-write path upsert on it.
- Dead-letter queue: exhausted BullMQ jobs are persisted into `IngestionDLQ` with reason and retry count.

## Provider Failover
- Automatic plan is always `[primary, gemini]`, filtered to whichever is configured — gemini is never selected by a routing policy, only as a backup.
- Failover to gemini fires only when (a) no token has been emitted yet, and (b) the error is a typed network failure or 429/5xx status — no message-substring sniffing.
- Once streaming has started, an error is never retried on another provider.

## API Endpoints (selected)
- `POST /api/chat` — send a message; SSE stream or sync JSON, returns `provider`/`model` served
- `POST /api/chat/race` — fan a prompt out to 2–3 configured providers
- `GET /api/providers` — configured providers + models, used by the UI to build provider pickers
- `GET /api/conversations` — list conversations + messages
- `POST /api/auth/signup`, `POST /api/auth/signin` — password-based auth (scrypt-hashed)
- `POST /api/ingest` — external log producer endpoint, requires `x-ingest-token`

## Architecture Notes
See [`docs/architecture-notes.md`](docs/architecture-notes.md) for the full env var table and phase-by-phase design decisions, and [`CLAUDE.md`](CLAUDE.md) for the complete phase history.
