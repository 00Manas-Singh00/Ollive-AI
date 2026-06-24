# Ollive AI — CLAUDE.md

This file is the authoritative reference for continuing development on this project. Read it at the start of every session.

---

## Project Overview

**Ollive AI** is a Next.js 15 + PostgreSQL + BullMQ application for LLM inference logging and management. It provides a chat UI backed by multiple LLM providers (Gemini, Grok), with structured telemetry, prompt versioning, safety moderation, and per-user workspaces.

**Stack:** Next.js 15 (App Router), TypeScript, Prisma ORM, PostgreSQL, BullMQ + ioredis, React (client components only where needed).

---

## Invariants — Never Break These

- Ingestion is **fire-and-forget** — never `await sendLog(...)`. Use `void sendLog(...)`.
- Every prompt resolution must write a `PromptDecision` record.
- Safety audit logs written for **both** `blocked` and `allowed` outcomes (input + output phases).
- Every protected route calls `requireSessionUser()` as its **first** statement.
- All new business logic goes in `src/lib/` — not inline in API routes.
- Validate all external inputs with Zod at every new system boundary.
- No new state managers or Context providers on the frontend — use local React state only.
- No new top-level npm dependencies without a justification comment.
- All new Prisma model changes require a migration file — never `db push` in production.
- Migration naming: `YYYYMMDD_phase{N}_{description}` (e.g. `20260613_phase0_hmac_session`).
- New LLM providers: add to `ProviderName` union in `src/lib/llm.ts`, implement in `runProvider`.
- New moderation rules: add to pattern arrays in `src/lib/safety.ts` only.

---

## Phase Completion Checklist (verify before declaring any phase done)

- [ ] All new routes protected with `requireSessionUser()` (if applicable)
- [ ] All new Prisma models have a migration
- [ ] No `await` on log dispatch calls
- [ ] Zod schemas exist for all new API payloads
- [ ] `refresh()` called after every frontend mutation
- [ ] Eval suite (`node evals/run.mjs`) still passes
- [ ] `CHANGELOG.md` updated with the phase section

---

## Codebase Map

```
src/
  app/
    api/
      auth/           signin, signout, me routes
      chat/           main chat POST route (sync + SSE streaming)
      conversations/  CRUD + cancel/share sub-routes
      ingest/         log ingestion endpoint (Zod-validated)
      prompts/        active prompt + rollback routes
    shared/[token]/   read-only shared conversation view
    globals.css       all CSS variables and component styles
    layout.tsx
    page.tsx          renders <ChatUI />
  components/
    ChatUI.tsx        top-level orchestrator (state + handlers)
    chat/
      AuthGate.tsx         inline sign-in form
      ConversationSidebar.tsx
      MessageList.tsx
      MessageBubble.tsx    renders one message with markdown + code highlight
      ChatInput.tsx        textarea + send button
  lib/
    auth.ts           HMAC session cookie sign/verify; requireSessionUser()
    llm.ts            provider abstraction; callLLMWithLogging; streamLLMWithLogging
    prompt-manager.ts resolveSystemPrompt(); rollback logic
    safety.ts         moderateInput/Output; refusalTemplate
    queue.ts          BullMQ ingest queue
    ingest-schema.ts  Zod schema for LogEvent
    prisma.ts         singleton Prisma client
    types.ts          shared TypeScript types (LogEvent, etc.)
  workers/
    ingest-worker.ts  BullMQ worker that writes InferenceLog to DB
  types/
    css.d.ts          allows importing CSS files in TS
prisma/
  schema.prisma
  migrations/
docs/
  architecture-notes.md  env var table + architecture decisions
evals/
  run.mjs             eval suite — must pass after every phase
CHANGELOG.md
```

---

## Phase Status

### Phase 0 — Security & Stability Baseline ✅ COMPLETE

All five sub-tasks done as of 2026-06-13.

