# Ollive AI — CLAUDE.md

This file is the authoritative reference for continuing development on this project. Read it at the start of every session.

---

## Project Overview

**Ollive AI** is a Next.js 15 + PostgreSQL + BullMQ application for LLM inference logging and management. It provides a chat UI backed by a two-tier inference architecture, with structured telemetry, prompt versioning, safety moderation, and per-user workspaces.

**Inference architecture:** PRIMARY is any self-hosted OpenAI-compatible endpoint (vLLM/SGLang/Ollama — the code has no vendor-specific branches for it) via `LLM_BASE_URL` + `LLM_CHAT_MODEL` (flagship) / `LLM_SMALL_MODEL` (background jobs). BACKUP is Gemini (`GEMINI_API_KEY`), used automatically only when the primary endpoint fails before any token has streamed back. Legacy providers (Grok, OpenAI cloud, Anthropic, Ollama-direct) exist as adapters but are excluded from `configuredProviders()` unless `ENABLE_EXTRA_PROVIDERS=true`, and even then are manual-override-only (e.g. race mode) — never part of automatic failover. See `docs/architecture-notes.md` for the full env var table.

**Stack:** Next.js 15 (App Router), TypeScript, Prisma ORM, PostgreSQL (+ pgvector), BullMQ + ioredis, React (client components only where needed).

---

## Invariants — Never Break These

- Ingestion is **fire-and-forget** — never `await sendLog(...)`. Use `void sendLog(...)`. Every `sendLog()` call needs a fresh `eventId: crypto.randomUUID()`.
- `resolveSystemPrompt()` writes a `PromptDecision` record only when an experiment is `RUNNING` for that profile or the caller passed `versionOverride` — not on every request (see `src/lib/prompt-manager.ts`).
- Safety audit logs written for **both** `blocked` and `allowed` outcomes (input + output phases).
- Every protected route calls `requireSessionUser()` as its **first** statement.
- All new business logic goes in `src/lib/` — not inline in API routes.
- Validate all external inputs with Zod at every new system boundary.
- No new state managers or Context providers on the frontend — use local React state only.
- No new top-level npm dependencies without a justification comment.
- All new Prisma model changes require a migration file — never `db push` in production.
- Migration naming: `YYYYMMDD_phase{N}_{description}` (e.g. `20260613_phase0_hmac_session`).
- Automatic provider failover is always `[primary, gemini]` — never add a third provider to the automatic plan. New legacy/manual-only providers: add to `ProviderName` union in `src/lib/llm.ts`, implement in `runProvider`, gate behind `ENABLE_EXTRA_PROVIDERS`.
- New moderation rules: add to pattern arrays in `src/lib/safety.ts` only (the regex path — `SAFETY_JUDGE=llm` is a separate, optional path).

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

### Phase 2 — Prompt Studio ✅ COMPLETE

**Implemented** (found already built, status marker was stale): `PromptProfile`/`PromptVersion` models back a two-pane admin UI. `GET/POST /api/admin/prompts`, `GET/POST /api/admin/prompts/:profileKey/versions`, `POST /api/admin/prompts/:profileKey/activate`, `POST /api/admin/prompts/:profileKey/rollback` — all ADMIN-only via `requireRole`. `src/app/admin/prompts/page.tsx` — profile list + version editor, `src/lib/diff.ts` Myers diff viewer, in-page test panel that calls `POST /api/chat` with `promptVersionOverride`. `PromptVersion` also carries `variantA`/`variantB`/`abRatioA` for inline A/B testing, resolved in `resolveSystemPrompt()`. Note: the live-preview log lands in `PromptDecision` (no `metadata` column — the existing `version`/`variant` fields capture it).

---

### Phase 3 — Role-Based Access Control ✅ COMPLETE

**Implemented** (found already built, status marker was stale): `UserRole` enum (`VIEWER|ANALYST|PROMPT_EDITOR|ADMIN`) on `User`. `src/lib/rbac.ts` — `requireRole(user, minRole)` throws a 403-tagged error. `GET /api/admin/users`, `PATCH /api/admin/users/:id`, plus `PATCH /api/admin/users/:id/budget` (Phase 22). `src/app/admin/users/page.tsx` — user table with inline role selector.

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

### Phase 6 — Quality Scoring & Dataset Export ✅ COMPLETE

**Implemented** (found already built, status marker was stale): `quality-score-queue` (`src/lib/queue.ts`) + `src/workers/quality-score-worker.ts` score each assistant `ChatMessage` via `src/lib/quality-scorer.ts` (heuristic length/repetition/structure/refusal-penalty scoring, no LLM call) into the `QualityScore` model (`@unique` on `messageId`). `GET /api/export/dataset` streams a JSONL/CSV export via `TransformStream`. `worker:quality-score` npm script + `docker-compose.yml` service. Consumed by Phase 21's challenger-evaluation metrics.

---

### Phase 7 — Conversation Replay & Time-Travel ✅ COMPLETE


**Prerequisite Prisma migration:** add `replayMeta Json?` to `Conversation`.

**New route:** `POST /api/conversations/:id/replay` — re-runs turns sequentially with provider/prompt overrides.

**UI:** "Replay" option in conversation context menu. Shows "Forked from [original]" badge.

---

### Phase 8 — Rate Limiting ✅ COMPLETE

**Implemented** (found already built, status marker was stale). **New lib:** `src/lib/rate-limiter.ts` — sliding-window using Redis `INCR`+`EXPIRE`.

**Keys:** `ratelimit:{userId}:minute|hour|day`. Default limits configurable via env.

**New env vars:** `RATE_LIMIT_PER_MINUTE` (20), `RATE_LIMIT_PER_HOUR` (200), `RATE_LIMIT_PER_DAY` (1000).

**Prerequisite Prisma migration:** add `rateLimitExempt Boolean @default(false)` to `User`.

**Applied:** in `POST /api/chat` immediately after `requireSessionUser()`. Returns 429 + `X-RateLimit-*` headers.

---

### Phase 9 — Public Embed Widget ✅ COMPLETE

