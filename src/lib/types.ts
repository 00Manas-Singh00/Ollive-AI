export type LogEvent = {
  conversationId: string;
  provider: string;
  model: string;
  status: "success" | "error";
  mode?: "sync" | "stream";
  latencyMs: number;
  ttftMs?: number;
  streamDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestTs: string;
  responseTs: string;
  inputPreview: string;
  outputPreview?: string;
  errorMessage?: string;
};