**0.1 HMAC session cookies** (`src/lib/auth.ts`)
- `SESSION_SECRET` env var required (≥32 chars).
- Cookie format: `{userId}.{hmac_sha256_hex}`.
- `verifyAndExtract()` uses `timingSafeEqual` to prevent timing attacks.
- Documented in `docs/architecture-notes.md` env table.

**0.2 Streaming UI** (`src/app/api/chat/route.ts`, `src/components/ChatUI.tsx`)
- Chat route detects `Accept: text/event-stream` header.
- Streaming path calls `streamLLMWithLogging`; emits `data: {"token":"..."}` chunks.
- Terminated with `data: [DONE]`.
- `ChatUI.tsx` reads the SSE stream, appends chunks to `streamingContent` state.
- On `[DONE]`, calls `refresh()` to pull finalised message from DB.
- Fire-and-forget log dispatch happens once after full response assembled.

**0.3 ChatUI decomposition** (`src/components/chat/`)
- Pure structural refactor; no behaviour changes.
- `ChatUI.tsx` is the orchestrator; all sub-components receive props only.

**0.4 Gemini message format** (`src/lib/llm.ts`)
- `toGeminiContents()` builds `Content[]` array (`role: 'user'|'model'`, `parts: [{text}]`).
- System messages prepended to first user turn as Gemini doesn't have a native system role.
- `assistant` → `model` mapping applied.

**0.5 Configurable context window** (`src/app/api/chat/route.ts`)
- `LLM_CONTEXT_WINDOW` env var (default `8`, clamped `[4, 64]`).
- Parsed at module load: `Math.min(64, Math.max(4, Number(process.env.LLM_CONTEXT_WINDOW ?? 8) || 8))`.

---

### Phase 1 — Analytics & Observability Dashboard ⬜ NOT STARTED

**Prerequisite Prisma migration:** add `isAdmin Boolean @default(false)` to `User`.
Migration name: `YYYYMMDD_phase1_add_is_admin`.

**New routes (all require `requireSessionUser()` + `isAdmin` check):**
- `GET /api/analytics/inference` — query params: `from`, `to`, `provider`, `groupBy`. Source: `InferenceLog`.
- `GET /api/analytics/ab-results` — `PromptDecision` joined with `InferenceLog`.
- `GET /api/analytics/safety` — source: `SafetyAuditLog`.
- `GET /api/analytics/cost` — per-user spend using static cost table in `src/lib/cost.ts`.

**New files:**
- `src/lib/cost.ts` — static provider+model → $/1k tokens lookup.
- `src/app/analytics/page.tsx` — protected SSR page with charts using `recharts`.

**New `recharts` dependency** justified: data visualisation, no viable existing alternative in stack.

**Sidebar:** Add "Analytics" link in `ConversationSidebar.tsx` visible only when `user.isAdmin === true`.

---

### Phase 2 — Prompt Studio ⬜ NOT STARTED

**New routes (admin only):**
- `GET /POST /api/admin/prompts`
- `GET /POST /api/admin/prompts/:profileKey/versions`
- `POST /api/admin/prompts/:profileKey/activate`
- `POST /api/admin/prompts/:profileKey/rollback`

**New files:**
- `src/app/admin/prompts/page.tsx` — two-pane layout: profile list + version editor.
- `src/lib/diff.ts` — minimal Myers diff (no external dep) for prompt diff viewer.

**Live preview:** optional `promptVersionOverride` field on chat API payload; log in `PromptDecision.metadata`.

---

### Phase 3 — Role-Based Access Control ⬜ NOT STARTED

**Prerequisite Prisma migration:** replace `isAdmin Boolean` with `UserRole` enum (`VIEWER`, `ANALYST`, `PROMPT_EDITOR`, `ADMIN`). Migrate existing admins to `ADMIN`. Migration name: `YYYYMMDD_phase3_user_roles`.

**New file:** `src/lib/rbac.ts` — `requireRole(user, minRole)` throws 403 if rank insufficient.

**New routes:** `GET /api/admin/users`, `PATCH /api/admin/users/:id`.

**New page:** `src/app/admin/users/page.tsx` — user table with inline role selector.

---

