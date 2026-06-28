# Changelog

## Fixes — Response truncation & broken streaming (2026-06-28)

### Fixed
- LLM responses were capped at a hardcoded `max_tokens`/`maxOutputTokens: 900` across every provider, truncating long answers mid-sentence. Replaced with `LLM_MAX_OUTPUT_TOKENS` (default 2048, clamped 256–8192) applied to all providers (Gemini, Grok, OpenAI, Anthropic, Ollama) — and inherited by Race mode via `runProvider`.
- Live streaming on the default Gemini 2.5 models appeared broken — the answer arrived as a single post-"thinking" burst instead of token-by-token. Gemini 2.5 is a thinking model whose hidden reasoning both consumed the (already low) output budget and emitted nothing until complete. Added `thinkingConfig.thinkingBudget`, defaulting to `0` (disabled) via `GEMINI_THINKING_BUDGET`, so the full budget goes to the visible answer and tokens stream as generated. Verified: a short prompt now streams in multiple incremental chunks ending in a clean `done`/`[DONE]`.

## Phase 10 — Multi-Model Debate / Race Mode (2026-06-28)

### Added
- `RaceResult` Prisma model (`messageId` FK to `ChatMessage`, `provider`, `model`, `content`, `latencyMs`, `tokenCount`, `votedBest`); migration `20260628091323_20260628_phase10_race_results`
- `POST /api/chat/race` — `requireSessionUser()` first; Zod-validated `{ conversationId?, content, providers: ProviderName[] }` (2-3 providers); auto-creates a conversation when `conversationId` is omitted (same as `/api/chat`); runs the same input-moderation → persist user message → `resolveSystemPrompt()` pipeline once, then fans the resulting context out to all selected providers via `Promise.allSettled` calling `runProvider` directly; moderates each provider's output independently (writes a `SafetyAuditLog` row per provider, swaps in the refusal template if blocked); persists one `RaceResult` row per successful provider and fire-and-forgets a log per provider (success or error)
- `POST /api/chat/race/:messageId/vote` — sets `votedBest` on the chosen `RaceResult` for that message and clears it on siblings (single transaction)
- `runProvider`, `providerModel`, `configuredProviders`, `sendLog`, `preview` exported from `src/lib/llm.ts` for reuse by the race route
- "Race mode" toggle in `ChatInput.tsx` with an inline provider chip picker (2-3 of `gemini`/`grok`/`openai`/`anthropic`/`ollama`); `RacePane.tsx` renders each provider's `RaceResult` as a card (provider, model, latency, token count) side-by-side below the triggering user message, with a "Vote best" button per card and a gold border on the voted winner
- `GET /api/conversations` now includes `raceResults` on each `ChatMessage` so the sidebar/message list can render race history on reload

### Migrations
- `20260628091323_20260628_phase10_race_results` — adds `RaceResult` table

## Phase 9 — Public Embed Widget (2026-06-28)

### Added
- `EmbedToken` Prisma model — `token` (random, unique), `userId` (owner, attributes conversations), `promptProfileKey`, `allowedOrigins String[]`, `isActive`
- `src/lib/embed-auth.ts` — `requireEmbedToken(req)` validates `X-Embed-Token` header and, when `allowedOrigins` is non-empty, the request `Origin`; `corsHeaders()` builds the matching CORS response headers
- `POST /api/embed/chat` — token-authenticated chat endpoint (no session cookie). Runs input/output moderation and `resolveSystemPrompt` (now accepts an optional `profileKey` to support per-token prompt profiles) the same as `/api/chat`'s sync path; supports `OPTIONS` preflight
- `src/app/admin/embed/page.tsx` + `GET/POST /api/admin/embed-tokens`, `PATCH/DELETE /api/admin/embed-tokens/:id` — admin-only token management UI
- `src/app/embed/[token]/page.tsx` — minimal standalone chat UI rendered inside the widget iframe
- `public/embed.js` — vanilla JS snippet; reads `data-token`/`data-base-url`/`data-width`/`data-height` from its own `<script>` tag and injects a fixed-position iframe pointed at `/embed/[token]`

