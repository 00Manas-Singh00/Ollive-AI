# Changelog

## Phase 21 — Prompt Optimization Lab / Auto A/B Evolution (2026-07-11)

### Added
- `PromptExperiment` Prisma model (`profileKey`, `championVersionId`/`challengerVersionId` → `PromptVersion`, `trafficSplit Float @default(0.1)`, `status` enum `RUNNING|CONCLUDED_CHAMPION|CONCLUDED_CHALLENGER|ABORTED`, `minSamples Int @default(100)`, `autoPromote Boolean @default(false)`, `metrics Json?`).
- `src/lib/prompt-lab.ts`: `getRunningExperiment(profileKey)`; `pickArmForRequest(experimentId, seed, trafficSplit)` — deterministic `sha256` hash bucket so a user/conversation stays in one arm for the life of the experiment; `evaluateExperiment(experimentId)` — aggregates per-arm `MessageAnnotation` thumbs ratio (Phase 4), `QualityScore` mean (Phase 6), and `SafetyAuditLog` refusal rate into a composite success rate, compared via a hand-rolled two-proportion z-test (p<0.05, no new dependency); `generateChallenger(profileKey)` — meta-prompts the configured LLM (via `callLLMWithLogging`) to mutate the champion's base prompt, stores the result as a new inactive `PromptVersion`; `promoteWinner`/`abortExperiment`.
- `resolveSystemPrompt()` in `src/lib/prompt-manager.ts` gained an optional `userId` param; when a profile has a `RUNNING` experiment and the caller didn't pin an explicit `versionOverride`, it buckets the request into the champion or challenger arm instead of using `profile.activeVersion` — the experiment arm is implicit in which `PromptVersion.version` gets logged on the `PromptDecision` row (no schema change needed on that hot-path table). `POST /api/chat` now passes `userId: user.id` through.
- `prompt-lab-queue` (`src/lib/queue.ts`) + `src/workers/prompt-lab-worker.ts` — repeatable hourly `scan` job (`PROMPT_LAB_INTERVAL_MINUTES`) fans out one `evaluate` job per `RUNNING` experiment; on a significant result with enough samples per arm it calls `promoteWinner` (activates the challenger version on the profile only if `autoPromote` is set, otherwise just concludes and leaves the admin to activate manually via Prompt Studio); otherwise persists a fresh `metrics` snapshot.
- `GET/POST /api/admin/experiments` (ADMIN only) — list (with live, unpersisted metrics for `RUNNING` experiments) and create (either an explicit `challengerVersionId` or `generateChallenger: true`); one `RUNNING` experiment per profile at a time; `trafficSplit` capped at 0.5 in the Zod schema. `POST /api/admin/experiments/:id/abort`.
- UI: "Lab" tab alongside "Studio" in `src/app/admin/prompts/page.tsx` — experiment table with live arm success rates and significance indicator, "Generate challenger with AI & start" button, abort button.
- New npm script `worker:prompt-lab`; added to `docker-compose.yml`.

### Migrations
- `20260711102527_phase21_prompt_experiments` — adds `PromptExperimentStatus` enum and `PromptExperiment` table.

### Gotchas
- Depended on Phase 2 (Prompt Studio) and Phase 6 (Quality Scoring), both of which already existed in the codebase ahead of their `CLAUDE.md` phase-status entries — no extra prerequisite work was needed.
- Auto-promotion defaults to off (`autoPromote: false`) — the default outcome of a concluded experiment is "stop routing traffic to the loser and notify the admin," not a silent activation.

## Phase 20 — Live Collaborative Sessions (2026-07-11)

