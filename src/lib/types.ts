export type LogEvent = {
  conversationId: string;
  provider: string;
  model: string;
  status: "success" | "error";
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestTs: string;
  responseTs: string;
  inputPreview: string;
  outputPreview?: string;
  errorMessage?: string;
};
