# Project Context

## 1. Project Overview

- **Project name:** Ollive AI (package: `llm-inference-logging-system`)
- **Purpose:** LLM-powered chat application with built-in inference logging, safety moderation, prompt version management, RAG, analytics, and per-user conversation workspace.
- **Core problem solved:** Wraps multi-provider LLM calls with structured operational telemetry (latency, token usage, TTFT), content moderation, A/B-testable prompt profiles, quality scoring, and admin tooling — in a single deployable Next.js app.
- **Target users:** Internal teams / developers evaluating LLM outputs and prompt quality; external sites via the public embed widget.
- **Current maturity:** Feature-complete through Phase 10 (see §15). Phases 11–15 planned.

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 19, Next.js 15 App Router | UI, routing, SSR for shared/admin pages |
| Backend | Next.js API Routes | REST endpoints (sync + SSE streaming) |
| Database | PostgreSQL + Prisma ORM 6 | Persistent storage for all entities |
| Queue | BullMQ + Redis (ioredis) | Async log ingestion + quality scoring |
| LLM Providers | Gemini (`@google/genai`), Grok (x.ai REST), OpenAI (`openai`), Anthropic (`@anthropic-ai/sdk`), Ollama (OpenAI-compatible REST) | Inference |
| Authentication | HMAC-signed cookie session (`ollive_session`) + role-based access (RBAC) | No OAuth/JWT |
| Validation | Zod | API payload schema enforcement |
| Markdown | react-markdown + remark-gfm + rehype-highlight | Chat message rendering |
| Charts | recharts | Analytics dashboard |
| Infrastructure | Docker, Vercel | Container and serverless hosting |
| Testing | Custom eval runner (`evals/run.mjs`) | Prompt regression testing |

---

## 3. System Architecture

```
Browser (ChatUI.tsx + chat/* components)
  ↓ POST /api/chat  (sync JSON or SSE stream via Accept: text/event-stream)
Chat API Route
  ├─ requireSessionUser()        — HMAC session cookie auth
  ├─ checkRateLimit()            — Redis sliding-window (429 + X-RateLimit-* headers)
  ├─ moderateInput()             — regex safety check
  ├─ resolveSystemPrompt()       — prompt profile + A/B variant + RAG chunk injection
  ├─ callLLMWithLogging() /
  │  streamLLMWithLogging()      — provider execution + failover
  │    └─ fire-and-forget → POST /api/ingest
  └─ moderateOutput()            — regex safety check on LLM response
         ↓
  /api/ingest  →  BullMQ ingest queue (Redis)
         ↓
  ingest-worker.ts  →  InferenceLog written to PostgreSQL
         ↓ (assistant messages also enqueued)
  quality-score-queue → quality-score-worker.ts → QualityScore
```

Public surfaces (no session cookie): `/shared/[token]` SSR read-only view, `/embed/[token]` widget page + `POST /api/embed/chat` (auth via `X-Embed-Token` header, CORS enforced against `allowedOrigins`).

---

## 4. Repository Structure

