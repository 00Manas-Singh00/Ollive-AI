# Changelog

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
