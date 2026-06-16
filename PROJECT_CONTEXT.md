# Project Context

## 1. Project Overview

- **Project name:** Ollive AI (package: `llm-inference-logging-system`)
- **Purpose:** LLM-powered chat application with built-in inference logging, safety moderation, prompt version management, and per-user conversation workspace.
- **Core problem solved:** Wraps multi-provider LLM calls with structured operational telemetry (latency, token usage, TTFT), content moderation, and A/B-testable prompt profiles — in a single deployable Next.js app.
- **Target users:** Internal teams / developers evaluating LLM outputs and prompt quality.
- **Current maturity:** MVP

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 19, Next.js 15 App Router | UI, routing, SSR for shared pages |
| Backend | Next.js API Routes (Edge-compatible) | REST endpoints |
| Database | PostgreSQL + Prisma ORM 6 | Persistent storage for all entities |
| Queue | BullMQ + Redis (ioredis) | Async inference log ingestion |
| LLM Providers | Google Gemini (`@google/genai`), Grok (x.ai REST) | Inference |
| Authentication | Custom cookie session (`ollive_session`) | No OAuth/JWT |
| Validation | Zod | API payload schema enforcement |
| Markdown | react-markdown + remark-gfm + rehype-highlight | Chat message rendering |
| Infrastructure | Docker, Vercel | Container and serverless hosting |
| Testing | Custom eval runner (`evals/run.mjs`) | Prompt regression testing |

---

## 3. System Architecture

```
Browser (ChatUI.tsx)
  ↓ POST /api/chat
Chat API Route
  ├─ requireSessionUser()        — session cookie auth
  ├─ moderateInput()             — regex safety check
  ├─ resolveSystemPrompt()       — prompt profile + A/B variant
  ├─ callLLMWithLogging()        — provider execution + failover
  │    └─ fire-and-forget → POST /api/ingest
  └─ moderateOutput()            — regex safety check on LLM response
         ↓
  /api/ingest  →  BullMQ queue (Redis)
         ↓
  ingest-worker.ts  →  InferenceLog written to PostgreSQL
```

Shared read-only pages are SSR (`/shared/[token]/page.tsx`) — no auth required.

---

## 4. Repository Structure

```
/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/           signin, signout, me
│   │   │   ├── chat/           core LLM chat endpoint
│   │   │   ├── conversations/  CRUD + share + pause/resume
│   │   │   ├── ingest/         log ingestion (queue entry point)
│   │   │   └── prompts/        active version get/set, rollback
│   │   ├── shared/[token]/     public read-only conversation view (SSR)
│   │   ├── globals.css         all app styles (dark theme, CSS vars)
│   │   ├── layout.tsx          root HTML shell
│   │   └── page.tsx            mounts <ChatUI />
│   ├── components/
│   │   └── ChatUI.tsx          entire frontend: auth, sidebar, chat (single component)
│   ├── lib/
│   │   ├── auth.ts             cookie session helpers
│   │   ├── ingest-schema.ts    Zod schema for LogEvent
│   │   ├── llm.ts              provider abstraction, failover, streaming, logging
│   │   ├── prisma.ts           shared Prisma client singleton
│   │   ├── prompt-manager.ts   PromptProfile resolution + A/B selection
│   │   ├── queue.ts            BullMQ Queue factory (cached singleton)
│   │   ├── safety.ts           input/output moderation + refusal templates
│   │   └── types.ts            LogEvent type
│   └── workers/
│       └── ingest-worker.ts    BullMQ Worker — writes InferenceLog + DLQ
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── evals/
│   ├── cases.json              eval test cases with golden outputs
│   ├── run.mjs                 eval runner (hits live /api/chat)
│   └── latest-report.json      last eval results
├── docs/architecture-notes.md
├── Dockerfile
└── docker-compose.yml
```

---

## 5. Application Flow

**Chat message:**
```
User types message
→ ChatUI.send() → POST /api/chat
→ requireSessionUser() (cookie)
→ moderateInput() — block or allow
→ resolveSystemPrompt() — fetch active PromptVersion, select A/B variant, log PromptDecision
→ callLLMWithLogging() — run provider(s) with failover
→ moderateOutput() — block or allow
→ ChatMessage saved to DB
→ fire-and-forget POST /api/ingest → BullMQ → ingest-worker → InferenceLog
→ return {conversationId, message}
```

**Auth:**
```
User enters name + email → POST /api/auth/signin
→ upsert User by email → set httpOnly cookie (userId)
→ all subsequent API calls read cookie via requireSessionUser()
```