**Prisma model:** `EmbedToken` (`token`, `userId` owner, `promptProfileKey`, `allowedOrigins String[]`, `isActive`).

**New route:** `POST /api/embed/chat` — auth via `X-Embed-Token` header (`src/lib/embed-auth.ts`), no session cookie. CORS enforced against `allowedOrigins` when non-empty; `OPTIONS` preflight handled.

**Admin routes:** `GET/POST /api/admin/embed-tokens`, `PATCH/DELETE /api/admin/embed-tokens/:id` (ADMIN role).

**Pages:** `src/app/admin/embed/page.tsx` (token management), `src/app/embed/[token]/page.tsx` (standalone widget chat UI).

**New file:** `public/embed.js` — vanilla JS iframe injector, reads `data-token`/`data-base-url`/`data-width`/`data-height`.

**Note:** `resolveSystemPrompt()` in `src/lib/prompt-manager.ts` gained an optional `profileKey` param to support per-embed-token prompt profiles.

---

### Phase 10 — Multi-Model Debate / Race Mode ✅ COMPLETE

Fans a single user prompt out to 2–3 providers concurrently and renders all responses side-by-side; the user picks a winner.

**New Prisma model:** `RaceResult` (`messageId` FK to `ChatMessage`, `provider`, `model`, `content`, `latencyMs`, `tokenCount`, `votedBest Boolean @default(false)`). Migration: `20260628091323_20260628_phase10_race_results`.

**New route:** `POST /api/chat/race` — `requireSessionUser()` first; Zod-validated `{ conversationId?, content, providers: ProviderName[] }` (2–3 providers); auto-creates a conversation when `conversationId` is omitted (mirrors `/api/chat`); runs input moderation + persists the user message + `resolveSystemPrompt()` once, then fans the shared context out via `Promise.allSettled` calling `runProvider` directly per provider. Output moderation runs per provider (refusal template swapped in + `SafetyAuditLog` row on block); one `RaceResult` row persisted per successful provider; fire-and-forget log dispatch per provider (success or error) via `sendLog`. Providers that error are reported in an `errors[]` array rather than failing the whole request.

**New route:** `POST /api/chat/race/:messageId/vote` — sets `votedBest` on the chosen `RaceResult`, clears it on siblings, in a single transaction.

**UI:** "Race mode" toggle + inline provider chip picker in `ChatInput.tsx`; `RacePane.tsx` renders each provider's result as a card (provider, model, latency, tokens) below the triggering message via `MessageList.tsx`, with a "Vote best" button and gold-bordered winner state. `GET /api/conversations` includes `raceResults` per message so race history survives a reload.

**Note:** this is non-streaming by design (the technical spec calls for `Promise.allSettled`, which blocks until every provider responds) — race results appear once all providers finish rather than token-by-token.

---

### Phase 11 — Click-to-Trace Citations ✅ COMPLETE

Lets a user click any sentence in an assistant response and see the exact RAG chunk(s) that justified it, instead of citations being implicit.

**Implemented (2026-06-28):** `MessageCitation` model (migration `20260628120000_20260628_phase11_message_citations`). `retrieveRelevantChunks()` returns `RetrievedChunk[]` (id + score + excerpt offsets); `resolveSystemPrompt()` returns `ragChunks`; `persistCitations()` writes one row per injected chunk after the assistant message is created in both `POST /api/chat` paths. `GET /api/messages/:messageId/citations` (ownership-checked) returns citations + chunk/document metadata. `MessageBubble.tsx` renders a "📎 Sources" chip row with a per-chunk popover that highlights the justifying excerpt.

**Prerequisite Prisma migration:** add `MessageCitation` model (`messageId`, `chunkId` → `KnowledgeChunk`, `relevanceScore Float`, `excerptStart Int`, `excerptEnd Int`). Migration name: `20260628_phase11_message_citations`.

**Library change:** `retrieveRelevantChunks()` in `src/lib/rag.ts` returns chunk ids + scores alongside text; chat route persists a `MessageCitation` row per chunk actually injected into the prompt for that turn.

**New route:** `GET /api/messages/:messageId/citations` — `requireSessionUser()` first; returns citations with chunk source metadata.

**UI:** `MessageBubble.tsx` wraps cited spans in a clickable highlight; click opens a popover showing the source chunk text and originating `KnowledgeDocument` filename.

---

### Phase 12 — Conversation Branching Tree ✅ COMPLETE

Extends Phase 7 replay into a visual git-like fork explorer — branch from any message, see sibling branches side-by-side, instead of replay only ever forking the whole conversation.

**Implemented (2026-07-05):** migration `20260628130000_20260628_phase12_branching` adds `Conversation.rootConversationId` and `ChatMessage.branchParentId` (self-relation `MessageBranch`, `onDelete: NoAction`, indexed). `POST /api/conversations/:id/branch` clones messages up to and including `fromMessageId`, links the branch point via `branchParentId`, sets `rootConversationId`, stores fork metadata in `replayMeta` (`mode: "branch"`), and — when branching from a user turn — regenerates the assistant reply via Phase 7's replay plumbing under optional provider/prompt overrides. `GET /api/conversations/:id/tree` returns `{ rootId, nodes[] }` for the whole tree. `BranchTree.tsx` renders a collapsible tree in `ConversationSidebar.tsx` (shown once a conversation has ≥1 branch); a "⑂ Branch from here" hover action on each `MessageBubble` triggers a branch and switches to it.

**Prerequisite Prisma migration:** add `ChatMessage.branchParentId String?` (self-relation) and `Conversation.rootConversationId String?`. Migration name: `20260628_phase12_branching`.

**New route:** `POST /api/conversations/:id/branch` — `requireSessionUser()` first; body `{ fromMessageId }`; clones conversation up to and including `fromMessageId`, sets `branchParentId`/`rootConversationId`, reuses replay's provider/prompt-override plumbing from Phase 7.

**New route:** `GET /api/conversations/:id/tree` — returns the full branch tree (root + all descendants) for sidebar rendering.

