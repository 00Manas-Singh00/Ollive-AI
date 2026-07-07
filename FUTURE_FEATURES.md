# Ollive AI — Future Features & Add-ons (Implementation Guide)

This file proposes ambitious next-generation features, written in the same spec format as the phases in `CLAUDE.md` so any session can pick one up and implement it directly. Every feature below **must obey the project invariants** in `CLAUDE.md` (fire-and-forget logging, `requireSessionUser()` first, business logic in `src/lib/`, Zod at boundaries, migrations only, no new state managers).

Numbering continues from Phase 15 in `CLAUDE.md`.

---

## Phase 16 — Semantic Conversation Search 🔍

Full-workspace natural-language search across all of a user's conversations ("that chat where we discussed rate limiting") using embeddings, not keyword match.

**Why it's high-value:** users accumulate hundreds of conversations; sidebar scrolling doesn't scale. Reuses the RAG embedding pipeline from Phase 5.

**Prerequisite Prisma migration:** add `MessageEmbedding` model (`messageId String @unique`, `vector Json` — store as float array; if pgvector is available, use `Unsupported("vector(768)")` instead), plus `embeddedAt DateTime`. Migration name: `20260707_phase16_message_embeddings`.

**New BullMQ queue:** `embedding-queue` in `src/lib/queue.ts`. Chat route enqueues (fire-and-forget) after each assistant message is persisted.

**New worker:** `src/workers/embedding-worker.ts` — batches messages, calls the same embedding function `src/lib/rag.ts` uses, writes `MessageEmbedding`. Add npm script `worker:embedding` + docker-compose service (same pattern as ingest worker).

**New lib:** `src/lib/semantic-search.ts` — `searchConversations(userId, query, limit)`: embeds query, cosine-similarity against user's `MessageEmbedding` rows (in-process for Json vectors; SQL `<=>` operator if pgvector), returns conversation hits grouped with best-matching snippet + score.

**New route:** `GET /api/search?q=...` — `requireSessionUser()` first; Zod-validate `q` (1–500 chars); scoped strictly to the session user's conversations.

**UI:** search input at the top of `ConversationSidebar.tsx`; debounced (300ms) fetch; results replace the conversation list while active, showing snippet + highlighted match; Escape clears. Local state only.

**Implementation order:** migration → queue+worker → backfill script (`scripts/backfill-embeddings.mjs`, iterate existing messages through the queue) → lib → route → UI.

**Gotchas:**
- Never embed synchronously in the chat request path — always via queue.
- Cap vectors scanned per search (e.g. most recent 5k messages) until pgvector is adopted.
- Store the embedding model name on the row so a model swap can invalidate stale vectors.

---

## Phase 17 — Voice Mode (Speech-to-Speech Chat) 🎙️

Talk to the chat: browser mic capture → transcription → normal chat pipeline → TTS playback of the streamed response.

**No Prisma migration needed** (optionally add `inputModality String @default("text")` to `ChatMessage` — migration `20260707_phase17_input_modality` — for analytics).

**New lib:** `src/lib/speech.ts` — `transcribeAudio(buffer, mimeType)` (OpenAI Whisper via existing `openai` dep, or Gemini audio input to avoid a new key) and `synthesizeSpeech(text)` returning an audio stream. New env vars: `SPEECH_STT_PROVIDER`, `SPEECH_TTS_PROVIDER`, `SPEECH_TTS_VOICE` — document in `docs/architecture-notes.md` env table.

**New route:** `POST /api/speech/transcribe` — `requireSessionUser()` first; accepts `multipart/form-data` audio (max 10 MB, Zod-validate metadata fields); returns `{ text }`. Rate-limit alongside chat once Phase 8 lands.

**New route:** `POST /api/speech/synthesize` — `requireSessionUser()`; Zod body `{ text: string (≤4000 chars) }`; streams `audio/mpeg`.

**UI:** mic button in `ChatInput.tsx` using `MediaRecorder` (webm/opus); push-to-talk with a recording indicator; on stop → transcribe → populate the textarea (user can edit before sending). A speaker toggle on `MessageBubble.tsx` plays synthesized audio; during SSE streaming, buffer text and synthesize sentence-by-sentence for low-latency playback. All local React state.

