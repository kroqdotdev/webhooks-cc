"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { AnyRequestSummary } from "@/types/request";

/** Method to fill color for SVG dots, from the --method-* and --kind-email tokens in globals.css */
const METHOD_FILL: Record<string, string> = {
  GET: "hsl(var(--method-get))",
  POST: "hsl(var(--method-post))",
  PUT: "hsl(var(--method-put))",
  PATCH: "hsl(var(--method-put))",
  DELETE: "hsl(var(--method-delete))",
  EMAIL: "hsl(var(--kind-email))",
};
const DEFAULT_FILL = "hsl(0, 0%, 60%)";

/** The legend under the axis: one swatch per colour the dots use. */
const LEGEND: { key: string; label: string }[] = [
  { key: "GET", label: "GET" },
  { key: "POST", label: "POST" },
  { key: "PUT", label: "PUT, PATCH" },
  { key: "DELETE", label: "DELETE" },
];

function getItemId(item: AnyRequestSummary): string {
  return "_id" in item ? item._id : item.id;
}

interface RequestTimelineProps {
  requests: AnyRequestSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const DOT_RADIUS = 5;
const SELECTED_RADIUS = 7;
const PADDING_X = 24;
const PADDING_Y = 20;
const ROW_HEIGHT = 16;
/** The click target around each dot: 24px across, larger than the dot itself. */
const HIT_RADIUS = 12;

export function RequestTimeline({ requests, selectedId, onSelect }: RequestTimelineProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Observe container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { dots, timeRange, height } = useMemo(() => {
    if (requests.length === 0) {
      return { dots: [], timeRange: { min: 0, max: 1 }, height: 80 };
    }

    let min = Infinity;
    let max = -Infinity;
    for (const r of requests) {
      if (r.receivedAt < min) min = r.receivedAt;
      if (r.receivedAt > max) max = r.receivedAt;
    }
    // At least a minute across, centred on the requests, so a burst within a
    // few seconds reads as a burst rather than one point with repeated labels.
    const MIN_RANGE = 60_000;
    if (max - min < MIN_RANGE) {
      const pad = (MIN_RANGE - (max - min)) / 2;
      min -= pad;
      max += pad;
    }

    const usableWidth = width - PADDING_X * 2;
    const range = max - min;

    // Position dots, stack vertically when they overlap
    const columns: Map<number, number> = new Map();
    const dotData = requests.map((r) => {
      const id = getItemId(r);
      const rawX = ((r.receivedAt - min) / range) * usableWidth;
      const col = Math.round(rawX / (DOT_RADIUS * 2.5));
      const stackIndex = columns.get(col) ?? 0;
      columns.set(col, stackIndex + 1);

      const what = r.email ? r.email.subject || "(no subject)" : r.path;
      return {
        id,
        x: PADDING_X + rawX,
        y: PADDING_Y + stackIndex * ROW_HEIGHT,
        method: r.method,
        // What the tooltip (and the dot's accessible name) says: the method,
        // the path or an email's subject, and the time.
        label: [r.method, what, new Date(r.receivedAt).toLocaleTimeString()]
          .filter(Boolean)
          .join(" "),
      };
    });

    const maxStack = Math.max(...columns.values(), 1);
    const computedHeight = PADDING_Y * 2 + maxStack * ROW_HEIGHT;

    return {
      dots: dotData,
      timeRange: { min, max },
      height: Math.max(80, computedHeight),
    };
  }, [requests, width]);

  // Time axis labels
  const timeLabels = useMemo(() => {
    const range = timeRange.max - timeRange.min;
    const usableWidth = width - PADDING_X * 2;
    // A label is about 55px wide at 11px; keep a gap between neighbours.
    const labelCount = Math.max(2, Math.min(6, Math.floor(usableWidth / 96)));
    const labels: { x: number; label: string; anchor: "start" | "middle" | "end" }[] = [];

    for (let i = 0; i < labelCount; i++) {
      const t = timeRange.min + (range * i) / (labelCount - 1);
      const x = PADDING_X + (usableWidth * i) / (labelCount - 1);
      const d = new Date(t);
      const label = d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      // Never the same label twice in a row.
      if (labels.at(-1)?.label === label) continue;
      // The first and last labels sit inside the axis ends, so they stay
      // within the pane's padding instead of hanging over the edge.
      labels.push({
        x,
        label,
        anchor: i === 0 ? "start" : i === labelCount - 1 ? "end" : "middle",
      });
    }
    return labels;
  }, [timeRange, width]);

  const hasEmail = requests.some((request) => request.method === "EMAIL");

  if (requests.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground font-bold caps">
        No requests to display
      </div>
    );
  }

  return (
    <div ref={containerRef} className="ph-no-capture h-full overflow-auto">
      <svg ref={svgRef} width={width} height={height + 24} className="select-none">
        {/* Time axis */}
        <line
          x1={PADDING_X}
          y1={height}
          x2={width - PADDING_X}
          y2={height}
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={1}
        />
        {timeLabels.map((label, i) => (
          <text
            key={i}
            x={label.x}
            y={height + 16}
            textAnchor={label.anchor}
            className="fill-muted-foreground text-[11px] font-mono"
          >
            {label.label}
          </text>
        ))}

        {/* Dots */}
        {dots.map((dot) => {
          const isSelected = dot.id === selectedId;
          const isHovered = dot.id === hoveredId;
          const r = isSelected ? SELECTED_RADIUS : isHovered ? DOT_RADIUS + 1 : DOT_RADIUS;
          const fill = METHOD_FILL[dot.method] ?? DEFAULT_FILL;

          return (
            <g
              key={dot.id}
              role="button"
              tabIndex={0}
              aria-label={dot.label}
              aria-pressed={isSelected}
              className="group cursor-pointer outline-none"
              onClick={() => onSelect(dot.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelect(dot.id);
              }}
              onMouseEnter={() => setHoveredId(dot.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <title>{dot.label}</title>
              {/* The keyboard focus ring, drawn around the dot. */}
              <circle
                cx={dot.x}
                cy={dot.y}
                r={r + 4}
                fill="none"
                stroke="hsl(var(--ring))"
                strokeWidth={2}
                className="opacity-0 group-focus-visible:opacity-100"
              />
              <circle
                cx={dot.x}
                cy={dot.y}
                r={r}
                fill={fill}
                stroke={isSelected ? "hsl(var(--foreground))" : "none"}
                strokeWidth={isSelected ? 2 : 0}
                opacity={isSelected || isHovered ? 1 : 0.7}
                className="transition-all duration-100"
              />
              <circle cx={dot.x} cy={dot.y} r={HIT_RADIUS} fill="transparent" />
            </g>
          );
        })}
      </svg>
      <ul
        aria-label="Legend"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 pb-3 text-xs text-muted-foreground"
      >
        {[...LEGEND, ...(hasEmail ? [{ key: "EMAIL", label: "Email" }] : [])].map((entry) => (
          <li key={entry.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: METHOD_FILL[entry.key] }}
            />
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