### Added
- `ConversationMember` Prisma model (`conversationId`, `userId`, `role` enum `OWNER|COLLABORATOR|VIEWER`, `@@unique([conversationId, userId])`) and `Conversation.isCollaborative Boolean @default(false)`.
- `src/lib/collab.ts` — `assertConversationAccess(user, conversationId, minRole)` centralizes conversation authorization (the creator is always `OWNER` even without an explicit member row); `collabErrorResponse(error)` shared catch-block helper (401/403/404); `publishConversationEvent`/`conversationChannel` (Redis `PUBLISH`, reusing `REDIS_URL`, no new dependency); `acquireSendLock`/`releaseSendLock` (`SET NX EX` per-conversation lock so only one member can have an in-flight send); `createSubscriberConnection()` (dedicated `ioredis` connection for `SUBSCRIBE`, since it can't share the publish client's connection).
- Every existing conversation-scoped route (`conversations/:id` PATCH/DELETE, `tree`, `cancel` — previously **unauthenticated**, `branch`, `report`, `documents`, `replay`, `share`, message-nested routes `tool-calls`/`widget`/`citations`, `chat/race` + its `vote` route) refactored from ad hoc `findFirst({ userId })` ownership checks onto `assertConversationAccess`. `GET /api/conversations` now also returns conversations the caller is a member (not just owner) of, plus a computed `myRole` per conversation.
- `GET /api/conversations/:id/events` — long-lived SSE subscription (`requireSessionUser()` + `VIEWER` membership) relaying `message_created`/`token`/`thought`/`presence` events off the Redis channel; `presence` heartbeats every 20s.
- `POST /api/conversations/:id/members` (`OWNER` only, invite by email), `GET .../members`, `DELETE .../members/:userId` (self-leave or `OWNER` removal).
- `POST /api/chat` mirrors each SSE token/thought and the persisted user/assistant messages to `publishConversationEvent` when the conversation `isCollaborative`, and wraps generation in `acquireSendLock`/`releaseSendLock`.
- UI: presence avatar row + "Invite collaborator" button in `ChatUI.tsx`'s chat header (owner/collaborator only), subscribing to the events SSE endpoint for collaborative conversations; `ChatInput` disabled when the caller's role on the active conversation is `VIEWER`.

### Migrations
- `20260711100801_20260707_phase20_collab` — adds `ConversationMemberRole` enum, `ConversationMember` table, `Conversation.isCollaborative`.

### Gotchas
- Serverless deployments kill long-lived SSE connections; the events subscription doesn't yet implement `Last-Event-ID` client reconnection (see `docs/architecture-notes.md`).

## Phase 17 — Voice Mode / Speech-to-Speech Chat (2026-07-11)

### Added
- `src/lib/speech.ts` — `transcribeAudio(buffer, mimeType, filename)`: routes to OpenAI Whisper (`SPEECH_STT_MODEL`, default `whisper-1`) or Gemini multimodal audio input based on `SPEECH_STT_PROVIDER` (defaults to `openai` when `OPENAI_API_KEY` is set, else `gemini`, avoiding a new required key). `synthesizeSpeech(text)`: OpenAI TTS (`SPEECH_TTS_MODEL` default `tts-1`, `SPEECH_TTS_VOICE` default `alloy`); `SPEECH_TTS_PROVIDER` is validated but only `openai` is currently supported.
- `POST /api/speech/transcribe` — `requireSessionUser()` first; `multipart/form-data` `audio` file (10 MB cap) + optional `conversationId`; returns `{ text }`. Fire-and-forget `sendLog` telemetry only fires when the given `conversationId` is real and owned by the caller.
- `POST /api/speech/synthesize` — `requireSessionUser()` first; Zod body `{ text (≤4000 chars), conversationId? }`; streams `audio/mpeg` back; same conditional telemetry.
- UI: 🎙 push-to-talk button in `ChatInput.tsx` using `MediaRecorder` (feature-detects supported mime types); on stop, uploads the recording, transcribes, and appends the result to the composer — the user always reviews/edits before sending (server-side moderation still applies as normal on send). 🔊 speaker toggle in `MessageBubble.tsx` fetches and plays back synthesized audio for a completed assistant response.

### Not in scope
- Sentence-by-sentence TTS synthesis during SSE token streaming — synthesis is on-demand against the full response text, not incremental.

## Phase 19 — Scheduled Prompts & AI Digests (2026-07-11)

