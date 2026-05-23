# Architecture Notes

## Ingestion Flow
1. User sends message from UI to `/api/chat`.
2. Chat API stores user message and fetches short context window.
3. LLM wrapper calls provider API and captures latency, usage, status, timestamps.
4. Wrapper asynchronously posts metadata to `/api/ingest`.
5. Ingestion endpoint validates payload (Zod), normalizes fields, stores in `InferenceLog`.

## Logging Strategy
- Best-effort near-real-time HTTP log shipping from wrapper to ingestion API.
- Store full operational metadata and short previews (not full raw prompts) for privacy and cost.
- Keep ingestion contract strict using schema validation.

## Scaling Considerations
- Move ingestion write path to queue/event bus for burst tolerance.
- Add async workers for enrichment and aggregation.
- Partition large log tables by date in production SQL engines.

## Failure Handling Assumptions
- Chat inference remains primary path; logging is non-blocking best effort.
- If ingestion fails, user chat still succeeds where possible.
- If provider fails, failed inference metadata still gets logged with error status.
