import { runProviderWithTools, type ProviderName, type ToolTurn } from "@/lib/llm";
import { TOOLS, getToolByName, type ToolContext } from "@/lib/tools/registry";

export type ToolCallRecord = {
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "SUCCESS" | "ERROR";
  latencyMs: number;
};

type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_ITERATIONS = 5;
const TOOL_TIMEOUT_MS = 10_000;

function toTurns(messages: LLMMessage[]): ToolTurn[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

async function executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Tool execution timed out")), TOOL_TIMEOUT_MS)),
  ]);
}

// Call model -> if it requests tools, validate + execute + feed results back ->
// re-call, up to MAX_ITERATIONS. Hard-falls back to a normal (tool-less) call
// on loop exhaustion rather than surfacing a partial/unresolved state.
export async function runToolLoop(params: {
  provider: ProviderName;
  model: string;
  messages: LLMMessage[];
  conversationId: string;
  userId: string;
}): Promise<{ output: string; toolCalls: ToolCallRecord[] }> {
  const toolCallRecords: ToolCallRecord[] = [];
  const ctx: ToolContext = { conversationId: params.conversationId, userId: params.userId };
  const toolDefs = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

  let turns: ToolTurn[] = toTurns(params.messages);

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const resp = await runProviderWithTools({ provider: params.provider, model: params.model, turns, tools: toolDefs });

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      return { output: resp.content, toolCalls: toolCallRecords };
    }

    turns = [...turns, { role: "assistant", content: resp.content, toolCalls: resp.toolCalls }];

    for (const call of resp.toolCalls) {
      const start = Date.now();
      const tool = getToolByName(call.name);
      if (!tool) {
        const result = { error: `Unknown tool "${call.name}"` };
        turns = [...turns, { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) }];
        toolCallRecords.push({ toolName: call.name, arguments: call.arguments, result, status: "ERROR", latencyMs: Date.now() - start });
        continue;
      }
      try {
        const parsedArgs = tool.schema.parse(call.arguments ?? {});
        const result = await executeWithTimeout(() => tool.execute(parsedArgs, ctx));
        turns = [...turns, { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) }];
        toolCallRecords.push({ toolName: call.name, arguments: parsedArgs, result, status: "SUCCESS", latencyMs: Date.now() - start });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool execution failed";
        const result = { error: message };
        turns = [...turns, { role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) }];
        toolCallRecords.push({ toolName: call.name, arguments: call.arguments, result, status: "ERROR", latencyMs: Date.now() - start });
      }
    }
  }

  const finalResp = await runProviderWithTools({ provider: params.provider, model: params.model, turns, tools: [] });
  return { output: finalResp.content, toolCalls: toolCallRecords };
}
