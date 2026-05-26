import { z } from "zod";

export const logSchema = z.object({
  conversationId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(["success", "error"]),
  mode: z.enum(["sync", "stream"]).optional(),
  latencyMs: z.number().int().nonnegative(),
  ttftMs: z.number().int().nonnegative().optional(),
  streamDurationMs: z.number().int().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  requestTs: z.string().datetime(),
  responseTs: z.string().datetime(),
  inputPreview: z.string().min(1),
  outputPreview: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type IngestPayload = z.infer<typeof logSchema>;
