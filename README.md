# Lightweight LLM Inference Logging + Ingestion System

This project is a full-stack demo that includes:
- Multi-turn chatbot UI
- Lightweight LLM SDK/wrapper with inference metadata logging
- Ingestion API with validation and parsing
- Database storage for conversations, messages, and inference logs
- Conversation operations: list, pause/resume, delete
- Queue-backed ingestion with idempotency + dead-letter handling
- Provider routing policy and automatic failover for retryable provider errors
- Docker Compose one-command local setup

## Tech Stack
- Next.js (App Router, TypeScript)
- Multi-provider LLM support: Gemini + Grok
- Prisma ORM + PostgreSQL
- Zod for ingestion payload validation

## Setup
1. Install dependencies:
```bash
npm install
```
2. Copy env file:
```bash
cp .env.example .env
```
3. Configure provider and keys in `.env`:
```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB_NAME?sslmode=require"
LLM_PROVIDER="gemini" # or "grok"
LLM_ROUTING_POLICY="manual" # manual | cost | latency | quality
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-2.5-flash"
GROK_API_KEY=""
GROK_MODEL="grok-3-mini"
REDIS_URL="redis://localhost:6379"
INGEST_MAX_RETRIES="5"
INGEST_RETRY_DELAY_MS="1000"
NEXT_PUBLIC_BASE_URL="http://localhost:3000"
```
4. Create/apply DB migrations:
```bash
npx prisma migrate dev --name init
```
5. Run app:
```bash
npm run dev
```
6. Open `http://localhost:3000`

## Docker Compose
```bash
cp .env.example .env
docker compose up --build
```

## Architecture Overview
- UI calls `/api/chat`
- Chat route persists messages and assembles short context window
- Wrapper selects provider adapter (Gemini/Grok), sends LLM request, and captures metadata
- Wrapper posts metadata to `/api/ingest`
- Ingestion validates and stores in `InferenceLog`

## Schema Design Decisions
- `Conversation`: top-level chat session with status (`active`/`cancelled`)
- `ChatMessage`: normalized chat history by role and timestamp
- `InferenceLog`: operational telemetry fields for observability and debugging
- Indexed by conversation, status, provider/model for practical querying

Tradeoff:
- PostgreSQL is production-friendly and deployable on serverless platforms, but requires managed DB setup.

## Logging + Ingestion Tradeoffs
- Best-effort non-blocking ingestion avoids user-facing latency penalties.
- Short input/output previews balance debuggability with sensitive data minimization.

## What I'd Improve With More Time
- Add OpenAI and Claude adapters to the same provider interface
- Streaming response handling and token-by-token logging
- Dashboard endpoints for latency, throughput, errors
- Queue-based ingestion (Kafka/SQS + worker)
- PII redaction middleware before persistence
- Kubernetes deployment manifests + autoscaling config

## Architecture Notes
See [`docs/architecture-notes.md`](docs/architecture-notes.md).

## Demo Evidence
Use one of the following:
- Hosted link (recommended)
- Loom walkthrough
- Screenshots of:
  - chat UI
  - conversation list/resume/cancel
  - `InferenceLog` rows in DB

## API Endpoints
- `POST /api/chat` -> send user message, returns assistant response + conversation ID
- `GET /api/conversations` -> list conversations + messages
- `POST /api/conversations/:id/cancel` -> pause/resume conversation via `{ "action": "pause" | "resume" }`
- `DELETE /api/conversations/:id` -> delete conversation
- `POST /api/ingest` -> validates payload, enqueues ingestion job, returns `202 Accepted`


## Background event ingestion
- `/api/ingest` is now a queue producer that validates payload and enqueues jobs with deterministic idempotency key (`sha256(payload)`).
- Queue backend: Redis + BullMQ.
- Worker consumer: `npm run worker:ingest`.
- Retries: exponential backoff using `INGEST_MAX_RETRIES` and `INGEST_RETRY_DELAY_MS`.
- Dead-letter queue: exhausted jobs are persisted into `IngestionDLQ` with reason and retry count.
- Idempotency: `IngestionEvent` table tracks processed event IDs to prevent duplicate DB writes.

## Additional implemented behavior
- Context windowing: chat requests use a short recent-history window (`take: 8`) before inference.
- Provider routing: `LLM_ROUTING_POLICY` selects provider order (`manual`, `cost`, `latency`, `quality`).
- Retryable-failure failover: retryable provider errors (rate limit, quota, network, transient 5xx) can fall through to the next configured provider.
- Inference metadata captured for both sync and streaming modes (latency, token counts, TTFT/stream duration when available).
- Guardrails in chat API:
  - Returns `409` if a conversation is paused.
  - Maps provider auth failures to `401`.
  - Maps quota/rate-limit failures to `429`.
  - Maps model-not-found style errors to `400`.

### Run ingestion pipeline locally
1. Start Redis.
2. Run app: `npm run dev`.
3. Run worker in another terminal: `npm run worker:ingest`.
4. Apply schema changes: `npx prisma migrate dev --name add_ingestion_queue_models`.
