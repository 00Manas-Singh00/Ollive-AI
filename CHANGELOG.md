# Changelog

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
