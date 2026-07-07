import { z } from "zod";

// Phase 14 — Generative UI Widgets.
// The model may end a reply with a fenced ```widget block containing JSON for one
// interactive control (slider, choice buttons, small chart). The chat route strips
// the block from the displayed text, persists a WidgetInteraction row, and the UI
// renders the typed widget; the user's interaction is posted back and synthesized
// into a follow-up user turn. This module is client-safe: schemas + parsing only,
// no Prisma import.

export const SliderWidgetSchema = z
  .object({
    type: z.literal("slider"),
    label: z.string().min(1).max(200),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive().optional(),
    defaultValue: z.number().finite().optional(),
  })
  .refine((w) => w.max > w.min, { message: "max must be greater than min" });

export const ChoiceWidgetSchema = z.object({
  type: z.literal("choice"),
  label: z.string().min(1).max(200),
  options: z.array(z.string().min(1).max(120)).min(2).max(8),
  multiple: z.boolean().optional(),
});

export const ChartWidgetSchema = z.object({
  type: z.literal("chart"),
  label: z.string().min(1).max(200),
  chartType: z.enum(["bar", "line"]),
  data: z
    .array(z.object({ label: z.string().min(1).max(60), value: z.number().finite() }))
    .min(2)
    .max(24),
});

// z.union (not discriminatedUnion) because the refined slider schema is a ZodEffects.
export const WidgetDirectiveSchema = z.union([SliderWidgetSchema, ChoiceWidgetSchema, ChartWidgetSchema]);

export type SliderWidget = z.infer<typeof SliderWidgetSchema>;
export type ChoiceWidget = z.infer<typeof ChoiceWidgetSchema>;
export type ChartWidget = z.infer<typeof ChartWidgetSchema>;
export type WidgetDirective = z.infer<typeof WidgetDirectiveSchema>;
export type WidgetType = WidgetDirective["type"];

// Appended to the system prompt so the model knows the directive format exists.
export const WIDGET_SUFFIX = [
  "When (and only when) an interactive control would genuinely help — collecting a numeric preference, a pick between options, or showing a small numeric series — you may end your reply with exactly one widget directive:",
  'a fenced code block with language "widget" containing only JSON, as the last thing in the reply.',
  'Supported shapes: {"type":"slider","label":string,"min":number,"max":number,"step"?:number,"defaultValue"?:number}',
  '| {"type":"choice","label":string,"options":[2-8 strings],"multiple"?:boolean}',
  '| {"type":"chart","label":string,"chartType":"bar"|"line","data":[{"label":string,"value":number}, ...]}.',
  "Never mention or describe the widget block in your prose.",
].join(" ");

const WIDGET_BLOCK = /```widget\s*\n([\s\S]*?)```/;

// Extracts and validates the first ```widget fenced block from an assembled LLM
// response. Invalid/malformed directives are ignored and the text is left intact
// (a broken directive must never break the chat turn).
export function parseWidgetDirective(rawResponse: string): { widget: WidgetDirective | null; text: string } {
  const match = rawResponse.match(WIDGET_BLOCK);
  if (!match) return { widget: null, text: rawResponse };

  let candidate: unknown;
  try {
    candidate = JSON.parse(match[1]);
  } catch {
    return { widget: null, text: rawResponse };
  }

  const result = WidgetDirectiveSchema.safeParse(candidate);
  if (!result.success) return { widget: null, text: rawResponse };

  const text = rawResponse.replace(WIDGET_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
  return { widget: result.data, text };
}

// Streaming stripper: wraps the visible-token callback so the ```widget block never
// reaches the live stream. It holds back only a trailing partial that could still grow
// into the fence marker, emits everything else immediately, and once the full marker is
// seen swallows the remainder of the stream (the block is always last). The caller still
// accumulates the raw response separately for parseWidgetDirective.
export function createWidgetStripper(onVisible: (token: string) => void): {
  push: (token: string) => void;
  flush: () => void;
} {
  const MARKER = "```widget";
  let hold = "";
  let swallowing = false;

  // Largest k where hold's last k chars equal MARKER's first k chars (a possible in-progress marker).
  const partialMarkerTail = (s: string): number => {
    const max = Math.min(s.length, MARKER.length - 1);
    for (let k = max; k > 0; k -= 1) {
      if (s.slice(s.length - k) === MARKER.slice(0, k)) return k;
    }
    return 0;
  };

  const push = (token: string) => {
    if (swallowing) return;
    hold += token;

    const idx = hold.indexOf(MARKER);
    if (idx !== -1) {
      if (idx > 0) onVisible(hold.slice(0, idx));
      hold = "";
      swallowing = true;
      return;
    }

    const keep = partialMarkerTail(hold);
    if (keep < hold.length) {
      onVisible(hold.slice(0, hold.length - keep));
      hold = hold.slice(hold.length - keep);
    }
  };

  const flush = () => {
    if (swallowing || !hold) return;
    onVisible(hold);
    hold = "";
  };

  return { push, flush };
}

// --- User responses ---

export const SliderResponseSchema = z.object({ value: z.number().finite() });
export const ChoiceResponseSchema = z.object({ selected: z.array(z.string().min(1).max(120)).min(1).max(8) });
export const ChartResponseSchema = z.object({ label: z.string().min(1).max(60), value: z.number().finite() });

export type WidgetResponse =
  | z.infer<typeof SliderResponseSchema>
  | z.infer<typeof ChoiceResponseSchema>
  | z.infer<typeof ChartResponseSchema>;

const RESPONSE_SCHEMAS: Record<WidgetType, z.ZodTypeAny> = {
  slider: SliderResponseSchema,
  choice: ChoiceResponseSchema,
  chart: ChartResponseSchema,
};

export function validateWidgetResponse(
  widgetType: string,
  userResponse: unknown,
): { ok: true; data: WidgetResponse } | { ok: false; error: string } {
  const schema = RESPONSE_SCHEMAS[widgetType as WidgetType];
  if (!schema) return { ok: false, error: `Unknown widget type: ${widgetType}` };
  const result = schema.safeParse(userResponse);
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? "Invalid widget response" };
  return { ok: true, data: result.data as WidgetResponse };
}

// Synthesizes the follow-up user turn sent after a widget interaction.
export function summarizeWidgetResponse(widget: WidgetDirective, response: WidgetResponse): string {
  switch (widget.type) {
    case "slider": {
      const { value } = response as z.infer<typeof SliderResponseSchema>;
      return `I set "${widget.label}" to ${value}.`;
    }
    case "choice": {
      const { selected } = response as z.infer<typeof ChoiceResponseSchema>;
      return `For "${widget.label}", I chose: ${selected.join(", ")}.`;
    }
    case "chart": {
      const { label, value } = response as z.infer<typeof ChartResponseSchema>;
      return `On the "${widget.label}" chart, tell me more about "${label}" (${value}).`;
    }
  }
}