**Gotchas:**
- `MediaRecorder` mime support differs across browsers — feature-detect and pass the actual mimeType through.
- Never auto-send transcriptions; user reviews text first (moderation still runs server-side regardless).
- Log STT/TTS calls through the existing `sendLog` telemetry (`void sendLog(...)`).

---

## Phase 18 — Agentic Tool Use (Function Calling) 🛠️

Let the assistant call server-defined tools mid-conversation (calculator, web fetch, RAG lookup, current time), with a visible tool-call trace in the UI.

**Prerequisite Prisma migration:** add `ToolCall` model (`messageId`, `toolName`, `arguments Json`, `result Json?`, `status` enum `PENDING|SUCCESS|ERROR`, `latencyMs Int?`). Migration name: `20260707_phase18_tool_calls`.

**New lib:** `src/lib/tools/registry.ts` — a typed registry: each tool = `{ name, description, zodSchema, execute(args, ctx) }`. Ship four safe built-ins: `calculator` (mathjs-free, hand-rolled safe eval on a restricted grammar), `current_time`, `knowledge_search` (wraps `retrieveRelevantChunks` from `src/lib/rag.ts`), `conversation_summary`. **No arbitrary code execution, no shell, no unrestricted fetch.**

**Provider integration in `src/lib/llm.ts`:** extend `runProvider` with optional `tools` param mapped per provider (Anthropic `tools`, OpenAI `tools`, Gemini `functionDeclarations`; skip for providers without support). New `runToolLoop()` in `src/lib/tools/loop.ts`: call model → if tool_use requested, Zod-validate args, execute, append result, re-call — max 5 iterations, 10s per tool, hard-fail to a normal text response on loop exhaustion.

**Chat route:** opt-in `toolsEnabled: boolean` field on the Zod payload; when true, sync path routes through `runToolLoop`. Persist one `ToolCall` row per invocation; fire-and-forget `sendLog` per LLM round-trip.

**UI:** toggle in `ChatInput.tsx`; `ToolCallCard.tsx` in `src/components/chat/` renders each call (name, args, collapsed result, latency) inline above the answer in `MessageBubble.tsx`.

**Gotchas:**
- Tool results are untrusted content re-entering the prompt — run output moderation on the final assembled answer as usual.
- Streaming + tool loops is complex; ship sync-mode first, stream only the final answer.
- Every tool execute() must be wrapped in try/catch → `status: ERROR` row, never a 500.

---

## Phase 19 — Scheduled Prompts & AI Digests ⏰

Users schedule recurring prompts ("every Monday 9am, summarize my week's conversations") that run headless and appear as new conversations / notifications.

**Prerequisite Prisma migration:** add `ScheduledPrompt` model (`userId`, `cronExpression String`, `prompt String`, `provider String`, `isActive Boolean @default(true)`, `lastRunAt DateTime?`, `deliveryConversationId String?`). Migration name: `20260707_phase19_scheduled_prompts`.