**UI:** new `BranchTree.tsx` in `src/components/chat/` — collapsible tree view in `ConversationSidebar.tsx`; "Branch from here" option added next to the existing "Replay" context-menu item in `MessageBubble.tsx`.

---

### Phase 13 — Visible Reasoning Trace ✅ COMPLETE

Surfaces step-by-step reasoning as a live, expandable tree while the response streams, instead of only showing final text.

**Implemented (2026-07-07):** migration `20260628140000_20260628_phase13_reasoning_trace` adds `ReasoningTrace` (`messageId` unique, `provider`, `steps Json`). `src/lib/reasoning-trace.ts` provides `REASONING_SUFFIX`, `extractReasoningSteps()`, `createThoughtSplitter()`, `buildReasoningSteps()` (all Zod-validated), and fire-and-forget `persistReasoningTrace()`. `streamLLMWithLogging`/`runProvider` accept an opt-in `onThought` callback (streaming chat path only — race/replay/embed callers untouched): Anthropic uses native adaptive thinking (`thinking: {type: "adaptive", display: "summarized"}`, `thinking_delta` events line-buffered so each `onThought` call is one complete step); all other providers get `REASONING_SUFFIX` appended to the system message and their leading `Thought:` lines diverted to `onThought`, never reaching the visible stream. `POST /api/chat` (streaming) emits `data: {"thought": "..."}` SSE events and persists the trace after the assistant message is created; `GET /api/conversations` includes `reasoningTrace` per message so panels survive reload. `MessageBubble.tsx` renders a collapsible "Thinking" panel — live-expanded while streaming, collapsed by default once complete.

**Prerequisite Prisma migration:** add `ReasoningTrace` model (`messageId` unique, `steps Json`, `provider`). Migration name: `20260628_phase13_reasoning_trace`.

**New lib:** `src/lib/reasoning-trace.ts` — `extractReasoningSteps(provider, rawResponse)`: uses native reasoning/thinking output where the provider exposes it (Anthropic extended thinking, OpenAI reasoning summaries), otherwise parses structured `Thought:`/`Step:` markers from a reasoning-primed system suffix. Zod-validates the parsed step array before persisting.

**Integration:** `streamLLMWithLogging` in `src/lib/llm.ts` emits an additional `data: {"thought": "..."}` SSE event type alongside existing `token` events; `ReasoningTrace` persisted once the full response is assembled (fire-and-forget, same pattern as `InferenceLog`).

**UI:** collapsible "Thinking" panel above the response text in `MessageBubble.tsx`, populated live from `thought` SSE events, collapsed by default once streaming completes.

---

### Phase 14 — Generative UI Widgets ✅ COMPLETE

Lets the model render an interactive widget (slider, choice buttons, small chart) inside the chat instead of describing one in prose; the widget's user interaction feeds back into the conversation as a new turn.

**Implemented (2026-07-07):** migration `20260628150000_20260628_phase14_widget_interaction` adds `WidgetInteraction` (`messageId` unique, `widgetType`, `schema Json`, `userResponse Json?`). `src/lib/generative-ui.ts` (client-safe, no Prisma) provides the Zod widget schemas, `parseWidgetDirective()`, `validateWidgetResponse()`, `summarizeWidgetResponse()`, and `WIDGET_SUFFIX` (appended to the system prompt in `buildConversation` so the model knows the directive format). Both `/api/chat` paths strip the directive from the persisted text, persist the `WidgetInteraction` row, and return it (`widget` field in the JSON response / `done` SSE event); `GET /api/conversations` includes `widgetInteraction` per message. `PATCH /api/messages/:messageId/widget` validates and stores `userResponse`. `WidgetRenderer.tsx` renders below `MessageBubble` via `MessageList.tsx`; on interaction `ChatUI.respondToWidget` PATCHes the response then auto-sends a synthesized follow-up user turn through the existing streaming send path.

**Prerequisite Prisma migration:** add `WidgetInteraction` model (`messageId`, `widgetType`, `schema Json`, `userResponse Json?`). Migration name: `20260628_phase14_widget_interaction`.