### Changed
- `resolveSystemPrompt()` accepts an optional `profileKey` param; falls back to the default env-configured profile if the key isn't found

### Migrations
- `20260628072804_20260628_phase9_embed_token` — adds `EmbedToken` table

## Phase 8 — Rate Limiting (2026-06-25)

### Added
- `rateLimitExempt Boolean @default(false)` added to `User`; migration `20260624183319_20260625_phase8_rate_limit_exempt`
- `src/lib/rate-limiter.ts` — `checkRateLimit(userId)`: sliding-window via Redis `INCR`+`EXPIRE` across three keys, `ratelimit:{userId}:minute|hour|day`. Limits configurable via `RATE_LIMIT_PER_MINUTE` (default 20), `RATE_LIMIT_PER_HOUR` (default 200), `RATE_LIMIT_PER_DAY` (default 1000)
- `POST /api/chat` calls `checkRateLimit` immediately after `requireSessionUser()` (skipped when `user.rateLimitExempt` or when `REDIS_URL` is unset); returns `429` + `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Window` headers when exceeded

### Migrations
- `20260624183319_20260625_phase8_rate_limit_exempt` — adds `rateLimitExempt` Boolean column to `User`

## Phase 7 — Conversation Replay & Time-Travel (2026-06-24)

### Added
- `replayMeta Json?` added to `Conversation`; migration `20260624181258_20260624_phase7_replay_meta`
- `POST /api/conversations/:id/replay` — forks the conversation, then replays each original user turn sequentially against a new conversation, regenerating assistant responses (full moderation + `SafetyAuditLog` + `PromptDecision` pipeline reused per turn). Body (Zod-validated): `providerOverride?` (one of `ProviderName`), `promptVersionOverride?`. Stores `{ forkedFrom, forkedFromTitle, providerOverride, promptVersionOverride, startedAt }` on the new conversation's `replayMeta`
- `ProviderName`/`PROVIDER_NAMES` exported from `src/lib/llm.ts`; `getProviderPlan()` and `callLLMWithLogging()` accept an optional `providerOverride` to pin a single provider for a call (used by replay) instead of falling back through the routing policy
- "Replay" option in the conversation context menu (`ConversationSidebar.tsx`); active conversation header shows a "Forked from [original]" badge when `replayMeta` is set

### Migrations
- `20260624181258_20260624_phase7_replay_meta` — adds nullable `replayMeta` Json column to `Conversation`

## Phase 6 — Quality Scoring & Dataset Export (2026-06-24)

### Added
- `QualityScore` Prisma model (`@unique` on `messageId`); migration `20260624175703_20260624_phase6_quality_score`
- `quality-score-queue` BullMQ queue (`src/lib/queue.ts` — `getQualityScoreQueue()`)
- `src/lib/quality-scorer.ts` — heuristic `scoreResponse()`: length, repetition, structure signals minus a refusal-pattern penalty, 0-100
- `src/workers/quality-score-worker.ts` — consumes `quality-score-queue`, upserts `QualityScore` per `ChatMessage`
- `POST /api/chat` enqueues a fire-and-forget scoring job (`enqueueQualityScore`) after each successful (non-moderated) assistant message, sync and streaming paths
- `GET /api/export/dataset` — streaming JSONL/CSV export of `{prompt, completion, qualityScore, breakdown}` rows via `TransformStream`; cursor-paginated reads from `QualityScore`; query params `format`, `minScore`, `from`, `to`; requires `ANALYST` role or above
- `quality-score-worker` service in `docker-compose.yml`
- `worker:quality-score` npm script

### Migrations
- `20260624175703_20260624_phase6_quality_score` — adds `QualityScore` model with `messageId` unique FK to `ChatMessage`

## Phase 5 — Multi-Provider Expansion & RAG (2026-06-24)

