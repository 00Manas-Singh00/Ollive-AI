# Changelog

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