### Phase 4 — Collaborative Annotation ✅ COMPLETE

**New Prisma model:** `MessageAnnotation` (upsert per user per message; `@@unique([messageId, userId])`).

**New routes:**
- `POST /api/messages/:messageId/annotations`
- `GET /api/messages/:messageId/annotations`
- `DELETE /api/messages/:messageId/annotations`

**UI:** Annotation bar below each assistant `MessageBubble` (thumbs up/down, star rating, inline note). No page reload on interaction.

---

### Phase 5 — Multi-Provider Expansion & RAG ✅ COMPLETE

**Provider additions to `src/lib/llm.ts`:**
- `'openai'` — via `openai` npm package.
- `'anthropic'` — via `@anthropic-ai/sdk`.
- `'ollama'` — via Ollama's OpenAI-compatible REST endpoint.

**New env vars:** `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`.

**New Prisma models:** `KnowledgeDocument`, `KnowledgeChunk`.

**New file:** `src/lib/rag.ts` — `ingestDocument()`, `retrieveRelevantChunks()`. Integrated into `resolveSystemPrompt()`.

**New routes:** `POST/GET /api/conversations/:id/documents`, `DELETE /api/documents/:id`.

**UI:** Paperclip button in `ChatInput.tsx` for file upload.

---

### Phase 6 — Quality Scoring & Dataset Export ⬜ NOT STARTED

**New BullMQ queue:** `quality-score-queue`.
**New worker:** `src/workers/quality-score-worker.ts`.
**New Prisma model:** `QualityScore` (linked to `ChatMessage`, `@unique` on `messageId`).
**New lib:** `src/lib/quality-scorer.ts`.
**New route:** `GET /api/export/dataset` — streaming JSONL/CSV export using `TransformStream`.
**Add to `docker-compose.yml`** as a new service.
**Add npm script** `worker:quality-score`.

---

### Phase 7 — Conversation Replay & Time-Travel ✅ COMPLETE


**Prerequisite Prisma migration:** add `replayMeta Json?` to `Conversation`.

**New route:** `POST /api/conversations/:id/replay` — re-runs turns sequentially with provider/prompt overrides.

**UI:** "Replay" option in conversation context menu. Shows "Forked from [original]" badge.

---

### Phase 8 — Rate Limiting ⬜ NOT STARTED

**New lib:** `src/lib/rate-limiter.ts` — sliding-window using Redis `INCR`+`EXPIRE`.

**Keys:** `ratelimit:{userId}:minute|hour|day`. Default limits configurable via env.

**New env vars:** `RATE_LIMIT_PER_MINUTE` (20), `RATE_LIMIT_PER_HOUR` (200), `RATE_LIMIT_PER_DAY` (1000).

**Prerequisite Prisma migration:** add `rateLimitExempt Boolean @default(false)` to `User`.

**Applied:** in `POST /api/chat` immediately after `requireSessionUser()`. Returns 429 + `X-RateLimit-*` headers.

---

### Phase 9 — Public Embed Widget ⬜ NOT STARTED

**New Prisma model:** `EmbedToken` (CORS allowedOrigins, promptProfileKey, isActive).

**New route:** `POST /api/embed/chat` — auth via `X-Embed-Token` header, no session cookie.

**New pages:** `src/app/admin/embed/page.tsx`, `src/app/embed/[token]/page.tsx`.

**New file:** `public/embed.js` — vanilla JS iframe injector.

---

## Running the App

```bash
# Start Redis (required for BullMQ)
redis-server &

# Start ingest worker
npm run worker:ingest &

# Start dev server
npm run dev

# Run eval suite (must pass after every phase)
node evals/run.mjs
```

## Key Patterns

### Adding a new protected API route
```ts
import { requireSessionUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const user = await requireSessionUser(); // always first
    // ... business logic in src/lib/
    return NextResponse.json({ ... });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

### Adding a new Prisma migration
```bash
npx prisma migrate dev --name YYYYMMDD_phaseN_description
```

### Fire-and-forget logging
```ts
void sendLog({ ... }); // never await
```