**Sharing:**
```
User clicks "Copy share link" → POST /api/conversations/:id/share
→ generates UUID shareToken → stored on Conversation
→ /shared/:token renders SSR read-only page (no auth)
```

---

## 6. Core Modules

### LLM Layer (`src/lib/llm.ts`)
Purpose: Multi-provider LLM execution with failover, streaming, and async telemetry logging.
Responsibilities: Provider selection via routing policy (`manual`/`cost`/`latency`/`quality`), exponential failover on retryable errors, token usage capture, TTFT measurement, async log dispatch.
Key exports: `callLLMWithLogging`, `streamLLMWithLogging`
Rules: Log dispatch is always fire-and-forget; chat path must never block on it.

### Safety (`src/lib/safety.ts`)
Purpose: Regex-based content moderation on both input and output.
Responsibilities: Pattern matching against blocklists, returning `ModerationResult`, generating refusal messages.
Rules: Moderation runs synchronously before and after LLM call. All block/allow events are written to `SafetyAuditLog`.

### Prompt Manager (`src/lib/prompt-manager.ts`)
Purpose: Versioned prompt profiles with deterministic A/B testing.
Responsibilities: Ensure default profile exists, resolve active version, select A/B variant via SHA-256 hash of `conversationId:profileKey:version`, log `PromptDecision`.
Rules: Variant assignment is stable per conversation (same conversation always gets same variant).

### Ingestion Pipeline (`/api/ingest` + `src/workers/ingest-worker.ts`)
Purpose: Async idempotent inference log storage.
Responsibilities: Zod validation, SHA-256 idempotency key, BullMQ enqueue, worker writes `InferenceLog`, DLQ on max retries.
Rules: Worker runs as a separate process (`npm run worker:ingest`). Idempotency enforced via `IngestionEvent` status check.

### Auth (`src/lib/auth.ts`)
Purpose: Stateless cookie-based session.
Rules: No password — email upserts user. Session cookie stores raw `userId` (not a signed token). 30-day expiry, `httpOnly`, `sameSite: lax`.

### ChatUI (`src/components/ChatUI.tsx`)
Purpose: Complete frontend — sidebar, conversation management, chat pane, auth form.
Rules: Single client component. All state is local React state. No external state manager. Data is always re-fetched from API after mutations.

---

## 7. Data Model

| Entity | Purpose | Key Relations |
|---|---|---|
| `User` | Account record | owns many `Conversation` |
| `Conversation` | Chat thread + metadata | belongs to `User`; has `ChatMessage[]`, `InferenceLog[]`, `SafetyAuditLog[]`, `PromptDecision[]` |
| `ChatMessage` | Individual turn | belongs to `Conversation`, role: `user`\|`assistant` |
| `InferenceLog` | LLM call telemetry | belongs to `Conversation`; stores latency, tokens, previews, provider, model, status |
| `PromptProfile` | Named prompt configuration | has many `PromptVersion`; tracks `activeVersion` |
| `PromptVersion` | Versioned prompt with A/B variants | `basePrompt`, `variantA`, `variantB`, `abRatioA`, `modelOverrides`, `isRollbackPoint` |
| `PromptDecision` | Per-conversation prompt resolution record | links `Conversation` → profile/version/variant used |
| `SafetyAuditLog` | Moderation event per message | phase: `input`\|`output`, action: `blocked`\|`allowed` |
| `IngestionEvent` | Idempotency tracker for log jobs | status: `processing`\|`processed`\|`failed` |
| `IngestionDLQ` | Failed jobs after max retries | stores raw payload + failure reason |

**Constraints:**
- `Conversation` has compound index on `(userId, isArchived, isPinned, updatedAt)`
- `PromptVersion` unique on `(profileId, version)`
- `shareToken` is unique on `Conversation`
- Cascade deletes from `User → Conversation → *` and `Conversation → ChatMessage/InferenceLog/etc`

---

## 8. API / Communication Layer

- **Style:** REST, JSON, Next.js App Router API routes
- **Auth method:** `requireSessionUser()` — reads `ollive_session` cookie, throws `"UNAUTHORIZED"`
- **Error pattern:** `{ error: string }` with appropriate HTTP status; `UNAUTHORIZED` → 401, provider auth failures → 401, rate limits → 429, model errors → 400, infra failures → 502/500