```
/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/                signin, signout, me
│   │   │   ├── chat/                core chat endpoint (sync + SSE)
│   │   │   │   └── race/            multi-provider race mode + vote
│   │   │   ├── conversations/       CRUD + share + cancel + replay + documents
│   │   │   ├── documents/           knowledge document delete
│   │   │   ├── messages/[id]/annotations/  per-message annotations
│   │   │   ├── analytics/           inference, ab-results, safety, cost (admin)
│   │   │   ├── admin/
│   │   │   │   ├── prompts/         profiles, versions, activate, rollback
│   │   │   │   ├── users/           user list + role patch
│   │   │   │   └── embed-tokens/    embed token CRUD
│   │   │   ├── embed/chat/          public embed chat (token auth)
│   │   │   ├── export/dataset/      streaming JSONL/CSV export
│   │   │   ├── ingest/              log ingestion (queue entry point)
│   │   │   └── prompts/             active version get/set, rollback
│   │   ├── analytics/               admin analytics dashboard (recharts)
│   │   ├── admin/
│   │   │   ├── prompts/             Prompt Studio (two-pane editor + diff)
│   │   │   ├── users/               user role management
│   │   │   └── embed/               embed token management
│   │   ├── embed/[token]/           standalone widget chat UI
│   │   ├── shared/[token]/          public read-only conversation view (SSR)
│   │   ├── globals.css              all app styles (dark theme, CSS vars)
│   │   ├── layout.tsx
│   │   └── page.tsx                 mounts <ChatUI />
│   ├── components/
│   │   ├── ChatUI.tsx               orchestrator (state + handlers only)
│   │   └── chat/
│   │       ├── AuthGate.tsx         inline sign-in form
│   │       ├── ConversationSidebar.tsx
│   │       ├── MessageList.tsx
│   │       ├── MessageBubble.tsx    markdown + annotations + replay menu
│   │       ├── RacePane.tsx         race-mode result cards + voting
│   │       └── ChatInput.tsx        textarea, file upload, race toggle
│   ├── lib/
│   │   ├── auth.ts                  HMAC session sign/verify; requireSessionUser()
│   │   ├── rbac.ts                  requireRole(user, minRole) role gate
│   │   ├── rate-limiter.ts          Redis sliding-window rate limiting
│   │   ├── embed-auth.ts            X-Embed-Token validation for embed API
│   │   ├── llm.ts                   provider abstraction, failover, streaming, logging
│   │   ├── prompt-manager.ts        PromptProfile resolution + A/B selection + rollback
│   │   ├── rag.ts                   ingestDocument(), retrieveRelevantChunks()
│   │   ├── safety.ts                input/output moderation + refusal templates
│   │   ├── quality-scorer.ts        heuristic quality scoring for assistant messages
│   │   ├── cost.ts                  static provider+model → $/1k-token lookup
│   │   ├── diff.ts                  minimal Myers diff for prompt diff viewer
│   │   ├── queue.ts                 BullMQ queue factories (ingest + quality-score)
│   │   ├── ingest-schema.ts         Zod schema for LogEvent
│   │   ├── prisma.ts                shared Prisma client singleton
│   │   └── types.ts                 shared types (LogEvent, etc.)
│   └── workers/
│       ├── ingest-worker.ts         writes InferenceLog + DLQ
│       └── quality-score-worker.ts  writes QualityScore per assistant message
├── public/embed.js                  vanilla JS iframe injector for embed widget
├── prisma/  (schema.prisma + migrations/)
├── evals/   (cases.json, run.mjs, latest-report.json)
├── docs/architecture-notes.md
├── CHANGELOG.md
├── Dockerfile
└── docker-compose.yml
```

---

## 5. Application Flow

**Chat message (streaming):**
```
User types message → ChatUI.send() → POST /api/chat with Accept: text/event-stream
→ requireSessionUser() → checkRateLimit() → moderateInput()
→ resolveSystemPrompt() (active PromptVersion + A/B variant + RAG chunks; logs PromptDecision)
→ streamLLMWithLogging() emits data: {"token":"..."} chunks, terminated by data: [DONE]
→ ChatUI appends chunks to streamingContent state; on [DONE] calls refresh()
→ moderateOutput() on assembled response → ChatMessage saved
→ fire-and-forget sendLog → /api/ingest → BullMQ → ingest-worker → InferenceLog
→ assistant message enqueued to quality-score-queue → QualityScore
```

**Race mode:**
```
User toggles race + picks 2–3 providers → POST /api/chat/race
→ shared moderation + prompt resolution once → Promise.allSettled over runProvider
→ per-provider output moderation + RaceResult row + fire-and-forget log
→ RacePane renders side-by-side cards → POST /api/chat/race/:messageId/vote sets votedBest
```

**Auth:** name + email → `POST /api/auth/signin` → upsert User → set httpOnly cookie `{userId}.{hmac_sha256_hex}`; all protected routes verify via `requireSessionUser()` (timing-safe compare).

**Sharing:** `POST /api/conversations/:id/share` → UUID `shareToken` → `/shared/:token` SSR read-only page (no auth).

**Embed:** admin creates `EmbedToken` → host page includes `public/embed.js` with `data-token` → iframe loads `/embed/[token]` → widget posts to `/api/embed/chat` with `X-Embed-Token`; CORS enforced against `allowedOrigins`.

**Replay:** `POST /api/conversations/:id/replay` re-runs turns sequentially with provider/prompt overrides into a forked conversation (`replayMeta` records origin; "Forked from" badge shown).

**RAG:** paperclip upload in `ChatInput` → `POST /api/conversations/:id/documents` → `ingestDocument()` chunks + embeds (JSON float arrays) → `retrieveRelevantChunks()` injects relevant chunks inside `resolveSystemPrompt()`.

---

## 6. Core Modules