### Added
- `ScheduledPrompt` Prisma model (`userId` FK, `cronExpression`, `prompt`, `provider`, `isActive` default true, `lastRunAt`, `deliveryConversationId`).
- `src/lib/cron-validate.ts` — hand-rolled strict 5-field cron validator (field range checks, no new dependency); rejects wildcard/step/comma minute fields to enforce a minimum 1-hour interval.
- `src/lib/queue.ts` — new `scheduled-prompt-queue`. `src/lib/scheduled-prompts.ts` — `syncScheduleJob()`/`removeScheduleJob()` use BullMQ's `upsertJobScheduler`/`removeJobScheduler` (one job scheduler per `ScheduledPrompt.id`, native cron `pattern` support — no manual next-run calculation) so a schedule's repeatable job stays in sync with create/update/delete.
- `src/workers/scheduled-prompt-worker.ts` — loads the schedule (worker runs with no session; every query scoped to the schedule's own `userId`), builds context from the user's recent conversations, calls `callLLMWithLogging` (telemetry + `PromptDecision` for free), creates a delivery conversation on first run (titled from the prompt) or appends to the existing one, updates `lastRunAt`.
- `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id` — `requireSessionUser()` first; Zod-validated; per-user cap via `MAX_SCHEDULES_PER_USER` (default 10, enforced on create and on reactivation); input moderation runs on the stored prompt at creation/update time.
- UI: "⏰ Scheduled Prompts" entry in `ConversationSidebar.tsx` and the command palette opens `ScheduleModal.tsx` — create form (prompt textarea, provider select, daily/weekly/monthly frequency picker + time, mapped to a cron expression client-side) and a list of existing schedules with pause/resume and delete.
- New npm script `worker:scheduled-prompt`; `docker-compose.yml` gained a `scheduled-prompt-worker` service.

### Migrations
- `20260711091918_20260711_phase19_scheduled_prompts` — adds `ScheduledPrompt` table + FK to `User` + index on `[userId, isActive]`.

## Phase 18 — Agentic Tool Use / Function Calling (2026-07-11)

### Added
- `ToolCall` Prisma model (`messageId` FK to `ChatMessage`, `toolName`, `arguments Json`, `result Json?`, `status` enum `PENDING|SUCCESS|ERROR`, `latencyMs`).
- `src/lib/tools/registry.ts` — typed registry (`name`, `description`, JSON-schema `parameters`, a zod `schema` for validating provider-returned arguments, `execute`). Four safe built-ins: `calculator` (hand-rolled recursive-descent evaluator over `+ - * / ( )` — no `eval`/`Function`), `current_time`, `knowledge_search` (wraps `retrieveRelevantChunks` from Phase 5's RAG lib, scoped to the requesting conversation), `conversation_summary` (last 20 messages, truncated). No arbitrary code execution, no shell, no unrestricted network access.
- `src/lib/llm.ts` — new `runProviderWithTools()` + provider-agnostic `ToolTurn` type, kept separate from the existing `runProvider()` used by the streaming chat path (which is untouched). Implemented per provider: Anthropic (`tools`/`tool_use`/`tool_result` blocks), OpenAI (`tools`/`tool_calls`), Grok (OpenAI-compatible `tools` over the existing raw-fetch call), Gemini (`functionDeclarations`/`functionCall`/`functionResponse`). Ollama is treated as unsupported (skips tools, answers in plain text) since local models rarely support function calling reliably. `getProviderPlan` exported for provider selection outside `executeWithFailover`.
- `src/lib/tools/loop.ts` — `runToolLoop()`: calls the model, and while it requests tools, zod-validates arguments, executes with a 10s per-tool timeout, feeds the result back, and re-calls — up to 5 iterations, then hard-falls back to a normal (tool-less) call rather than surfacing a stuck loop.
- `POST /api/chat`: opt-in `toolsEnabled` (zod-validated boolean) on the payload. When true the request always answers via the sync/JSON path (tool loops are sync-mode only — streaming + tool loops is out of scope for this phase) and routes through `runToolLoop`; one `ToolCall` row is persisted per invocation once the assistant message is created, and one `sendLog` fire-and-forget call covers the whole round-trip.
- `GET /api/messages/:messageId/tool-calls` — `requireSessionUser()` first, ownership-checked, returns the persisted tool calls for a message.
- UI: "🛠 Tools" toggle in `ChatInput.tsx` (mutually exclusive in practice with race mode — send picks race over tools if both are on); when tools mode is active, `ChatUI.sendWithTools` sends a non-streaming request instead of the usual SSE path. `ToolCallCard.tsx` renders each call (name, args, collapsed JSON result, latency, error state) inline above the answer in `MessageBubble.tsx`, self-fetched like `CitationsBar`.

### Migrations
- `20260711085610_20260707_phase18_tool_calls` — adds `ToolCallStatus` enum + `ToolCall` table with FK to `ChatMessage` and an index on `messageId`.

## Phase 23 — Conversation Intelligence Reports (2026-07-11)

### Added
- `ConversationReport` Prisma model (`conversationId` unique FK to `Conversation`, `report Json`, `model`, `generatedAt`, `messageCountAtGeneration`); `Conversation.report` back-relation added.
- `src/lib/conversation-report.ts` — `generateReport(conversationId, userId)`: ownership-checked message pull, chunk-and-summarize (map-reduce via `callLLMWithLogging`) when the transcript exceeds `MAX_TRANSCRIPT_CHARS` (12,000), then a JSON-output pass Zod-validated against `{ summary, topics[], sentimentArc[], actionItems[], unresolvedQuestions[] }` with one repair-retry (validation errors fed back to the model) before surfacing a clean failure. Output moderation runs on the generated summary like any other assistant output (`SafetyAuditLog` row written either way). Cache hit when `messageCountAtGeneration` matches the conversation's current message count — no regeneration, no LLM call. The whole generation pass is capped at 30s (`REPORT_TIMEOUT_MS`).
- `POST /api/conversations/:id/report` — `requireSessionUser()` first; returns cached or freshly generated report. `GET /api/conversations/:id/report` — returns the latest persisted report without generating.
- UI: "Analyze" added to the conversation context menu (`ConversationSidebar.tsx`) and to the command palette's active-conversation actions; new `ReportPanel.tsx` slide-over — summary, topic chips, action-item checklist (local-only check state), sentiment sparkline (tiny inline SVG, no chart dependency), unresolved questions, "Copy as Markdown" button, loading skeleton while generating.

### Migrations
- `20260711075037_20260711_phase23_reports` — adds `ConversationReport` table + unique index on `conversationId` + FK

## Phase 22 — Cost Guardrails & Budgets (2026-07-11)

### Added
- `User.monthlyBudgetUsd Float?` + `User.budgetAction` (`BudgetAction` enum `WARN|DOWNGRADE|BLOCK`, default `WARN`) and `SpendCache` model (`@@unique([userId, month])`, month keyed `"YYYY-MM"` so rollover is automatic — no cron).
- `src/lib/budget.ts` — `recordSpend()` (cost via the Phase 1 `src/lib/cost.ts` table; upsert-increments `SpendCache`, then mirrors the **authoritative DB total** into Redis with `SET` so the cache can never drift from the DB), `checkBudget()` (Redis-first read, DB fallback with write-back; `warning` at 80%, `exceeded` at 100%; no budget set → always `ok`), `downgradeProvider()` (env `BUDGET_FALLBACK_PROVIDER`, default gemini, plus optional `BUDGET_FALLBACK_MODEL`).
- Spend recording lives in the **ingest worker** (it already receives token counts) — zero added latency in the request path; only `success` logs with token counts are counted, and the user is resolved via the log's conversation.
- Chat route (`POST /api/chat`, both paths): budget check runs after `requireSessionUser()` + rate limiting. `exceeded`+`BLOCK` → 402 with a friendly error; `exceeded`+`DOWNGRADE` → provider/model swapped to the fallback before the LLM call + `x-budget-downgraded: true` response header; `warning` (or exceeded with `WARN`) → `x-budget-warning: true` header. `streamLLMWithLogging`/`callLLMWithLogging`/`executeWithFailover` gained pass-through `providerOverride`/`modelOverride` params to support the swap.
- `GET /api/budget` — session user's own `{ status, spendUsd, budgetUsd, action }` for the UI meter.
- `PATCH /api/admin/users/:id/budget` — ADMIN-only, Zod-validated (`monthlyBudgetUsd` positive ≤ 10000 or null to clear, `budgetAction`).
- UI: thin monthly-usage meter at the top of `ConversationSidebar.tsx` (green / yellow ≥80% / red ≥100%; only rendered when a budget is set; fetched on the existing `refresh()` cadence via `ChatUI`); red banner + disabled input when blocked; dismissible amber notice when a response carries the downgrade header.

### Migrations
- `20260711072750_20260711_phase22_budgets` — `BudgetAction` enum, `User.monthlyBudgetUsd`/`User.budgetAction`, `SpendCache` table + unique `[userId, month]`

## Phase 24 — Workspace Command Palette (2026-07-08)

### Added
- `src/lib/fuzzy.ts` — dependency-free subsequence fuzzy matcher: `fuzzyMatch(query, text)` returns a score + matched character indices (bonuses for first-char, word-start, and consecutive runs; gap and length penalties); `fuzzyFilter()` ranks a list. Zero new dependencies by design.
- `src/components/chat/CommandPalette.tsx` — modal overlay opened with `⌘K`/`Ctrl+K` (toggle) from `ChatUI.tsx`; local React state only, command registry passed via props (no Context). Sections: **Actions** (new conversation, race-mode toggle, race-provider add/remove, show/hide archived, and — when a conversation is active — share, replay, archive), **Conversations** (fuzzy-matched titles with highlighted characters), and an async **Semantic matches** section wired to Phase 16's `GET /api/search` (debounced 300ms, ≥3 chars, degrades silently if the route errors). `>` prefix filters to actions, `#` to conversations.
- Keyboard handling: arrows + Enter navigate/execute, Escape closes, Tab is trapped inside the modal; focus moves to the palette input on open and is restored to the previously focused element on close. The global listener intercepts only the `⌘K` chord, so `ChatInput`'s textarea keys are untouched.
- `.palette-*` styles in `globals.css`.

### Migrations
- None (pure frontend; reuses the existing search route).

## Phase 16 — Semantic Conversation Search (2026-07-08)

### Added
- `MessageEmbedding` Prisma model (`messageId` unique FK to `ChatMessage`, `vector Json` float array, `model` for stale-vector invalidation on a future embedding-model swap, `embeddedAt`); migration `20260707192126_20260707_phase16_message_embeddings`. `ChatMessage.embedding` back-relation added.
- `embedding-queue` BullMQ queue (`getEmbeddingQueue()` in `src/lib/queue.ts`). `POST /api/chat` enqueues one fire-and-forget `{ conversationId }` job after each assistant message is persisted (both streaming and sync paths) — never embeds synchronously in the request path.
- `src/workers/embedding-worker.ts` — drains a conversation's un-embedded messages in batches (`EMBEDDING_BATCH_SIZE`, default 50) using the same hashed-TF embedding function as RAG (`embedText`/`EMBEDDING_MODEL = "tfidf-hash-512"`, now exported from `src/lib/rag.ts`); `createMany` with `skipDuplicates` keeps concurrent jobs idempotent. `npm run worker:embedding` script + `embedding-worker` service in `docker-compose.yml`.
- `scripts/backfill-embeddings.mjs` — enqueues every conversation with un-embedded messages through the queue (deduped `jobId` per conversation).
- `src/lib/semantic-search.ts` — `searchConversations(userId, query, limit)`: embeds the query, in-process cosine similarity over the user's most recent `SEARCH_MAX_VECTORS` (default 5000) message embeddings, filters to the current `EMBEDDING_MODEL`, groups hits by conversation keeping the best-scoring message as snippet.
- `GET /api/search?q=...` — `requireSessionUser()` first; Zod-validated `q` (1–500 chars) + optional `limit` (1–50); scoped strictly to the session user's conversations.
- `ConversationSidebar.tsx`: the existing search input now also runs a debounced (300ms, aborted on retype) semantic search; results replace the conversation list while a query is active, showing title, snippet with `<mark>`-highlighted query terms, and a % match score; Escape clears the search. Local React state only.

### Migrations
- `20260707192126_20260707_phase16_message_embeddings` — adds `MessageEmbedding` table + unique index on `messageId` + `embeddedAt` index + FK

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