**New lib:** `src/lib/generative-ui.ts` — Zod schemas for supported widget types (`slider`, `choice`, `chart`); `parseWidgetDirective(rawResponse)` extracts a fenced ` ```widget ` JSON block from the LLM output and validates it against the matching schema.

**Integration:** chat route detects a widget directive in the assembled response, strips it from the displayed text, persists a `WidgetInteraction` row, and includes the widget payload in the API response.

**UI:** new `WidgetRenderer.tsx` in `src/components/chat/` — renders the typed widget below `MessageBubble.tsx`; on user interaction, posts `userResponse` back to `PATCH /api/messages/:messageId/widget` and auto-sends a synthesized follow-up user turn summarizing the interaction.

---

### Phase 15 — Proactive Ambient Insights ✅ COMPLETE

The system notices patterns across a user's conversation history and surfaces a suggestion unprompted, instead of only ever responding to direct questions.

**Implemented (2026-07-07):** migration `20260628160000_20260628_phase15_proactive_insights` adds the `InsightStatus` enum (`PENDING|SENT|DISMISSED`) and `ProactiveInsight` model (`userId`, `triggerReason`, `suggestedMessage`, `relatedConversationIds String[]`, `status`, indexed `[userId, status, createdAt]`). `src/lib/ambient-insights.ts` holds the scan/detection logic (`findActiveUserIds`, `generateInsightForUser` — LLM pattern detection via `callLLMWithLogging`, Zod-validated, confidence-thresholded, one PENDING insight per user max). `ambient-insight-queue` + `src/workers/ambient-insight-worker.ts` run a repeatable `scan` job (default hourly) that fans out per-user jobs. `GET /api/insights/pending` (marks returned insights `SENT`) and `DELETE /api/insights/:id` (dismiss). `ChatUI.tsx` renders a dismissible banner polled via `refresh()`; "Explore" prefills the composer. `npm run worker:ambient-insight` + docker-compose service added.

**Prerequisite Prisma migration:** add `ProactiveInsight` model (`userId`, `triggerReason`, `suggestedMessage`, `relatedConversationIds String[]`, `status` enum `PENDING|SENT|DISMISSED`). Migration name: `20260628_phase15_proactive_insights`.

**New BullMQ queue:** `ambient-insight-queue` in `src/lib/queue.ts`, scheduled (BullMQ repeatable job) rather than triggered per-request.

**New worker:** `src/workers/ambient-insight-worker.ts` — periodically scans recent `InferenceLog`/`KnowledgeChunk` history per active user for recurring topics, calls an LLM with a summarization+pattern-detection prompt, writes a `ProactiveInsight` row when confidence exceeds threshold.

**New route:** `GET /api/insights/pending` — `requireSessionUser()` first; returns the current user's `PENDING` insights, marks them `SENT`.

**New route:** `DELETE /api/insights/:id` — dismiss an insight (`status = DISMISSED`).

**UI:** dismissible toast/banner in `ChatUI.tsx`, polled via existing `refresh()` cadence; clicking an insight opens a prefilled chat turn referencing the related conversations.

**New npm script:** `worker:ambient-insight`. **Add to `docker-compose.yml`** as a new service, same pattern as the quality-score worker (Phase 6).

---

### Phase 16 — Semantic Conversation Search ✅ COMPLETE

Full-workspace natural-language search across all of a user's conversations using embeddings (spec in `FUTURE_FEATURES.md`).

**Implemented (2026-07-08):** migration `20260707192126_20260707_phase16_message_embeddings` adds `MessageEmbedding` (`messageId` unique, `vector Json`, `model`, `embeddedAt`). `src/lib/rag.ts` now exports `embedText()`/`cosineSimilarity()`/`EMBEDDING_MODEL` (`"tfidf-hash-512"`) so search shares the RAG embedding function; the `model` column invalidates stale vectors on a future swap. `embedding-queue` (`getEmbeddingQueue()` in `src/lib/queue.ts`) is enqueued fire-and-forget from both `POST /api/chat` paths after the assistant message persists; `src/workers/embedding-worker.ts` embeds a conversation's un-embedded messages in batches (`EMBEDDING_BATCH_SIZE`, idempotent via `skipDuplicates`) — npm script `worker:embedding` + docker-compose service. `scripts/backfill-embeddings.mjs` backfills existing history through the queue. `src/lib/semantic-search.ts` — `searchConversations(userId, query, limit)`: in-process cosine similarity capped at the most recent `SEARCH_MAX_VECTORS` (default 5000) rows, grouped per conversation with best-matching snippet + score. `GET /api/search?q=...` — `requireSessionUser()` first, Zod-validated `q` (1–500 chars), user-scoped. `ConversationSidebar.tsx`: existing search input additionally fires a debounced (300ms) semantic search; results replace the conversation list while active with highlighted snippets; Escape clears.

---

### Phase 17 — Voice Mode (Speech-to-Speech Chat) ✅ COMPLETE

Browser mic capture → transcription → normal chat pipeline → TTS playback of the assistant's response (spec in `FUTURE_FEATURES.md`).

**Implemented (2026-07-11):** no Prisma migration (voice is just an alternate input/output path onto the existing chat pipeline). `src/lib/speech.ts` — `transcribeAudio()` picks provider via `SPEECH_STT_PROVIDER` (default: `openai` Whisper when `OPENAI_API_KEY` is set, otherwise Gemini multimodal audio input, since `GEMINI_API_KEY` is already required); `synthesizeSpeech()` uses OpenAI TTS (`SPEECH_TTS_MODEL`/`SPEECH_TTS_VOICE`, only provider currently supported). `POST /api/speech/transcribe` — `requireSessionUser()` first, `multipart/form-data` (`audio` file, optional `conversationId`), 10 MB cap, returns `{ text }`; logs via `sendLog` (fire-and-forget) only when `conversationId` is present and owned by the caller, since a voice turn often precedes conversation creation. `POST /api/speech/synthesize` — `requireSessionUser()`, Zod body `{ text: string (≤4000 chars), conversationId?: string }`, streams back `audio/mpeg`, same conditional telemetry. UI: 🎙 push-to-talk button in `ChatInput.tsx` using `MediaRecorder` (feature-detects `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4`); on stop, uploads to transcribe and appends the text to the composer — never auto-sends, so the user reviews/edits first (moderation still runs server-side on send regardless). 🔊 speaker toggle in `MessageBubble.tsx` fetches and plays synthesized audio for a completed assistant response.

**Note:** sentence-by-sentence TTS during SSE streaming (mentioned as an option in the spec) is out of scope for this phase — synthesis happens on-demand for the full, already-streamed response, mirroring how Phase 18 shipped tool loops sync-only before considering streaming.

---

### Phase 18 — Agentic Tool Use (Function Calling) ✅ COMPLETE

Lets the assistant call server-defined tools mid-conversation (calculator, current time, RAG lookup, conversation summary), with a visible tool-call trace in the UI.

**Implemented (2026-07-11):** migration `20260711085610_20260707_phase18_tool_calls` adds `ToolCallStatus` enum (`PENDING|SUCCESS|ERROR`) and `ToolCall` model (`messageId` FK, `toolName`, `arguments Json`, `result Json?`, `status`, `latencyMs`). `src/lib/tools/registry.ts` — typed registry with four safe built-ins: `calculator` (hand-rolled recursive-descent evaluator, no `eval`/`Function`), `current_time`, `knowledge_search` (wraps `retrieveRelevantChunks` from `src/lib/rag.ts`, scoped to the conversation), `conversation_summary`. Each entry pairs a JSON schema (sent to providers) with a zod schema (validates arguments the provider returns) — no arbitrary code execution, no shell, no unrestricted fetch. `src/lib/llm.ts` gained `runProviderWithTools()` + a provider-agnostic `ToolTurn` type, kept separate from the streaming-path `runProvider()`; implemented for Anthropic, OpenAI, Grok (OpenAI-compatible), and Gemini — Ollama is skipped (answers in plain text, no tools) since local models rarely support function calling reliably. `src/lib/tools/loop.ts` — `runToolLoop()` calls the model, validates + executes any requested tools (10s timeout each) and re-calls with results appended, up to 5 iterations, hard-falling back to a normal tool-less answer on exhaustion. `POST /api/chat` gained an opt-in zod-validated `toolsEnabled` field; when true the request always answers via the sync/JSON path (tool loops are sync-mode only) and persists one `ToolCall` row per invocation. `GET /api/messages/:messageId/tool-calls` returns a message's tool-call trace. UI: "🛠 Tools" toggle in `ChatInput.tsx`; `ToolCallCard.tsx` renders each call (name, args, collapsed result, latency) inline above the answer in `MessageBubble.tsx`, self-fetched like `CitationsBar`.

**Note:** streaming + tool loops was intentionally out of scope for this phase — a `toolsEnabled` request bypasses SSE entirely (`ChatUI.sendWithTools`) rather than streaming partial tool-call state.

---

### Phase 19 — Scheduled Prompts & AI Digests ✅ COMPLETE

Users schedule recurring prompts ("every Monday 9am, summarize my week's conversations") that run headless and appear as new conversations.

**Implemented (2026-07-11):** migration `20260711091918_20260711_phase19_scheduled_prompts` adds `ScheduledPrompt` (`userId`, `cronExpression`, `prompt`, `provider`, `isActive @default(true)`, `lastRunAt`, `deliveryConversationId`). `src/lib/cron-validate.ts` — hand-rolled strict 5-field cron validator (no new dep); rejects wildcard/step/comma minute fields so the minimum interval is 1 hour. `getScheduledPromptQueue()` in `src/lib/queue.ts`; `src/lib/scheduled-prompts.ts` — `syncScheduleJob()`/`removeScheduleJob()` wrap BullMQ's `upsertJobScheduler`/`removeJobScheduler` keyed `scheduled-prompt:{id}`, using native cron `pattern` support (no hand-rolled next-run math). `src/workers/scheduled-prompt-worker.ts` runs with no session — every query is scoped to the loaded schedule's own `userId`; it builds context from the user's recent conversations, calls `callLLMWithLogging` (free telemetry + `PromptDecision`), creates the delivery conversation on first run or appends to it, and updates `lastRunAt`. `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id` — `requireSessionUser()` first, Zod-validated, capped at `MAX_SCHEDULES_PER_USER` (default 10, checked on create and reactivation), input moderation runs on the stored prompt. UI: `ScheduleModal.tsx` (prompt textarea, provider select, daily/weekly/monthly + time picker mapped to cron client-side, schedule list with pause/resume/delete), opened from a `ConversationSidebar.tsx` entry and the command palette.

**Prerequisite Prisma migration:** add `ScheduledPrompt` model. Migration name: `20260711091918_20260711_phase19_scheduled_prompts`.

**New lib:** `src/lib/cron-validate.ts`, `src/lib/scheduled-prompts.ts`.

**New routes:** `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id`.

**New worker:** `src/workers/scheduled-prompt-worker.ts`. **New npm script:** `worker:scheduled-prompt`. **Added to `docker-compose.yml`.**

**UI:** `src/components/chat/ScheduleModal.tsx`; entry point in `ConversationSidebar.tsx`.

---

### Phase 20 — Live Collaborative Sessions ✅ COMPLETE

Multiple users in the same conversation in real time — shared cursor into one chat, presence indicators, everyone sees streaming tokens live.

**Implemented (2026-07-11):** migration `20260711100801_20260707_phase20_collab` adds `ConversationMemberRole` enum (`OWNER|COLLABORATOR|VIEWER`), `ConversationMember` (`conversationId`, `userId`, `role @default(COLLABORATOR)`, `@@unique([conversationId, userId])`), and `Conversation.isCollaborative @default(false)`. `src/lib/collab.ts`: `assertConversationAccess(user, conversationId, minRole)` is now the single authorization path for every conversation-scoped route — the conversation's creator (`conversation.userId`) is always treated as `OWNER` rank even without an explicit `ConversationMember` row; invited collaborators get one. `collabErrorResponse(error)` is the shared 401/403/404 catch-block mapping every refactored route uses. `publishConversationEvent`/`conversationChannel` publish over Redis (`PUBLISH collab:{id}`, reusing `REDIS_URL` — no new dependency); `acquireSendLock`/`releaseSendLock` wrap `POST /api/chat` in a `SET NX EX` lock so only one member can have an in-flight send per collaborative conversation (30s TTL safety net, released explicitly on completion/abort/error). `createSubscriberConnection()` opens a dedicated `ioredis` connection per SSE request (`SUBSCRIBE` can't share the cached publish/lock connection).

**Centralized authorization refactor:** every route that used to check `conversation.userId === user.id` (or a nested `conversation: { userId }` check) inline now calls `assertConversationAccess` with a role appropriate to the action — `VIEWER` for reads, `COLLABORATOR` for sends/mutations, `OWNER` for delete/share/invite. This closed a pre-existing gap: `POST /api/conversations/:id/cancel` had **no** authentication at all before this phase. `GET /api/conversations` now includes conversations the caller is a member of (not just owner), plus a computed `myRole` field per conversation.

**New routes:** `GET /api/conversations/:id/events` — `requireSessionUser()` + `VIEWER` membership; long-lived SSE response subscribed to the conversation's Redis channel (dedicated subscriber connection, cleaned up on `req.signal` abort); emits `message_created`, `token`, `thought`, and a `presence` heartbeat every 20s. `POST /api/conversations/:id/members` (`OWNER` only, invite by email — creates/updates a `ConversationMember` row and flips `isCollaborative` on), `GET .../members`, `DELETE .../members/:userId` (self-leave, or `OWNER` removing anyone).

**Chat route integration:** `POST /api/chat` mirrors every SSE `token`/`thought` frame and the persisted user/assistant `ChatMessage` rows to `publishConversationEvent` when `conversation.isCollaborative`, gated behind the send lock described above.

**UI:** presence avatar row + "Invite collaborator" button in `ChatUI.tsx`'s chat header, shown for collaborative conversations (owner/collaborator only for the invite button); a `useEffect` opens an `EventSource` against `/api/conversations/:id/events` for the active conversation when collaborative, merging `presence` events into local state and re-`refresh()`-ing on `message_created` (no Context provider — state stays lifted in `ChatUI` as with every other phase). `ChatInput` is disabled when the caller's `myRole` on the active conversation is `VIEWER`.

**Gotcha:** serverless deployments kill long-lived SSE connections; the events subscription doesn't yet implement `Last-Event-ID` client reconnection (documented in `docs/architecture-notes.md`).

---

### Phase 21 — Prompt Optimization Lab (Auto A/B Evolution) ✅ COMPLETE

Closes the loop between Phase 2 (Prompt Studio) and Phase 4/6 (annotations + quality scores): the system auto-generates a challenger prompt version, A/B tests it against the champion on live traffic, and evaluates it for promotion.

**Implemented (2026-07-11):** migration `20260711102527_phase21_prompt_experiments` adds `PromptExperimentStatus` enum (`RUNNING|CONCLUDED_CHAMPION|CONCLUDED_CHALLENGER|ABORTED`) and `PromptExperiment` (`profileKey`, `championVersionId`/`challengerVersionId` → `PromptVersion`, `trafficSplit Float @default(0.1)`, `status`, `minSamples Int @default(100)`, `autoPromote Boolean @default(false)`, `metrics Json?`). `src/lib/prompt-lab.ts`: `pickArmForRequest(experimentId, seed, trafficSplit)` is a deterministic `sha256(experimentId + seed)` hash bucket so a user/conversation stays in one arm for the experiment's lifetime; `evaluateExperiment(experimentId)` aggregates per-arm `MessageAnnotation` thumbs ratio, `QualityScore` mean, and `SafetyAuditLog` refusal rate into a composite success rate and runs a hand-rolled two-proportion z-test (p<0.05, no new dependency) once both arms reach `minSamples`; `generateChallenger(profileKey)` meta-prompts the configured LLM via `callLLMWithLogging` to mutate the champion's base prompt into a new inactive `PromptVersion`. `resolveSystemPrompt()` (`src/lib/prompt-manager.ts`) gained an optional `userId` param — when a profile has a `RUNNING` experiment and the caller didn't pass an explicit `versionOverride`, the request is bucketed into the champion or challenger `PromptVersion` instead of `profile.activeVersion`; the experiment arm is recoverable from the existing `PromptDecision.version` field, so no schema change was needed on that hot-path table. `POST /api/chat` passes `userId: user.id` through.

**New BullMQ queue:** `prompt-lab-queue` (`src/lib/queue.ts`). **New worker:** `src/workers/prompt-lab-worker.ts` — repeatable hourly `scan` job (`PROMPT_LAB_INTERVAL_MINUTES`) fans out an `evaluate` job per `RUNNING` experiment; on a significant, sufficiently-sampled result it concludes the experiment and, only if `autoPromote` is set, activates the challenger version on the profile — default behavior is "conclude and leave for the admin to activate manually."

**New routes (ADMIN):** `GET/POST /api/admin/experiments` (`GET` includes live, unpersisted metrics for `RUNNING` experiments; `POST` takes either an explicit `challengerVersionId` or `generateChallenger: true`, caps `trafficSplit` at 0.5 in the Zod schema, and rejects a second `RUNNING` experiment per profile with 409), `POST /api/admin/experiments/:id/abort`.

**UI:** "Lab" tab next to "Studio" in `src/app/admin/prompts/page.tsx` — experiment table with live arm success rates + z-score significance indicator, "Generate challenger with AI & start" button, abort button.

**Note:** Phase 2 and Phase 6 were both already fully implemented in the codebase ahead of their stale `⬜ NOT STARTED` markers in this file (now corrected above) — no prerequisite work was needed before starting this phase.

---

### Phase 23 — Conversation Intelligence Reports ✅ COMPLETE

One-click "analyze this conversation": an LLM-generated structured report (topics, sentiment arc, unresolved questions, action items) rendered as a slide-over panel and exportable as Markdown.

**Implemented (2026-07-11):** migration `20260711075037_20260711_phase23_reports` adds `ConversationReport` (`conversationId` unique, `report Json`, `model`, `generatedAt`, `messageCountAtGeneration`). `src/lib/conversation-report.ts`: `generateReport(conversationId, userId)` pulls messages (ownership-checked), map-reduces (chunk-summarize via `callLLMWithLogging`) transcripts over `MAX_TRANSCRIPT_CHARS` (12k), then a JSON-output LLM pass Zod-validated against `{ summary, topics[], sentimentArc[], actionItems[], unresolvedQuestions[] }` with one repair-retry on parse/validation failure; output moderation runs on the summary (`SafetyAuditLog` row written for both allowed/blocked); whole pass capped at 30s. Cache hit when `messageCountAtGeneration` matches the current message count — returns without calling the LLM. `POST /api/conversations/:id/report` (generate-or-cached) and `GET /api/conversations/:id/report` (latest only), both `requireSessionUser()` first. UI: "Analyze" in the conversation context menu and command palette → `ReportPanel.tsx` slide-over (summary, topic chips, sentiment sparkline via inline SVG, action-item checklist, unresolved questions, "Copy as Markdown", loading skeleton).

**Prerequisite Prisma migration:** add `ConversationReport` model (`conversationId`, `report Json`, `model String`, `generatedAt DateTime`, `messageCountAtGeneration Int`). Migration name: `20260711075037_20260711_phase23_reports`.

**New lib:** `src/lib/conversation-report.ts`.

**New route:** `POST/GET /api/conversations/:id/report`.

**UI:** `src/components/chat/ReportPanel.tsx`; "Analyze" menu item in `ConversationSidebar.tsx`.

---

### Phase 22 — Cost Guardrails & Budgets ✅ COMPLETE

Hard monthly spend budgets per user with soft warnings, hard cutoffs, and automatic downgrade to a cheap model at the limit (spec in `FUTURE_FEATURES.md`).

**Implemented (2026-07-11):** migration `20260711072750_20260711_phase22_budgets` adds `BudgetAction` enum (`WARN|DOWNGRADE|BLOCK`), `User.monthlyBudgetUsd Float?` / `User.budgetAction @default(WARN)`, and `SpendCache` (`@@unique([userId, month])`, month keyed `"YYYY-MM"` — rollover automatic, no cron). `src/lib/budget.ts`: `recordSpend()` (cost via `src/lib/cost.ts`; upsert-increments `SpendCache` then `SET`s the authoritative DB total into Redis `spend:{userId}:{month}` so the cache can never drift), `checkBudget()` (Redis-first, DB fallback with write-back; warning at 80%), `downgradeProvider()` (`BUDGET_FALLBACK_PROVIDER`/`BUDGET_FALLBACK_MODEL` env). Spend recording happens in the **ingest worker** (success logs with token counts only; userId resolved via the conversation) — never in the request path. `POST /api/chat` checks the budget after auth + rate limiting: BLOCK → 402; DOWNGRADE → `providerOverride`/`modelOverride` passed to the LLM call (new pass-through params on `callLLMWithLogging`/`streamLLMWithLogging`/`executeWithFailover`) + `x-budget-downgraded: true` response header; warning → `x-budget-warning` header. Routes: `GET /api/budget` (own status), `PATCH /api/admin/users/:id/budget` (ADMIN, Zod: positive ≤ 10000 or null, `budgetAction`). UI: usage meter atop `ConversationSidebar.tsx` (yellow ≥80%, red ≥100%; budget fetched in `ChatUI.refresh()`), red banner + disabled input when blocked, dismissible notice when a response carries the downgrade header.

---

### Phase 24 — Workspace Command Palette (⌘K) ✅ COMPLETE

Global keyboard-driven palette: jump to conversations, trigger actions, fuzzy-matched and fully keyboard navigable (spec in `FUTURE_FEATURES.md`).

**Implemented (2026-07-08):** no migration, no new dependencies. `src/lib/fuzzy.ts` — hand-rolled subsequence fuzzy matcher (`fuzzyMatch`/`fuzzyFilter`, scores word starts + consecutive runs, returns match indices for highlighting). `src/components/chat/CommandPalette.tsx` — modal overlay rendered by `ChatUI.tsx` when `paletteOpen`; registry = static actions built from existing `ChatUI` callbacks (new conversation, race-mode toggle, per-provider race chips, show/hide archived, share/replay/archive of the active conversation) + the conversation list from props. `>` prefix filters to actions, `#` to conversations; a debounced (300ms) async "Semantic matches" section calls Phase 16's `GET /api/search` and degrades gracefully on failure. `ChatUI.tsx` registers one global `keydown` listener for the `⌘/Ctrl+K` toggle only (textarea keys otherwise untouched); the palette handles arrows/Enter/Escape itself, traps Tab, autofocuses its input, and restores focus on close.