### LLM Layer (`src/lib/llm.ts`)
Multi-provider execution (gemini, grok, openai, anthropic, ollama) with failover, streaming, and async telemetry. Provider selection via routing policy (`manual`/`cost`/`latency`/`quality`), exponential failover on retryable errors, token usage + TTFT capture. Gemini uses proper `Content[]` message arrays via `toGeminiContents()` (system prompt prepended to first user turn, `assistant` → `model`). Key exports: `callLLMWithLogging`, `streamLLMWithLogging`, `runProvider`. Log dispatch is always fire-and-forget.

### Auth & RBAC (`src/lib/auth.ts`, `src/lib/rbac.ts`)
HMAC-signed session cookie: `{userId}.{hmac_sha256_hex}` using `SESSION_SECRET` (≥32 chars required); `verifyAndExtract()` uses `timingSafeEqual`. Roles: `VIEWER < ANALYST < PROMPT_EDITOR < ADMIN` (`UserRole` enum); `requireRole(user, minRole)` throws 403.

### Rate Limiter (`src/lib/rate-limiter.ts`)
Redis `INCR`+`EXPIRE` sliding windows per user (`ratelimit:{userId}:minute|hour|day`). Applied in `POST /api/chat` immediately after auth; returns 429 + `X-RateLimit-*` headers. Users with `rateLimitExempt` bypass.

### Safety (`src/lib/safety.ts`)
Regex-based moderation on input and output. Runs synchronously before and after the LLM call. All block/allow events (both phases) are written to `SafetyAuditLog`.

### Prompt Manager (`src/lib/prompt-manager.ts`)
Versioned prompt profiles with deterministic A/B testing (SHA-256 of `conversationId:profileKey:version`). Optional `profileKey` param supports per-embed-token profiles. Every resolution writes a `PromptDecision`. Managed via Prompt Studio (`/admin/prompts`) with Myers-diff version comparison.

### RAG (`src/lib/rag.ts`)
`ingestDocument()` chunks uploaded files into `KnowledgeChunk` rows (embeddings as JSON float arrays; pgvector is the upgrade path). `retrieveRelevantChunks()` is integrated into `resolveSystemPrompt()`.

### Ingestion Pipeline (`/api/ingest` + `src/workers/ingest-worker.ts`)
Zod validation, SHA-256 idempotency key (`IngestionEvent`), BullMQ enqueue, worker writes `InferenceLog`, DLQ (`IngestionDLQ`) on max retries. Separate process: `npm run worker:ingest`.

### Quality Scoring (`src/lib/quality-scorer.ts` + `src/workers/quality-score-worker.ts`)
Assistant messages scored async via `quality-score-queue`; one `QualityScore` per message. Exported via `GET /api/export/dataset` (streaming JSONL/CSV using `TransformStream`). Separate process: `npm run worker:quality-score`.

### Frontend (`src/components/`)
`ChatUI.tsx` is the orchestrator; presentational components in `src/components/chat/` receive props only. Local React state only — no state managers or Context. `refresh()` after every mutation.

---

## 7. Data Model

| Entity | Purpose | Key Relations / Fields |
|---|---|---|
| `User` | Account record | `role UserRole`, `rateLimitExempt`; owns `Conversation[]`, `MessageAnnotation[]`, `EmbedToken[]` |
| `EmbedToken` | Public widget auth token | `token` unique, `promptProfileKey`, `allowedOrigins[]`, `isActive` |
| `Conversation` | Chat thread + metadata | `status`, `isArchived`, `isPinned`, `folder`, `tags[]`, `shareToken`, `replayMeta Json?` |
| `ChatMessage` | Individual turn (`user`\|`assistant`) | has `MessageAnnotation[]`, `QualityScore?`, `RaceResult[]` |
| `RaceResult` | One provider's answer in race mode | `provider`, `model`, `latencyMs`, `tokenCount`, `votedBest` |
| `QualityScore` | Async quality score per assistant message | `@unique messageId`, `score`, `breakdown Json` |
| `MessageAnnotation` | Per-user feedback on a message | `@@unique([messageId, userId])`; `rating`, `thumbs`, `comment` |
| `InferenceLog` | LLM call telemetry | latency, TTFT, tokens, previews, provider, model, status |
| `PromptProfile` / `PromptVersion` | Versioned prompts with A/B variants | `basePrompt`, `variantA/B`, `abRatioA`, `modelOverrides`, `isRollbackPoint` |
| `PromptDecision` | Per-conversation prompt resolution record | profile/version/variant used |
| `SafetyAuditLog` | Moderation event per message | phase `input`\|`output`, action `blocked`\|`allowed` |
| `KnowledgeDocument` / `KnowledgeChunk` | RAG source docs and chunks | chunk `embedding Json?` |
| `IngestionEvent` / `IngestionDLQ` | Idempotency tracker / failed-job store | — |

