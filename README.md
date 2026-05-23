# Lightweight LLM Inference Logging + Ingestion System

This project is a full-stack demo that includes:
- Multi-turn chatbot UI
- Lightweight LLM SDK/wrapper with inference metadata logging
- Ingestion API with validation and parsing
- Database storage for conversations, messages, and inference logs
- Conversation operations: list, resume, cancel
- Docker Compose one-command local setup

## Tech Stack
- Next.js (App Router, TypeScript)
- Google Gemini API (default model: `gemini-2.5-flash`)
- Prisma ORM + SQLite
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
3. Set `GEMINI_API_KEY` in `.env`.
4. Create DB schema:
```bash
npx prisma db push
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
- Wrapper sends LLM request and captures metadata
- Wrapper posts metadata to `/api/ingest`
- Ingestion validates and stores in `InferenceLog`

## Schema Design Decisions
- `Conversation`: top-level chat session with status (`active`/`cancelled`)
- `ChatMessage`: normalized chat history by role and timestamp
- `InferenceLog`: operational telemetry fields for observability and debugging
- Indexed by conversation, status, provider/model for practical querying

Tradeoff:
- SQLite is simple for local demo but not ideal at high write throughput.

## Logging + Ingestion Tradeoffs
- Best-effort non-blocking ingestion avoids user-facing latency penalties.
- Short input/output previews balance debuggability with sensitive data minimization.

## What I'd Improve With More Time
- Multi-provider abstraction (Gemini, OpenAI, Claude)
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
- `POST /api/conversations/:id/cancel` -> cancel conversation
- `POST /api/ingest` -> ingestion endpoint for SDK logs