---

### Phase 25 — Two-Tier Provider Architecture Migration ✅ COMPLETE

Restructured inference around a self-hosted primary endpoint (any OpenAI-compatible API — vLLM/SGLang/Ollama) with Gemini as an automatic backup, closing a set of correctness/security bugs found in an architecture audit (open `/api/ingest` + signin, fake grok/ollama streaming, hash-based idempotency, hardcoded provider assumptions throughout).

**Implemented (2026-07-12):**
- **Providers** (`src/lib/llm.ts`): `ProviderName` gained `"primary"`; `configuredProviders()` returns `["primary" if LLM_BASE_URL, "gemini" if GEMINI_API_KEY]` plus legacy providers only when `ENABLE_EXTRA_PROVIDERS=true`. `smallModel()` added for background-job models. `getProviderPlan()` is always `[primary, gemini]` filtered to configured — no more routing-policy provider selection. `executeWithFailover()` only fails over pre-first-token on a typed status/network check (no message substring sniffing); errors are tagged with the actually-attempted provider/model (`lastAttemptFromError()`) instead of hardcoding `"gemini"` in error logs. `runProvider`/`runProviderWithTools` reuse the generalized `callOpenAI`/`streamOpenAI`/`callOpenAIWithTools` (accept `baseURL`/`apiKey`) for both `"primary"` and legacy `"openai"`. `chat/route.ts` derives provider/model from `getProviderPlan()`/`providerModel()` instead of `GEMINI_API_KEY`/`GROK_API_KEY` presence checks; both the sync JSON response and the streaming `done` SSE event now include `provider`/`model`.
- **Logging resilience**: `src/lib/log-sink.ts` (`writeLogDirect()`) writes `InferenceLog` directly against Postgres. `sendLog()` enqueues in-process onto BullMQ (`getIngestQueue()`) when `REDIS_URL` is set, falling back to `writeLogDirect()` on any failure or when Redis isn't configured — a log is never silently dropped. `POST /api/ingest` is now for external producers only, gated on `x-ingest-token === INGEST_TOKEN` (503 if unset).
- **Idempotency**: `LogEvent`/`IngestPayload` gained a required `eventId`, generated via `crypto.randomUUID()` at the start of every logging call site (`callLLMWithLogging`, `streamLLMWithLogging`, and the tool-loop/race/speech routes that log manually). `InferenceLog.eventId String @unique`; both the ingest worker and `writeLogDirect()` upsert on it. The old `sha256(payload)` hash-based id generation is gone.
- **Auth**: `User.passwordHash` (nullable, scrypt via `node:crypto` — no new dependency, `src/lib/password.ts`). `POST /api/auth/signup` creates an account; `POST /api/auth/signin` now verifies a password instead of upserting on email alone (previously anyone could sign in as anyone by just supplying their email). `scripts/seed-admin.mjs` (`npm run seed:admin`) creates/updates an `ADMIN` user from `ADMIN_EMAIL`/`ADMIN_PASSWORD`. `AuthGate.tsx` gained a password field and a signin/signup mode toggle.
- **Safety** (`src/lib/safety.ts`): removed `"step-by-step"`/`"do this first"` from `OUTPUT_BLOCK_PATTERNS` (over-broad — matched ordinary tutorials). `SAFETY_JUDGE=llm` runs a JSON-verdict classifier via `smallModel()` on the primary endpoint (zod-validated, fails open to the regex path on any error); `moderateInput`/`moderateOutput` are now async — all ~9 call sites across the codebase updated to `await`.
- **Quality scoring** (`src/lib/quality-scorer.ts`): `QUALITY_JUDGE=llm` rubric-scores (helpfulness/correctness/clarity, 0–100 + reason) via `smallModel()`, zod-validated, fails open to the existing heuristic scorer. `scoreResponseSmart()` is the new dispatcher; the quality-score worker now fetches the preceding user message for rubric context.
- **RAG / embeddings** (`src/lib/rag.ts`, `src/lib/semantic-search.ts`): real embeddings via `POST {EMBEDDING_BASE_URL||LLM_BASE_URL}/embeddings` (OpenAI format, `EMBEDDING_MODEL`), falling back to the hash-TF vector (renamed `"hash-tf-512"`, was misleadingly `"tfidf-hash-512"`) when unset or unreachable. Migration adds the `pgvector` extension and an `embeddingVector vector(768)` column (dimension configurable via `EMBEDDING_DIM`) + ivfflat cosine index on both `KnowledgeChunk` and `MessageEmbedding`, alongside the existing JSON columns which remain the fallback storage. Retrieval and semantic search try a raw-SQL pgvector cosine query first, falling back to the in-process JSON scan when no real vector is available.
- **Tools** (`src/lib/llm.ts`, `src/lib/tools/loop.ts`): tool calling on `"primary"` reuses `callOpenAIWithTools` with `baseURL`/`apiKey`; Gemini's `functionResponse` turns now use role `"user"` (was `"function"`, invalid per current `@google/genai`). `runToolLoop()` gives one retry on zod-invalid tool arguments — re-asks the model with the validation error appended — before recording a hard `ERROR`. Tool-calling turns use a fixed `TOOL_LOOP_TEMPERATURE = 0.2`; ordinary chat reads `LLM_TEMPERATURE` (default 0.9, unchanged).
- **Reasoning** (`src/lib/reasoning-trace.ts`, `src/lib/llm.ts`): the `"primary"` path no longer gets the `Thought:`-priming `REASONING_SUFFIX`; instead `createThinkTagSplitter()` parses a native `<think>...</think>` block from the stream (buffered tag detection, no-op passthrough when the tag never appears) — matches self-hosted reasoning models (GLM/Qwen3-style) that emit this natively. Anthropic's thinking config fixed to `{ type: "enabled", budget_tokens }` (was the invalid `{ type: "adaptive", display: "summarized" }`); `ANTHROPIC_THINKING_BUDGET_TOKENS` env, clamped below `LLM_MAX_OUTPUT_TOKENS`. Gemini's `thinkingConfig` unchanged.
- **Budget/cost** (`src/lib/cost.ts`, `src/lib/budget.ts`): added a `primary` cost table entry from `LLM_COST_IN_PER_1K`/`LLM_COST_OUT_PER_1K` (default 0). `downgradeProvider()` now always resolves to a member of `configuredProviders()` — primary + `smallModel()` first, then gemini, then whatever else is configured — instead of a hardcoded `"gemini"` fallback that could point at an unconfigured provider.
- **Speech** (`src/lib/speech.ts`): STT order is `WHISPER_BASE_URL` (self-hosted, OpenAI-compatible) first, Gemini backup if `GEMINI_API_KEY` is set, else the route 501s. The old direct-`OPENAI_API_KEY` STT path is gone (point `WHISPER_BASE_URL` at OpenAI's endpoint if you want that).
- **UI**: new `GET /api/providers` (configured providers + models); `ChatUI.tsx`/`ChatInput.tsx`/`ScheduleModal.tsx` fetch it instead of hardcoding `["gemini","grok","openai","anthropic","ollama"]`. Race mode's toggle and provider picker are hidden entirely when fewer than 2 providers are configured.
- **Misc fixes**: collab SSE `token`/`thought` events now carry a per-stream `pendingMessageId` (`crypto.randomUUID()`, generated once per stream) instead of `conversationId` masquerading as a message id; the `done` event also carries it for reconciliation. `chat/route.ts`'s SSE `send()` takes an object and stringifies once, instead of stringifying then re-`JSON.parse`-ing for collab publishing. `resolveSystemPrompt()` writes a `PromptDecision` row only when an experiment is `RUNNING` or `versionOverride` is set (was every request). `prompt-lab.ts`'s `collectArmStats()` went from an N+1 per-decision loop to two grouped queries (`chatMessage.findMany` with `conversationId IN [...]`, `safetyAuditLog.groupBy`) with in-process pairing. Deleted the stale duplicate `evals/run.ts` (kept `evals/run.mjs`, which already covers the same cases with proper ESM env-var handling).
- **Deploy**: `docker-compose.yml` gained `postgres` (`pgvector/pgvector:pg16`, healthchecked), `redis:7` (healthchecked), an `ingest-worker` service (previously missing entirely), and optional `ollama`/`whisper` profiles for a fully local dev stack; the `app` service now runs `npx prisma migrate deploy && npm run start`. `.env.example` and `docs/architecture-notes.md` rewritten around the two-tier env vars.

**Verified:** `npx tsc --noEmit` and `npm run build` pass after every task; migrations applied against the project's Supabase Postgres instance (pgvector extension confirmed available).

---

## Running the App

```bash
# Redis is optional — logging/rate-limiting/collab degrade gracefully without it.
# Start it if you want queue-backed ingestion instead of direct DB writes:
redis-server &

# Start ingest worker (only meaningful with Redis running)
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
