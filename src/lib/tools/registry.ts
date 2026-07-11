import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { retrieveRelevantChunks } from "@/lib/rag";

// Phase 18 — Agentic Tool Use. Four safe built-ins only: no arbitrary code
// execution, no shell, no unrestricted fetch. Each tool's JSON schema (sent to
// providers) and zod schema (runtime validation of returned arguments) are
// kept side by side so they can't drift apart.

export type ToolContext = { conversationId: string; userId: string };

export type ToolDefinition<T = unknown> = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  schema: z.ZodType<T>;
  execute: (args: T, ctx: ToolContext) => Promise<unknown>;
};

// --- calculator: hand-rolled recursive-descent evaluator over a restricted
// grammar (numbers, + - * / ( ), unary +/-). No eval()/Function().
const CALC_TOKEN = /\s*(\d+(?:\.\d+)?|[+\-*/()])/g;

function tokenizeExpression(expression: string): string[] {
  const tokens: string[] = [];
  let rest = expression;
  let match: RegExpExecArray | null;
  CALC_TOKEN.lastIndex = 0;
  let consumed = 0;
  while ((match = CALC_TOKEN.exec(expression)) !== null) {
    if (match.index !== consumed) throw new Error(`Unexpected character near "${expression.slice(consumed, match.index + 1)}"`);
    tokens.push(match[1]);
    consumed = CALC_TOKEN.lastIndex;
  }
  if (consumed !== expression.length) throw new Error("Unexpected trailing characters in expression");
  void rest;
  return tokens;
}

function evaluateExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parsePrimary(): number {
    const tok = next();
    if (tok === undefined) throw new Error("Unexpected end of expression");
    if (tok === "(") {
      const value = parseExpr();
      if (next() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    if (tok === "-") return -parsePrimary();
    if (tok === "+") return parsePrimary();
    const num = Number(tok);
    if (Number.isNaN(num)) throw new Error(`Invalid number "${tok}"`);
    return num;
  }

  function parseTerm(): number {
    let value = parsePrimary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const rhs = parsePrimary();
      if (op === "/") {
        if (rhs === 0) throw new Error("Division by zero");
        value /= rhs;
      } else {
        value *= rhs;
      }
    }
    return value;
  }

  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("Unexpected trailing tokens in expression");
  if (!Number.isFinite(result)) throw new Error("Expression did not evaluate to a finite number");
  return result;
}

const calculatorTool: ToolDefinition<{ expression: string }> = {
  name: "calculator",
  description: "Evaluate a basic arithmetic expression (numbers, + - * / and parentheses). Not a general code interpreter.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "Arithmetic expression, e.g. \"(2 + 3) * 4\"" } },
    required: ["expression"],
  },
  schema: z.object({ expression: z.string().min(1).max(200) }),
  execute: async (args) => ({ result: evaluateExpression(args.expression) }),
};

const currentTimeTool: ToolDefinition<Record<string, never>> = {
  name: "current_time",
  description: "Get the current date and time in UTC.",
  parameters: { type: "object", properties: {} },
  schema: z.object({}),
  execute: async () => ({ iso: new Date().toISOString(), unixMs: Date.now() }),
};

const knowledgeSearchTool: ToolDefinition<{ query: string; topK?: number }> = {
  name: "knowledge_search",
  description: "Search the knowledge documents attached to this conversation for relevant passages.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language search query" },
      topK: { type: "number", description: "Number of results to return (1-10, default 3)" },
    },
    required: ["query"],
  },
  schema: z.object({ query: z.string().min(1).max(500), topK: z.number().int().min(1).max(10).optional() }),
  execute: async (args, ctx) => {
    const chunks = await retrieveRelevantChunks(args.query, ctx.conversationId, args.topK ?? 3);
    return { results: chunks.map((c) => ({ text: c.text.slice(0, 800), score: c.score })) };
  },
};

const conversationSummaryTool: ToolDefinition<Record<string, never>> = {
  name: "conversation_summary",
  description: "Get a compact summary of the most recent turns in this conversation.",
  parameters: { type: "object", properties: {} },
  schema: z.object({}),
  execute: async (_args, ctx) => {
    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: ctx.conversationId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { role: true, content: true },
    });
    const ordered = messages.reverse();
    const summary = ordered.map((m) => `${m.role}: ${m.content.length > 200 ? `${m.content.slice(0, 200)}...` : m.content}`).join("\n");
    return { summary, messageCount: ordered.length };
  },
};

export const TOOLS: ToolDefinition<any>[] = [calculatorTool, currentTimeTool, knowledgeSearchTool, conversationSummaryTool];

export function getToolByName(name: string): ToolDefinition<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}