Cascade deletes from `User → Conversation → *`. `Conversation` compound index on `(userId, isArchived, isPinned, updatedAt)`.

---

## 8. API / Communication Layer

- **Style:** REST, JSON, Next.js App Router routes; chat supports SSE streaming (`Accept: text/event-stream`).
- **Auth:** `requireSessionUser()` (HMAC cookie) first in every protected route; admin routes additionally check role via `requireRole`. Embed API uses `X-Embed-Token`.
- **Errors:** `{ error: string }`; `UNAUTHORIZED` → 401, `FORBIDDEN` → 403, rate limit → 429, model errors → 400, infra → 502/500.

| Group | Endpoints |
|---|---|
| Auth | `POST /api/auth/signin`, `POST /api/auth/signout`, `GET /api/auth/me` |
| Chat | `POST /api/chat` (sync + SSE), `POST /api/chat/race`, `POST /api/chat/race/:messageId/vote` |
| Conversations | `GET /api/conversations`, `PATCH/DELETE /api/conversations/:id`, `POST .../share`, `POST .../cancel`, `POST .../replay` |
| Documents (RAG) | `POST/GET /api/conversations/:id/documents`, `DELETE /api/documents/:id` |
| Annotations | `POST/GET/DELETE /api/messages/:messageId/annotations` |
| Analytics (admin) | `GET /api/analytics/inference`, `/ab-results`, `/safety`, `/cost` |
| Prompt admin | `GET/POST /api/admin/prompts`, `GET/POST .../:profileKey/versions`, `POST .../activate`, `POST .../rollback` |
| User admin | `GET /api/admin/users`, `PATCH /api/admin/users/:id` |
| Embed admin | `GET/POST /api/admin/embed-tokens`, `PATCH/DELETE /api/admin/embed-tokens/:id` |
| Embed (public) | `POST /api/embed/chat` (+ `OPTIONS` preflight) |
| Export | `GET /api/export/dataset` (streaming JSONL/CSV) |
| Ingestion | `POST /api/ingest` |
| Prompts | `GET/POST /api/prompts/active`, `POST /api/prompts/rollback` |

---

## 9. Frontend Architecture

- **Component strategy:** `ChatUI.tsx` orchestrator + presentational components in `src/components/chat/` (AuthGate, ConversationSidebar, MessageList, MessageBubble, ChatInput, RacePane). No component library.
- **State management:** Local `useState` only. No Redux/Zustand/Context.
- **Data fetching:** `fetch()` in handlers/`useEffect`; `refresh()` after every mutation. SSE stream consumed for live token rendering.
- **UI system:** Custom CSS in `globals.css` with CSS custom properties. Dark theme. No Tailwind.
- **Pages:** `/` (chat), `/shared/[token]` (SSR read-only), `/embed/[token]` (widget), `/analytics`, `/admin/prompts`, `/admin/users`, `/admin/embed`.
- **Markdown:** `react-markdown` + `remark-gfm` + `rehype-highlight` (`github-dark`).
- **Tag format:** Color tags serialized as `label::#hexcolor` in `Conversation.tags[]`.
- **Sidebar:** "Analytics" link visible only to admins.

---

## 10. Backend Architecture

- **Routes:** all in `src/app/api/`; business logic in `src/lib/` — no service classes, no Next.js middleware.
- **Validation:** Zod at ingest, chat/race, and other new boundaries.
- **Background jobs:** two standalone worker processes (`worker:ingest`, `worker:quality-score`), not part of the Next.js server.
- **Context window:** `LLM_CONTEXT_WINDOW` env var (default 8, clamped [4, 64]), parsed at module load.
- **Conversation status:** `active` | `paused` — paused conversations reject new messages with 409.
- **Race mode:** non-streaming by design (`Promise.allSettled` waits for all providers).

---

## 11. Security Model