### Added
- `openai`, `anthropic` providers added to `ProviderName` union in `src/lib/llm.ts`; `ollama` added via Ollama's OpenAI-compatible REST endpoint (`OLLAMA_BASE_URL`)
- `openai` and `@anthropic-ai/sdk` npm dependencies (justified: official SDKs required to call the OpenAI and Anthropic chat APIs; no viable existing alternative in stack)
- Provider failover: `executeWithFailover()` tries providers in order (`LLM_ROUTING_POLICY`: `manual`/`cost`/`latency`/`quality`) and retries the next configured provider on retryable errors (429/5xx/timeout/network)
- `KnowledgeDocument` and `KnowledgeChunk` Prisma models; migration `20260622_phase5_knowledge_base`
- `src/lib/rag.ts` — `ingestDocument()` chunks uploaded text (~500-token paragraphs) and stores a fixed-width (512-bucket) hashed term-frequency vector per chunk; `retrieveRelevantChunks()` scores chunks for a conversation by cosine similarity against the query vector and returns the top-K texts
- `resolveSystemPrompt()` now accepts `ragQuery` and appends retrieved chunks to the resolved prompt under a `## Context` section
- `POST /api/conversations/:id/documents` — uploads a text file (max 2 MB) and ingests it via `ingestDocument()`; `GET` lists documents for a conversation
- `DELETE /api/documents/:id` — deletes a document owned by the caller (cascades to its chunks)
- Paperclip button in `ChatInput.tsx` for file upload (`.txt`, `.md`, `.csv`, `.json`)
- New env vars: `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`

### Fixed
- `retrieveRelevantChunks()` previously rebuilt its TF-IDF vocabulary from scratch on every call, so stored chunk embeddings (indexed by an ingest-time vocabulary) and the query vector (indexed by a query-time vocabulary) had mismatched dimension ordering, making cosine similarity meaningless. Replaced with a fixed-width hashed term-frequency vector so ingest-time and query-time vectors always share the same dimensions.

### Migrations
- `20260622_phase5_knowledge_base` — adds `KnowledgeDocument` and `KnowledgeChunk` tables

## Phase 4 — Collaborative Annotation (2026-06-22)

### Added
- `MessageAnnotation` Prisma model (`rating`, `thumbs`, `comment`, `@@unique([messageId, userId])`); migration `20260622_phase4_message_annotations`
- `POST /api/messages/:messageId/annotations` — Zod-validated upsert of the caller's own annotation
- `GET /api/messages/:messageId/annotations` — own annotation only, except `ANALYST`/`ADMIN` which see all annotations for the message
- `DELETE /api/messages/:messageId/annotations` — deletes the caller's own annotation
- `AnnotationBar` in `MessageBubble.tsx` — thumbs up/down, 5-star rating, inline note, rendered below each assistant message; updates via local component fetch with no page reload

### Migrations
- `20260622_phase4_message_annotations` — adds `MessageAnnotation` table

## Phase 3 — Role-Based Access Control (2026-06-22)

### Added
- `UserRole` enum (`VIEWER`, `ANALYST`, `PROMPT_EDITOR`, `ADMIN`) on `User` model; migration `20260622_phase3_user_roles` — replaces `isAdmin Boolean`; existing admins migrated to `ADMIN`
- `src/lib/rbac.ts` — `requireRole(user, minRole)` helper; throws `FORBIDDEN` (→ 403) if user's role rank is below minimum
- `GET /api/admin/users` — list all users with name, email, role, conversation count, last active (ADMIN only)
- `PATCH /api/admin/users/:id` — update a user's role; Zod-validated body `{ role }` (ADMIN only)
- `src/app/admin/users/page.tsx` — user management table with inline role dropdown; PATCH on change

### Changed
- All `/api/analytics/*` routes now use `requireRole(user, "ANALYST")` instead of `isAdmin` check
- All `/api/admin/prompts/*` routes now use `requireRole(user, "ADMIN")` instead of `isAdmin` check
- `/api/auth/me` and `/api/auth/signin` now return `role` instead of `isAdmin`
- `ConversationSidebar`: Analytics link visible to `ANALYST`+; Prompt Studio visible to `PROMPT_EDITOR`+; Users link visible to `ADMIN` only
- `analytics/page.tsx`: SSR guard uses role check instead of `isAdmin`

### Migrations
- `20260622_phase3_user_roles` — adds `UserRole` enum, drops `isAdmin`, migrates admins to `ADMIN`

