"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { AnyRequestSummary } from "@/types/request";

/** Method to fill color for SVG dots */
const METHOD_FILL: Record<string, string> = {
  GET: "hsl(162, 100%, 41%)", // primary
  POST: "hsl(52, 100%, 50%)", // secondary
  PUT: "hsl(280, 100%, 65%)", // accent
  PATCH: "hsl(280, 100%, 65%)", // accent
  DELETE: "hsl(0, 84%, 60%)", // destructive
};
const DEFAULT_FILL = "hsl(0, 0%, 60%)";

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
    // Ensure at least 1 second range
    if (max - min < 1000) {
      min -= 500;
      max += 500;
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

      return {
        id,
        x: PADDING_X + rawX,
        y: PADDING_Y + stackIndex * ROW_HEIGHT,
        method: r.method,
        receivedAt: r.receivedAt,
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
    const labelCount = Math.max(2, Math.min(6, Math.floor(usableWidth / 80)));
    const labels: { x: number; label: string }[] = [];

    for (let i = 0; i < labelCount; i++) {
      const t = timeRange.min + (range * i) / (labelCount - 1);
      const x = PADDING_X + (usableWidth * i) / (labelCount - 1);
      const d = new Date(t);
      labels.push({
        x,
        label: d.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
      });
    }
    return labels;
  }, [timeRange, width]);

  if (requests.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground font-bold uppercase tracking-wide">
        No requests to display
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-auto">
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
            textAnchor="middle"
            className="fill-muted-foreground text-[9px] font-mono"
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
            <circle
              key={dot.id}
              cx={dot.x}
              cy={dot.y}
              r={r}
              fill={fill}
              stroke={isSelected ? "hsl(var(--foreground))" : "none"}
              strokeWidth={isSelected ? 2 : 0}
              opacity={isSelected || isHovered ? 1 : 0.7}
              className="cursor-pointer transition-all duration-100"
              onClick={() => onSelect(dot.id)}
              onMouseEnter={() => setHoveredId(dot.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <title>
                {dot.method} — {new Date(dot.receivedAt).toLocaleTimeString()}
              </title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