- **Authentication:** HMAC-SHA256-signed httpOnly cookie (`{userId}.{hmac}`, `sameSite: lax`, 30-day expiry); `SESSION_SECRET` (≥32 chars) required; timing-safe verification.
- **Authorization:** RBAC via `UserRole` enum; ownership (`userId`) verified before every conversation mutation. Share links public but read-only. Embed API token-authenticated with origin allowlist CORS.
- **Rate limiting:** per-user Redis sliding windows on chat; `rateLimitExempt` flag for trusted users.
- **Content safety:** regex blocklists on input and output; every decision (blocked and allowed, both phases) audit-logged.
- **Secrets:** API keys / DB credentials via `.env`, never committed.
- **Idempotency:** ingest events keyed by SHA-256 of payload.

---

## 12. Development Rules

**DO:**
- Keep all business logic in `src/lib/` functions; use the shared `prisma` singleton.
- Call `requireSessionUser()` as the first statement of every protected route.
- Keep ingestion fire-and-forget — never `await sendLog(...)`; use `void sendLog(...)`.
- Validate external inputs with Zod at every system boundary.
- Call `refresh()` after every frontend mutation.
- Create a migration for every Prisma model change (`YYYYMMDD_phase{N}_{description}`); never `db push` in production.
- Run `node evals/run.mjs` after every phase and update `CHANGELOG.md`.

**DO NOT:**
- Add state managers or Context providers to the frontend — local state only.
- Add top-level npm dependencies without a justification comment.
- Block the chat response path on logging or ingestion.
- Bypass `moderateInput`/`moderateOutput` or skip `SafetyAuditLog` writes.
- Write prompt content directly into API routes — always go through `resolveSystemPrompt()`.
- Skip the `PromptDecision` record during prompt resolution.

---

