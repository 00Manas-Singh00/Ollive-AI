"use client";

import { useState } from "react";
import {
  summarizeWidgetResponse,
  type ChartWidget,
  type ChoiceWidget,
  type SliderWidget,
  type WidgetDirective,
  type WidgetResponse,
} from "@/lib/generative-ui";

export type WidgetInteractionData = {
  id: string;
  widgetType: string;
  schema: WidgetDirective;
  userResponse: WidgetResponse | null;
};

type RespondFn = (response: WidgetResponse) => void;

function SliderControl({ widget, answered, onRespond }: { widget: SliderWidget; answered: boolean; onRespond: RespondFn }) {
  const [value, setValue] = useState(widget.defaultValue ?? widget.min);
  return (
    <div className="widget-body">
      <input
        type="range"
        className="widget-slider"
        min={widget.min}
        max={widget.max}
        step={widget.step ?? 1}
        value={value}
        disabled={answered}
        onChange={(e) => setValue(Number(e.target.value))}
      />
      <div className="widget-slider-row">
        <span className="widget-slider-bound">{widget.min}</span>
        <span className="widget-slider-value">{value}</span>
        <span className="widget-slider-bound">{widget.max}</span>
      </div>
      {!answered && (
        <button className="mini-btn" onClick={() => onRespond({ value })}>Send</button>
      )}
    </div>
  );
}

function ChoiceControl({ widget, answered, onRespond }: { widget: ChoiceWidget; answered: boolean; onRespond: RespondFn }) {
  const [selected, setSelected] = useState<string[]>([]);

  function pick(option: string) {
    if (answered) return;
    if (!widget.multiple) return onRespond({ selected: [option] });
    setSelected((prev) => (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]));
  }

  return (
    <div className="widget-body">
      <div className="widget-choices">
        {widget.options.map((option) => (
          <button
            key={option}
            className={`widget-choice${selected.includes(option) ? " selected" : ""}`}
            disabled={answered}
            onClick={() => pick(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {widget.multiple && !answered && (
        <button className="mini-btn" disabled={selected.length === 0} onClick={() => onRespond({ selected })}>
          Send
        </button>
      )}
    </div>
  );
}

// Single-series inline chart: one accent hue, muted text labels, thin marks,
// per-mark hover title; clicking a mark asks about that data point.
function ChartControl({ widget, answered, onRespond }: { widget: ChartWidget; answered: boolean; onRespond: RespondFn }) {
  const max = Math.max(...widget.data.map((d) => Math.abs(d.value)), 1e-9);

  if (widget.chartType === "line") {
    const w = 100;
    const h = 40;
    const points = widget.data.map((d, i) => ({
      ...d,
      x: widget.data.length === 1 ? w / 2 : (i / (widget.data.length - 1)) * w,
      y: h - 4 - (Math.abs(d.value) / max) * (h - 8),
    }));
    return (
      <div className="widget-body">
        <svg className="widget-line-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <polyline
            points={points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {points.map((p) => (
            <circle
              key={p.label}
              className="widget-line-point"
              cx={p.x}
              cy={p.y}
              r={2.5}
              onClick={() => !answered && onRespond({ label: p.label, value: p.value })}
            >
              <title>{`${p.label}: ${p.value}`}</title>
            </circle>
          ))}
        </svg>
        <div className="widget-chart-labels">
          <span>{widget.data[0].label}</span>
          <span>{widget.data[widget.data.length - 1].label}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="widget-body">
      <div className="widget-bar-chart">
        {widget.data.map((d) => (
          <button
            key={d.label}
            className="widget-bar-col"
            disabled={answered}
            title={`${d.label}: ${d.value}`}
            onClick={() => onRespond({ label: d.label, value: d.value })}
          >
            <span
              className="widget-bar"
              style={{ height: `${Math.max(4, (Math.abs(d.value) / max) * 100)}%` }}
            />
            <span className="widget-bar-label">{d.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Props = {
  messageId: string;
  widget: WidgetInteractionData;
  onRespond: (messageId: string, response: WidgetResponse, summary: string) => Promise<void> | void;
};

export default function WidgetRenderer({ messageId, widget, onRespond }: Props) {
  const [pendingResponse, setPendingResponse] = useState<WidgetResponse | null>(null);
  const schema = widget.schema;
  const response = widget.userResponse ?? pendingResponse;
  const answered = response !== null;

  function respond(userResponse: WidgetResponse) {
    setPendingResponse(userResponse);
    void onRespond(messageId, userResponse, summarizeWidgetResponse(schema, userResponse));
  }

  return (
    <div className={`widget-card${answered ? " answered" : ""}`}>
      <div className="widget-head">
        <span className="widget-type-badge">{schema.type}</span>
        <span className="widget-label">{schema.label}</span>
      </div>
      {schema.type === "slider" && <SliderControl widget={schema} answered={answered} onRespond={respond} />}
      {schema.type === "choice" && <ChoiceControl widget={schema} answered={answered} onRespond={respond} />}
      {schema.type === "chart" && <ChartControl widget={schema} answered={answered} onRespond={respond} />}
      {answered && response && (
        <div className="widget-answered">✓ {summarizeWidgetResponse(schema, response)}</div>
      )}
    </div>
  );
}
