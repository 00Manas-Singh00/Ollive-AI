# Changelog

## Phase 15 — Proactive Ambient Insights (2026-07-07)

### Added
- `ProactiveInsight` Prisma model (`userId` FK to `User`, `triggerReason`, `suggestedMessage`, `relatedConversationIds String[]`, `status` enum `InsightStatus` = `PENDING|SENT|DISMISSED`, indexed `[userId, status, createdAt]`); migration `20260628160000_20260628_phase15_proactive_insights`. `User.insights` back-relation added.
- `src/lib/ambient-insights.ts` — `findActiveUserIds()` (distinct users with non-archived activity in the lookback window), `generateInsightForUser(userId)` (samples the user's recent conversations, calls `callLLMWithLogging` with a pattern-detection system prompt, Zod-validates the returned JSON, and persists a `PENDING` insight when `confidence` clears `AMBIENT_INSIGHT_CONFIDENCE` — skips users with <2 conversations or an existing PENDING insight). Tunables via env: `AMBIENT_INSIGHT_CONFIDENCE` (0.7), `AMBIENT_INSIGHT_LOOKBACK_HOURS` (168), `AMBIENT_INSIGHT_MAX_CONVERSATIONS` (12).
- `ambient-insight-queue` BullMQ queue (`getAmbientInsightQueue()` in `src/lib/queue.ts`).
- `src/workers/ambient-insight-worker.ts` — BullMQ worker driven by a repeatable `scan` job (every `AMBIENT_INSIGHT_INTERVAL_MINUTES`, default 60) that fans out one `user` job per active user; each `user` job runs `generateInsightForUser`. `npm run worker:ambient-insight` script + `ambient-insight-worker` service in `docker-compose.yml`.
- `GET /api/insights/pending` — `requireSessionUser()` first; returns the user's `PENDING` insights and transitions them to `SENT`.
- `DELETE /api/insights/:id` — `requireSessionUser()` first; ownership-scoped dismissal (`status = DISMISSED`).
- Dismissible insight banner in `ChatUI.tsx` polled via the existing `refresh()` cadence (`fetchInsights()`); "Explore" prefills the suggested message into the composer (switching to a related conversation when one is open) and "✕" dismisses. New `.insight-banner` styles in `globals.css`.

### Migrations
- `20260628160000_20260628_phase15_proactive_insights` — adds `InsightStatus` enum + `ProactiveInsight` table + index + FK

## Phase 14 — Generative UI Widgets (2026-07-07)

### Added
- `WidgetInteraction` Prisma model (`messageId` unique FK to `ChatMessage`, `widgetType`, `schema Json`, `userResponse Json?`); migration `20260628150000_20260628_phase14_widget_interaction`. `ChatMessage.widgetInteraction` back-relation added.
- `src/lib/generative-ui.ts` — client-safe (no Prisma) Zod schemas for the three supported widget types (`slider`, `choice`, `chart` with `bar`/`line` variants); `parseWidgetDirective(rawResponse)` extracts the first fenced ` ```widget ` JSON block, validates it, and returns the widget plus the response text with the block stripped (malformed/invalid directives are ignored and the text left intact — a broken directive never breaks the turn); `validateWidgetResponse(widgetType, userResponse)` for the write-back path; `summarizeWidgetResponse()` synthesizes the follow-up user turn; `WIDGET_SUFFIX` teaches the model the directive format.
- `POST /api/chat` (both streaming and sync paths): `WIDGET_SUFFIX` appended to the resolved system prompt; after output moderation passes, the widget directive is detected in the assembled response, stripped from the persisted/displayed message content, persisted as a `WidgetInteraction` row, and included as `widget` in the API response / `done` SSE event.
- `PATCH /api/messages/:messageId/widget` — `requireSessionUser()` first; ownership-checked; Zod-validates `{ userResponse }` against the widget's type-specific response schema and stores it on the `WidgetInteraction` row.
- `GET /api/conversations` includes `widgetInteraction` per message so widgets survive a reload.
- `WidgetRenderer.tsx` in `src/components/chat/` — renders the typed widget below the assistant `MessageBubble` (via `MessageList.tsx`): slider with live value + Send, choice chips (single-select sends immediately; `multiple` toggles + Send), and a single-hue clickable bar/line mini-chart. On interaction it PATCHes `userResponse`, then `ChatUI.respondToWidget` auto-sends a synthesized follow-up user turn summarizing the interaction (reusing the streaming `sendMessage` path). Answered widgets render disabled with a "✓" summary line.

### Migrations
- `20260628150000_20260628_phase14_widget_interaction` — adds `WidgetInteraction` table + unique index on `messageId` + FK

## Phase 13 — Visible Reasoning Trace (2026-07-07)

### Added
- `ReasoningTrace` Prisma model (`messageId` unique FK to `ChatMessage`, `provider`, `steps Json`); migration `20260628140000_20260628_phase13_reasoning_trace`. `ChatMessage.reasoningTrace` back-relation added.
- `src/lib/reasoning-trace.ts` — `REASONING_SUFFIX` (system-prompt suffix that primes marker-based providers to emit leading `Thought:` lines), `extractReasoningSteps(provider, rawResponse)` (splits a complete response into Zod-validated steps + clean answer), `createThoughtSplitter()` (streaming variant that diverts leading `Thought:`/`Step:` lines to an `onThought` callback so markers never reach the visible token stream), `buildReasoningSteps()` (Zod-validates accumulated thought text into a steps array), and `persistReasoningTrace()` (fire-and-forget DB write, same pattern as `InferenceLog` — never throws into the request path).
- `onThought?: (thought: string) => void` threaded through `streamLLMWithLogging` → `executeWithFailover` → `runProvider`. Reasoning capture is opt-in: only active in stream mode when `onThought` is provided, so direct `runProvider` callers (race mode, replay, embed) are untouched. `streamLLMWithLogging` now also returns `provider`/`model` so the route can attribute the trace.
- Native reasoning for Anthropic: `streamAnthropic` requests `thinking: { type: "adaptive", display: "summarized" }` when thoughts are captured and line-buffers `thinking_delta` events so every `onThought` call carries one complete reasoning line. All other providers get `REASONING_SUFFIX` appended to the system message plus marker parsing (`createThoughtSplitter` for token streams — Gemini/OpenAI; `extractReasoningSteps` for whole-output pseudo-streams — Grok/Ollama, whose visible output is replaced with the cleaned answer).
- `POST /api/chat` (streaming path) emits `data: {"thought": "..."}` SSE events alongside `token` events and persists a `ReasoningTrace` (fire-and-forget) after the assistant message is created on the non-moderated path.
- `GET /api/conversations` includes `reasoningTrace` per message so traces survive a reload.
- Collapsible "Thinking" panel above the response text in `MessageBubble.tsx` — populated live from `thought` SSE events while streaming (auto-expanded, last step highlighted), collapsed by default once streaming completes; persisted messages render their stored trace steps behind the same toggle.

### Migrations
- `20260628140000_20260628_phase13_reasoning_trace` — adds `ReasoningTrace` table + unique index + FK

## Phase 12 — Conversation Branching Tree (2026-07-05)

### Added
- `Conversation.rootConversationId String?` and `ChatMessage.branchParentId String?` (self-relation `MessageBranch`, `onDelete: NoAction`) with a `ChatMessage_branchParentId_idx`; migration `20260628130000_20260628_phase12_branching`.
- `POST /api/conversations/:id/branch` — `requireSessionUser()` first; Zod-validated `{ fromMessageId, providerOverride?, promptVersionOverride? }`. Clones the source conversation's messages up to and including `fromMessageId` verbatim into a new conversation, links the cloned branch-point message back to the original via `branchParentId`, sets `rootConversationId` to the tree root, and records fork info in `replayMeta` (`mode: "branch"`, `forkedFrom`, `forkedFromTitle`, `branchPointMessageId`). When the branch point is a user turn it reuses Phase 7's replay plumbing (`resolveSystemPrompt` + `callLLMWithLogging` + output moderation) to regenerate a fresh assistant reply under the optional provider/prompt overrides.
- `GET /api/conversations/:id/tree` — `requireSessionUser()` first; ownership-checked; resolves the tree root (`rootConversationId ?? id`) and returns `{ rootId, nodes[] }` where each node carries `parentConversationId`/`branchPointMessageId`/`mode` for rendering.
- `BranchTree.tsx` in `src/components/chat/` — collapsible git-like tree of the active conversation's branch family, rendered in `ConversationSidebar.tsx`; only appears once a conversation has at least one branch. Clicking a node switches the active conversation.
- "⑂ Branch from here" hover action on every non-streaming `MessageBubble` (threaded through `MessageList` → `ChatUI.branchConversation`); on success it refreshes, activates the new branch, and bumps a `branchRefreshKey` so the sidebar tree refetches.

### Migrations
- `20260628130000_20260628_phase12_branching` — adds `Conversation.rootConversationId`, `ChatMessage.branchParentId` + index + self-FK

## Phase 11 — Click-to-Trace Citations (2026-06-28)

### Added
- `MessageCitation` Prisma model (`messageId` FK to `ChatMessage`, `chunkId` FK to `KnowledgeChunk`, `relevanceScore Float`, `excerptStart Int`, `excerptEnd Int`); migration `20260628120000_20260628_phase11_message_citations`. `ChatMessage.citations` and `KnowledgeChunk.citations` back-relations added.
- `retrieveRelevantChunks()` in `src/lib/rag.ts` now returns `RetrievedChunk[]` (`{ id, text, score, excerptStart, excerptEnd }`) instead of `string[]`; a per-chunk `bestExcerpt()` helper picks the sentence with the highest query-term overlap and returns its char offsets so the UI can highlight the precise justifying excerpt.
- `persistCitations(messageId, chunks)` in `src/lib/rag.ts` — writes one `MessageCitation` row per injected chunk with positive relevance.
- `resolveSystemPrompt()` now returns the resolved `ragChunks` alongside the prompt so the chat route can attribute citations to the assistant message.
- `POST /api/chat` persists `MessageCitation` rows (both sync and streaming paths) after the assistant `ChatMessage` is created, for each chunk actually injected into that turn's prompt.
- `GET /api/messages/:messageId/citations` — `requireSessionUser()` first; ownership-checked; returns citations with chunk text, excerpt offsets, relevance score, and originating `KnowledgeDocument` filename.
- Citations UI in `MessageBubble.tsx` — a "📎 Sources" chip row below assistant messages (lazy-fetched, like the annotation bar); clicking a chip opens a popover showing the source chunk text with the justifying excerpt highlighted and the source filename.

### Migrations
- `20260628120000_20260628_phase11_message_citations` — adds `MessageCitation` table + FKs/indexes

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