| Group | Endpoints |
|---|---|
| Auth | `POST /api/auth/signin`, `POST /api/auth/signout`, `GET /api/auth/me` |
| Chat | `POST /api/chat` |
| Conversations | `GET /api/conversations`, `PATCH /api/conversations/:id`, `DELETE /api/conversations/:id` |
| Conversation actions | `POST /api/conversations/:id/share`, `POST /api/conversations/:id/cancel` |
| Ingestion | `POST /api/ingest` |
| Prompts | `GET/POST /api/prompts/active`, `POST /api/prompts/rollback` |

---

## 9. Frontend Architecture

- **Component strategy:** Single monolithic client component (`ChatUI.tsx`). No component library.
- **State management:** Local `useState` only. No Redux/Zustand/Context.
- **Data fetching:** `fetch()` directly in event handlers and `useEffect`. `refresh()` re-fetches conversation list after every mutation.
- **UI system:** Custom CSS in `globals.css` with CSS custom properties. Dark theme. No Tailwind.
- **Routing:** App Router pages: `/` (chat), `/shared/[token]` (read-only SSR).
- **Markdown:** `react-markdown` + `remark-gfm` + `rehype-highlight` with `github-dark` code theme.
- **Auth gate:** Renders inline sign-in form when `user === null`.
- **Tag format:** Color tags serialized as `label::#hexcolor` strings stored in `Conversation.tags[]`.

---

## 10. Backend Architecture

- **Routes:** All in `src/app/api/` — each folder is a route group.
- **Services/logic:** Contained in `src/lib/` — no separate service layer classes.
- **Middleware:** None (Next.js middleware not used). Auth is inline per-route via `requireSessionUser()`.
- **Validation:** Zod only at the ingest boundary (`ingest-schema.ts`). Other routes validate manually.
- **Background jobs:** `ingest-worker.ts` runs as a standalone process; not part of Next.js server.
- **Context window:** Chat route fetches last 8 messages (`take: 8`, `orderBy: createdAt desc`) for LLM context.
- **Conversation status:** `active` | `paused` — paused conversations reject new messages with 409.

---

## 11. Security Model

- **Authentication:** Cookie-based, `httpOnly`, `sameSite: lax`. No password or token signing — cookie stores raw `userId`.
- **Authorization:** All conversation operations verify `userId` matches before DB mutation. Share links are public (no auth) but read-only.
- **Content safety:** Regex blocklists on input (malware, weapons, self-harm) and output (dangerous instructions). All decisions audit-logged.
- **Secrets:** API keys and DB credentials via `.env`. Never committed. `SAFETY_REFUSAL_TEMPLATE` overrides default refusal message.
- **Idempotency:** Ingest events keyed by SHA-256 of payload; prevents duplicate log writes on retries.
- **Known gap:** Session cookie stores raw userId without signing — vulnerable to cookie tampering if attacker can set arbitrary cookies.

---

## 12. Development Rules

**DO:**
- Keep all business logic in `src/lib/` functions.
- Use the shared `prisma` singleton from `src/lib/prisma.ts`.
- Use `requireSessionUser()` at the start of every protected route.
- Keep ingestion fire-and-forget — never `await sendLog(...)`.
- Validate external inputs with Zod at system boundaries.
- Use `void` prefix for intentionally unawaited promises.

**DO NOT:**
- Add new state managers or context providers to the frontend — use local state.
- Add new API dependencies without justification (the dep list is intentionally minimal).
- Block the chat response path on logging or ingestion.
- Duplicate safety checks — `moderateInput`/`moderateOutput` are the canonical path.
- Write prompt content directly into API routes — always go through `resolveSystemPrompt()`.
- Skip writing to `SafetyAuditLog` when moderation fires.

---

## 13. Environment & Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Prisma connection string (pooled, port 6543) |
| `DIRECT_URL` | Prisma direct connection (migrations, port 5432) |
| `REDIS_URL` | BullMQ/ioredis connection URL |
| `LLM_PROVIDER` | Default provider: `gemini` or `grok` |
| `LLM_ROUTING_POLICY` | `manual` \| `cost` \| `latency` \| `quality` |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL` | Gemini model name (default: `gemini-2.5-flash`) |
| `GROK_API_KEY` | x.ai Grok API key |
| `GROK_MODEL` | Grok model name (default: `grok-3-mini`) |
| `INGEST_MAX_RETRIES` | BullMQ job retry attempts (default: 5) |
| `INGEST_RETRY_DELAY_MS` | BullMQ initial backoff delay (default: 1000) |
| `PROMPT_PROFILE_KEY` | Active prompt profile key (default: `chat-default`) |
| `NEXT_PUBLIC_BASE_URL` | Base URL for internal `sendLog` HTTP call |
| `SAFETY_REFUSAL_TEMPLATE` | Override default safety refusal message |
| `EVAL_BASE_URL` | Eval runner target URL (default: `http://localhost:3000`) |