## Phase 2 — Prompt Studio (2026-06-19)

### Added
- `GET /api/admin/prompts` — list all prompt profiles with versions (admin only)
- `POST /api/admin/prompts` — create a new prompt profile with initial version (Zod-validated)
- `GET /api/admin/prompts/:profileKey/versions` — list versions for a profile
- `POST /api/admin/prompts/:profileKey/versions` — create a new version (auto-increments version number)
- `POST /api/admin/prompts/:profileKey/activate` — activate a specific version
- `POST /api/admin/prompts/:profileKey/rollback` — rollback to latest checkpoint version
- `src/lib/diff.ts` — minimal Myers character-level diff algorithm (no external dependency)
- `src/app/admin/prompts/page.tsx` — Prompt Studio: two-pane UI with profile list, version editor (basePrompt, variantA/B, A/B ratio slider, model overrides JSON), version history table with load/activate/diff actions, side-by-side diff viewer, and test panel
- `promptVersionOverride` optional field on `POST /api/chat` — overrides the active prompt version for a single request; logged in `PromptDecision.model` field with `|override:vN` suffix
- "Prompt Studio" link in `ConversationSidebar` visible only to admins

### Changed
- `resolveSystemPrompt()` accepts optional `versionOverride` parameter
- Chat route parses and threads `promptVersionOverride` from request body

### Migrations
- None (no schema changes in Phase 2)

## Phase 1 — Analytics & Observability Dashboard (2026-06-17)

### Added
- `isAdmin Boolean @default(false)` field on `User` model; migration `20260616_phase1_add_is_admin`
- `src/lib/cost.ts` — static cost table (USD/1k tokens) for Gemini, Grok, OpenAI, Anthropic; `calculateCostUsd()` helper
- `GET /api/analytics/inference` — time-series request counts, error counts, avg latency, token usage; groupBy day/hour/week
- `GET /api/analytics/ab-results` — prompt variant distribution per profile key
- `GET /api/analytics/safety` — safety event counts by action/phase/category + time series
- `GET /api/analytics/cost` — per-day and per-provider estimated USD spend
- `src/app/analytics/` — SSR-protected dashboard page (redirects non-admins); client `AnalyticsDashboard` with recharts (line, bar, pie charts; 1d/7d/30d range picker)
- `recharts` npm dependency (justified: data visualisation, no viable existing alternative in stack)
- Analytics link in `ConversationSidebar` visible only when `user.isAdmin === true`
- `/api/auth/me` now returns `isAdmin` field

## Phase 0 — Security & Stability Baseline (2026-06-13)

### Added
- `SESSION_SECRET` env var — HMAC-SHA256 cookie signing (`src/lib/auth.ts`)
- SSE streaming path in `POST /api/chat` — detect `Accept: text/event-stream`, use `streamLLMWithLogging`, emit `data: {token}` chunks, terminate with `data: [DONE]`
- Streaming bubble in `ChatUI` — `streamingContent` state renders in-progress assistant message with blinking cursor
- `src/components/chat/` sub-components: `AuthGate`, `ConversationSidebar`, `MessageBubble`, `MessageList`, `ChatInput`
- `src/types/css.d.ts` — TypeScript declaration for CSS side-effect imports
- `LLM_CONTEXT_WINDOW` env var (default `8`, clamped `[4, 64]`) replaces hardcoded `take: 8` in chat route
- `toGeminiContents()` helper — builds proper `Content[]` array for Gemini SDK (role: `user`|`model`, parts: `[{text}]`); system prompt prepended to first user turn

### Changed
- `ChatUI.tsx` refactored into orchestrator; all rendering delegated to sub-components
- `callGemini` and `streamGemini` now use `toGeminiContents()` instead of concatenated string prompt
- Session cookies now stored as `{userId}.{hmac_signature}`; tampered cookies rejected with 401
- Chat route extracted shared `buildConversation()` helper used by both sync and stream paths

### Fixed
- Gemini API was receiving a flat concatenated string instead of a structured message array
- Session cookie stored raw `userId` with no integrity protection

### Migrations
- `20260613_phase0_hmac_session` — no schema changes (application-layer only)