**New BullMQ queue:** `scheduled-prompt-queue` using BullMQ **repeatable jobs** keyed by `ScheduledPrompt.id` (same repeatable pattern planned for Phase 15's ambient worker). On create/update/delete of a schedule, sync the repeatable job (`queue.upsertJobScheduler` / remove).

**New worker:** `src/workers/scheduled-prompt-worker.ts` — loads the schedule, builds context (optionally last N conversations via a summarization pre-pass), calls `callLLMWithLogging` (so telemetry + `PromptDecision` happen for free), appends result to the delivery conversation (creating one titled from the prompt if unset), updates `lastRunAt`. npm script `worker:scheduled-prompt` + docker-compose service.

**New routes:** `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/:id` — `requireSessionUser()` first; Zod-validate cron with a strict 5-field parser (`src/lib/cron-validate.ts`, no new dep — hand-roll field range checks); enforce a per-user cap (env `MAX_SCHEDULES_PER_USER`, default 10) and minimum interval of 1 hour.

**UI:** "Scheduled" section in `ConversationSidebar.tsx` → modal to create/edit (prompt textarea, provider select, simple frequency picker mapping to cron: daily/weekly/monthly + time). Unread badge on the delivery conversation.

**Gotchas:**
- Worker runs with no session — bypass `requireSessionUser` but scope every query by the schedule's `userId` explicitly.
- Input moderation still applies to the stored prompt at creation time.
- Timezone: store user-local time + offset, convert to UTC cron when registering the job.

---

## Phase 20 — Live Collaborative Sessions 👥

Multiple users in the same conversation in real time — shared cursor into one chat, presence indicators, everyone sees streaming tokens live. Extends Phase 4 annotations and the Phase 9 share tokens.

**Prerequisite Prisma migration:** add `ConversationMember` model (`conversationId`, `userId`, `role` enum `OWNER|COLLABORATOR|VIEWER`, `@@unique([conversationId, userId])`) and `Conversation.isCollaborative Boolean @default(false)`. Migration: `20260707_phase20_collab`.

**Transport:** Server-Sent Events fan-out backed by **Redis pub/sub** (ioredis already present — no new dep, no websocket server needed in Next.js):
- `src/lib/collab.ts` — `publishConversationEvent(conversationId, event)` (Redis `PUBLISH collab:{id}`), plus membership check helpers.
- `GET /api/conversations/:id/events` — `requireSessionUser()` + membership check; long-lived SSE response subscribing to the Redis channel (dedicated subscriber connection per request; clean up on `req.signal` abort). Events: `message_created`, `token` (relayed from the streaming path), `presence`, `annotation_updated`.
- Chat route: when a collaborative conversation streams, mirror each SSE token to `publishConversationEvent` so passive members see it live.

**New routes:** `POST /api/conversations/:id/members` (invite by email, OWNER only), `DELETE .../members/:userId`, `GET .../members`.

**UI:** presence avatars in the chat header (heartbeat via `presence` event every 20s); "Share → Invite collaborator" in the conversation menu; VIEWER role gets read-only `ChatInput`. `ChatUI.tsx` opens the events SSE when `isCollaborative` and merges incoming events into local state (no Context provider — lift state in `ChatUI` as today).

**Gotchas:**
- Every existing conversation route must now authorize via membership (owner OR member), not just `conversation.userId === user.id` — centralize as `assertConversationAccess(user, conversationId, minRole)` in `src/lib/collab.ts` and refactor call sites.
- Serverless deployments kill long SSE connections — document a max duration + client auto-reconnect with `Last-Event-ID`.
- Only one member may send a message at a time: Redis `SET NX EX` lock `collab:lock:{conversationId}` around the chat POST.

---

## Phase 21 — Prompt Optimization Lab (Auto A/B Evolution) 🧬

Closes the loop between Phase 2 (Prompt Studio) and Phase 4/6 (annotations + quality scores): the system mutates prompt versions, A/B tests them on live traffic, and promotes statistically better variants.

**Prerequisite Prisma migration:** add `PromptExperiment` model (`profileKey`, `championVersionId`, `challengerVersionId`, `trafficSplit Float @default(0.1)`, `status` enum `RUNNING|CONCLUDED_CHAMPION|CONCLUDED_CHALLENGER|ABORTED`, `minSamples Int @default(100)`, metrics Json). Migration: `20260707_phase21_prompt_experiments`.

**New lib:** `src/lib/prompt-lab.ts`:
- `pickVersionForRequest(profileKey, userId)` — deterministic hash bucket (`sha256(experimentId + userId)`) so a user stays in one arm; called from `resolveSystemPrompt()`, which already writes `PromptDecision` (record the experiment arm in `PromptDecision.metadata` — invariant preserved).
- `evaluateExperiment(experimentId)` — aggregates per-arm quality: annotation thumbs ratio (Phase 4) + `QualityScore` mean (Phase 6) + refusal rate from `SafetyAuditLog`; two-proportion z-test (hand-rolled, ~20 lines) at p<0.05 once `minSamples` reached per arm.
- `generateChallenger(profileKey)` — meta-prompts an LLM to propose a mutation of the champion (clarity, brevity, added constraints); stores as a new inactive `PromptVersion`.

**New worker job:** extend a repeatable job (reuse `ambient-insight-queue` cadence or its own `prompt-lab-queue`) to run `evaluateExperiment` hourly; auto-promote on significance (activate challenger via existing rollback/activate machinery from Phase 2), write a `CHANGELOG`-style audit row in `PromptDecision.metadata`.

**New routes (ADMIN):** `GET/POST /api/admin/experiments`, `POST /api/admin/experiments/:id/abort`.

**UI:** "Lab" tab inside the Phase 2 admin prompts page — experiment table with live arm metrics, significance indicator, abort button, and a "Generate challenger with AI" button.

**Gotchas:**
- Depends on Phase 2 and ideally Phase 6 — implement those first, or degrade gracefully to annotation-only metrics.
- Auto-promotion must be optional (`autoPromote Boolean`, default false) — default is "conclude and notify admin".
- Cap challenger traffic split at 0.5 in the Zod schema.

---

## Phase 22 — Cost Guardrails & Budgets 💸

Hard monthly spend budgets per user/workspace with soft warnings, hard cutoffs, and automatic downgrade to a cheap model near the limit. Builds directly on the Phase 1 cost table (`src/lib/cost.ts`).

**Prerequisite Prisma migration:** add to `User`: `monthlyBudgetUsd Float?`, `budgetAction` enum `WARN|DOWNGRADE|BLOCK @default(WARN)`. Add `SpendCache` model (`userId`, `month String` e.g. `"2026-07"`, `spendUsd Float`, `@@unique([userId, month])`). Migration: `20260707_phase22_budgets`.

**New lib:** `src/lib/budget.ts`:
- `recordSpend(userId, provider, model, tokensIn, tokensOut)` — cost via `src/lib/cost.ts`, upsert-increment `SpendCache` **and** mirror into Redis `INCRBYFLOAT spend:{userId}:{month}` for a cheap hot-path read. Called from the ingest worker (it already receives token counts — zero extra latency in the request path).
- `checkBudget(userId)` — reads Redis first, falls back to DB; returns `{ status: 'ok'|'warning'|'exceeded', spendUsd, budgetUsd }` (warning at 80%).
- `downgradeProvider()` — maps any provider/model to the configured cheap fallback (env `BUDGET_FALLBACK_PROVIDER`/`BUDGET_FALLBACK_MODEL`).

**Chat route integration:** after `requireSessionUser()` (and after rate limiting once Phase 8 exists): `exceeded` + `BLOCK` → 402 with a friendly JSON error; `exceeded` + `DOWNGRADE` → swap provider before the LLM call and include `x-budget-downgraded: true` response header; `warning` → `x-budget-warning` header.

**New routes:** `GET /api/budget` (own status, for the UI banner); `PATCH /api/admin/users/:id/budget` (ADMIN, Zod: positive float ≤ 10000).

**UI:** thin usage meter at the top of `ConversationSidebar.tsx` (fetches `/api/budget` with the existing `refresh()` cadence); yellow at 80%, red banner + disabled input when blocked; a toast when a response header says the model was downgraded.

**Gotchas:**
- Spend recording lives in the **ingest worker**, not the chat route — keeps the invariant that the request path never waits on accounting.
- Redis is a cache, DB is truth: on Redis miss, rebuild from `SpendCache`, never from scratch-scanning `InferenceLog`.
- Month rollover: key by `YYYY-MM` everywhere; no cron needed.

---

## Phase 23 — Conversation Intelligence Reports 📊

One-click "analyze this conversation": an LLM-generated structured report (topics, sentiment arc, unresolved questions, action items, quality issues) rendered as a rich panel and exportable as Markdown.

**Prerequisite Prisma migration:** add `ConversationReport` model (`conversationId`, `report Json`, `model String`, `generatedAt DateTime`, `messageCountAtGeneration Int`). Migration: `20260707_phase23_reports`.

**New lib:** `src/lib/conversation-report.ts` — `generateReport(conversationId, userId)`: pulls messages, chunks if over context, calls `callLLMWithLogging` with a JSON-output system prompt, **Zod-validates the returned JSON** (`topics[]`, `sentimentArc[]`, `actionItems[]`, `unresolvedQuestions[]`, `summary`) with one repair-retry on parse failure, persists. Cache hit if `messageCountAtGeneration` matches current count.

**New route:** `POST /api/conversations/:id/report` — `requireSessionUser()` + ownership/membership check; returns cached or fresh report. `GET` variant returns latest without generating.

**UI:** "Analyze" in the conversation context menu → slide-over panel: summary, topic chips, action-item checklist, sentiment sparkline (tiny inline SVG, no chart dep), "Copy as Markdown" button. Loading skeleton while generating.

**Gotchas:**
- LLM JSON output is unreliable — always Zod-parse, one retry with the validation error fed back, then surface a clean failure.
- Report generation is a user-facing await (unlike logging) but cap at ~30s with `AbortController`.
- Run output moderation on the generated summary text like any other assistant output.

---

## Phase 24 — Workspace Command Palette (⌘K) ⌨️

A global keyboard-driven palette: jump to conversations, trigger actions (new chat, replay, race mode, switch provider, open analytics), and run slash-commands — fuzzy-matched, fully keyboard navigable.

**No Prisma migration.** Pure frontend + one tiny route.

**New files:**
- `src/components/chat/CommandPalette.tsx` — modal overlay; local state only; command registry = static actions + dynamic conversation list (already in `ChatUI` state — pass via props, per the no-Context invariant).
- `src/lib/fuzzy.ts` — dependency-free subsequence fuzzy matcher with scoring (~40 lines; prioritize consecutive runs and word starts). Reused later by Phase 16's client-side filtering.

**Integration:** `ChatUI.tsx` registers a `keydown` listener (`Ctrl/⌘+K` open, `Esc` close, arrows + Enter navigate); action handlers are the existing `ChatUI` callbacks (select conversation, new conversation, toggle race mode, open share dialog), so the palette is a thin dispatch layer. Slash-command mode: typing `>` filters to actions, `#` to conversations.

**Optional:** `GET /api/search` from Phase 16 wired in as an async result section when implemented — palette degrades gracefully without it.

**Gotchas:**
- Don't intercept keys while focus is in `ChatInput`'s textarea except the ⌘K chord itself.
- Trap focus inside the modal; restore focus to the previously focused element on close (a11y).
- Zero new dependencies — the fuzzy matcher is hand-rolled by design.

---

## Recommended Build Order

Dependencies and payoff considered:

1. **Phase 24 — Command Palette** — zero backend, instant UX win, ships in one session.
2. **Phase 22 — Cost Guardrails** — small surface, high operational value; only needs `src/lib/cost.ts` from Phase 1 (which can be created standalone).
3. **Phase 16 — Semantic Search** — reuses RAG embeddings; unlocks Phase 24's async search section.
4. **Phase 23 — Intelligence Reports** — self-contained, one lib + one route + one panel.
5. **Phase 18 — Tool Use** — biggest capability jump; sync-mode first.
6. **Phase 19 — Scheduled Prompts** — needs the repeatable-job pattern; pairs well with Phase 15 if built together.
7. **Phase 17 — Voice Mode** — independent; do after core UX is solid.
8. **Phase 20 — Collaboration** — largest refactor (authorization centralization); do deliberately.
9. **Phase 21 — Prompt Lab** — last; depends on Phases 2 and 6 landing first.

## Per-Feature Working Checklist (apply to every phase above)

- [ ] Read `CLAUDE.md` invariants before starting.
- [ ] Migration first (`npx prisma migrate dev --name 20260707_phaseN_description`), then lib, then route, then UI.
- [ ] `requireSessionUser()` is the first statement in every new protected route.
- [ ] Zod schema for every new payload (`src/lib/` or colocated `-schema.ts`).
- [ ] All log/telemetry dispatch is `void sendLog(...)` — never awaited.
- [ ] New workers: npm script + docker-compose service + graceful shutdown.
- [ ] New env vars documented in `docs/architecture-notes.md`.
- [ ] `refresh()` after every frontend mutation; local React state only.
- [ ] `node evals/run.mjs` passes; `CHANGELOG.md` updated; phase section appended to `CLAUDE.md` Phase Status when complete.