---

## 14. Deployment & Infrastructure

- **Hosting:** Vercel (primary) or Docker.
- **Build:** `vercel-build` script runs `prisma migrate deploy && next build`.
- **Docker:** `node:20-alpine`, exposes port 3000. `docker-compose.yml` mounts prisma dir and loads `.env`.
- **Worker:** Must run separately — `npm run worker:ingest` (tsx process, not part of Next.js). Not included in Docker compose.
- **Database:** External PostgreSQL (Supabase-compatible, requires pooled + direct URLs for Prisma).
- **Redis:** External Redis instance required for BullMQ queue.
- **Migrations:** Applied via `prisma migrate deploy` at deploy time.

---

## 15. Current State

**Implemented:**
- Multi-provider LLM (Gemini + Grok) with routing policies and automatic failover
- Inference logging pipeline (async, idempotent, with DLQ)
- Input and output content moderation with audit trail
- Prompt versioning, A/B testing, rollback
- Per-user conversations with pin, archive, folder, color-tagged labels, search
- Read-only shareable conversation links
- Pause/resume conversations
- Transcript download
- Eval runner for prompt regression

**In Progress / Pending:**
- Streaming chat responses (infrastructure exists in `streamLLMWithLogging` but UI uses sync path)
- Analytics/dashboard for `InferenceLog` data
- Admin interface for prompt profile management

**Known Issues / Technical Debt:**
- Session cookie stores raw `userId` without HMAC signing.
- `ChatUI.tsx` is a single 82-line dense file — needs decomposition before further feature work.
- Ingest worker is excluded from Docker compose — must be started manually in production.
- LLM context window is hardcoded to 8 messages; not configurable.
- Gemini and Grok use different message formats; Gemini receives a single concatenated prompt string, not a proper message array.

---

## 16. Important Decisions

**Decision:** Fire-and-forget log shipping via internal HTTP (`/api/ingest`)
**Reason:** Keeps chat latency independent of logging; logging failures don't degrade user experience.
**Impact:** Logs may be lost if the server restarts between the fire and the queue enqueue. DLQ mitigates persistent failures.

**Decision:** BullMQ + Redis for ingestion queue
**Reason:** Burst tolerance and retry semantics; the ingest path can spike without blocking chat.
**Impact:** Redis is a hard runtime dependency. Worker must run as a separate process.

**Decision:** Deterministic A/B variant selection via SHA-256 hash
**Reason:** Ensures a conversation always receives the same prompt variant — avoids mid-conversation prompt drift.
**Impact:** Variant cannot be manually overridden per request; only model-level overrides are supported via `modelOverrides` JSON.

**Decision:** Single-component frontend (`ChatUI.tsx`)
**Reason:** Speed of iteration at MVP stage.
**Impact:** Component is hard to test and extend; decomposition needed before adding complex features.

---

## 17. AI Coding Agent Instructions

**Before changing code:**
- Read the relevant `src/lib/` module entirely — most logic is in lib, not routes.
- Check `prisma/schema.prisma` before adding or modifying any DB query.
- Verify the existing error handling pattern in the target route before adding new error paths.

**When adding features:**
- New LLM providers go in `src/lib/llm.ts` — add to `ProviderName` union, implement `runProvider` branch.
- New moderation rules go in `src/lib/safety.ts` pattern arrays only.
- New conversation metadata fields require a Prisma migration + schema change + PATCH route update.
- All protected routes must call `requireSessionUser()` as the first statement.

**When editing the frontend:**
- All data mutations must call `refresh()` after completion.
- Do not introduce external state libraries or component libraries without explicit approval.
- Color tag format (`label::#hex`) is a serialization convention — do not change without migrating existing data.

**When refactoring:**
- Ingestion must remain non-blocking from the chat path.
- Prompt resolution must always write a `PromptDecision` record — do not skip it.
- Safety audit logs must be written for both `blocked` and `allowed` outcomes.

**When uncertain:**
- Prefer consistency with existing patterns (inline auth, lib functions, direct Prisma calls) over introducing new abstractions.