## 13. Environment & Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Prisma pooled (6543) / direct (5432) connections |
| `REDIS_URL` | BullMQ / rate-limiter Redis connection |
| `SESSION_SECRET` | HMAC session signing key (≥32 chars, required) |
| `LLM_PROVIDER` | Default provider: `gemini` \| `grok` \| `openai` \| `anthropic` \| `ollama` |
| `LLM_ROUTING_POLICY` | `manual` \| `cost` \| `latency` \| `quality` |
| `LLM_CONTEXT_WINDOW` | Messages of context per turn (default 8, clamped 4–64) |
| `LLM_MAX_OUTPUT_TOKENS` | Output token cap |
| `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_THINKING_BUDGET` | Gemini config (default model `gemini-2.5-flash`) |
| `GROK_API_KEY` / `GROK_MODEL` | Grok config (default `grok-3-mini`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI config |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic config |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | Ollama config |
| `RATE_LIMIT_PER_MINUTE` / `PER_HOUR` / `PER_DAY` | Rate limits (defaults 20 / 200 / 1000) |
| `INGEST_MAX_RETRIES` / `INGEST_RETRY_DELAY_MS` | BullMQ retry config (5 / 1000) |
| `PROMPT_PROFILE_KEY` | Active prompt profile key (default `chat-default`) |
| `NEXT_PUBLIC_BASE_URL` | Base URL for internal `sendLog` HTTP call |
| `SAFETY_REFUSAL_TEMPLATE` | Override default safety refusal message |
| `EVAL_BASE_URL` | Eval runner target (default `http://localhost:3000`) |

---

## 14. Deployment & Infrastructure

- **Hosting:** Vercel (primary) or Docker. `vercel-build` runs `prisma migrate deploy && next build`.
- **Docker:** `node:20-alpine`, port 3000; `docker-compose.yml` loads `.env`.
- **Workers:** run as separate tsx processes — `npm run worker:ingest` and `npm run worker:quality-score` (planned as docker-compose services).
- **Database:** external PostgreSQL (Supabase-compatible; pooled + direct URLs). **Redis:** external instance required.
- **Migrations:** `prisma migrate deploy` at deploy time.

---

## 15. Current State

**Completed phases (0–10):**
- **Phase 0** — HMAC session cookies, SSE streaming chat UI, ChatUI decomposition, proper Gemini `Content[]` message format, configurable context window.
- **Phase 1** — Analytics dashboard (`/analytics`, recharts) + admin APIs for inference, A/B results, safety, and cost.
- **Phase 2** — Prompt Studio (`/admin/prompts`): profile/version editing, activation, rollback, Myers-diff viewer.
- **Phase 3** — RBAC: `UserRole` enum (`VIEWER`/`ANALYST`/`PROMPT_EDITOR`/`ADMIN`), `requireRole()`, user management page.
- **Phase 4** — Collaborative annotations (thumbs, star rating, notes) per assistant message.
- **Phase 5** — OpenAI/Anthropic/Ollama providers + RAG (document upload, chunking, retrieval into system prompt).
- **Phase 6** — Async quality scoring (queue + worker) and streaming JSONL/CSV dataset export.
- **Phase 7** — Conversation replay / time-travel with provider/prompt overrides and fork badges.
- **Phase 8** — Redis sliding-window rate limiting with per-user exemption.
- **Phase 9** — Public embed widget: `EmbedToken`, token-authed `/api/embed/chat` with CORS, admin token management, `public/embed.js` injector, standalone widget page.
- **Phase 10** — Multi-model race mode: fan-out to 2–3 providers, side-by-side results, vote-best (non-streaming by design).

Also implemented: conversation pin/archive/folder/color-tags/search, share links, pause/resume, transcript download, eval runner.

**Planned (not started):**
- **Phase 11** — Click-to-trace citations (`MessageCitation`, clickable cited spans → source chunk popover).
- **Phase 12** — Conversation branching tree (git-like fork explorer extending replay).
- **Phase 13** — Visible reasoning trace (live `thought` SSE events + `ReasoningTrace` model).
- **Phase 14** — Generative UI widgets (slider/choice/chart directives rendered in chat).
- **Phase 15** — Proactive ambient insights (scheduled BullMQ worker surfacing cross-conversation suggestions).

**Known Issues / Technical Debt:**
- RAG embeddings stored as JSON float arrays; upgrade path is pgvector.
- Workers are excluded from docker-compose — must be started manually in production.
- Race mode blocks until all providers respond (no per-provider streaming).

---

## 16. Important Decisions

**Decision:** Fire-and-forget log shipping via internal HTTP (`/api/ingest`)
**Reason:** Keeps chat latency independent of logging; logging failures don't degrade UX.
**Impact:** Logs may be lost if the server restarts before enqueue. DLQ mitigates persistent failures.

**Decision:** BullMQ + Redis for ingestion and quality-score queues
**Reason:** Burst tolerance and retry semantics without blocking chat.
**Impact:** Redis is a hard runtime dependency. Workers run as separate processes.

**Decision:** Deterministic A/B variant selection via SHA-256 hash
**Reason:** A conversation always receives the same prompt variant — no mid-conversation drift.
**Impact:** Variant cannot be manually overridden per request; only model-level overrides via `modelOverrides`.

**Decision:** HMAC-signed session cookie instead of JWT/OAuth
**Reason:** Minimal dependency surface; tamper-proof with a single shared secret.
**Impact:** No token rotation/expiry claims; secret rotation invalidates all sessions.

**Decision:** Race mode uses `Promise.allSettled` (non-streaming)
**Reason:** Spec calls for complete side-by-side comparison; partial streams complicate voting UX.
**Impact:** Results appear only after the slowest provider finishes.

**Decision:** Decomposed frontend (orchestrator + presentational chat components)
**Reason:** The original single-component `ChatUI` was blocking feature work; Phase 0.3 split it structurally with no behaviour change.
**Impact:** Sub-components are props-only; all state remains in `ChatUI.tsx`.

---

## 17. AI Coding Agent Instructions

**Before changing code:**
- Read `CLAUDE.md` first — it is the authoritative phase spec and invariants list.
- Read the relevant `src/lib/` module entirely — most logic is in lib, not routes.
- Check `prisma/schema.prisma` before adding or modifying any DB query.

**When adding features:**
- New LLM providers: add to `ProviderName` union in `src/lib/llm.ts`, implement in `runProvider`.
- New moderation rules: pattern arrays in `src/lib/safety.ts` only.
- New Prisma changes require a migration named `YYYYMMDD_phase{N}_{description}`.
- All protected routes call `requireSessionUser()` first; admin routes also call `requireRole()`.

**When editing the frontend:**
- All mutations call `refresh()` after completion.
- No external state libraries or component libraries without explicit approval.
- Color tag format (`label::#hex`) is a serialization convention — do not change without migrating data.

**When refactoring:**
- Ingestion must remain non-blocking from the chat path.
- Prompt resolution must always write a `PromptDecision` record.
- Safety audit logs must be written for both `blocked` and `allowed` outcomes, input and output phases.

**When uncertain:**
- Prefer consistency with existing patterns (inline auth, lib functions, direct Prisma calls) over new abstractions.
- Run `node evals/run.mjs` before declaring a phase done; update `CHANGELOG.md`.
