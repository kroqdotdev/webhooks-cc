"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { formatBytes, formatTimestamp } from "@/types/request";
import type { DisplayableRequest } from "./request-detail";
import { computeJsonDiff, computeMapDiff, type DiffType } from "@/lib/json-diff";

interface RequestDiffProps {
  left: DisplayableRequest;
  right: DisplayableRequest;
  onExit: () => void;
}

const DIFF_COLORS: Record<DiffType, string> = {
  added: "bg-green-500/10 text-green-700 dark:text-green-300",
  removed: "bg-red-500/10 text-red-700 dark:text-red-300",
  changed: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  unchanged: "",
};

const DIFF_LABELS: Record<DiffType, string> = {
  added: "+",
  removed: "-",
  changed: "~",
  unchanged: " ",
};

export function RequestDiff({ left, right, onExit }: RequestDiffProps) {
  const leftId = "id" in left ? left.id : left._id;
  const rightId = "id" in right ? right.id : right._id;

  const bodyDiff = useMemo(() => {
    const leftJson = tryParse(left.body);
    const rightJson = tryParse(right.body);
    if (leftJson !== null && rightJson !== null) {
      return computeJsonDiff(leftJson, rightJson);
    }
    return null;
  }, [left.body, right.body]);

  const changedBodyDiff = useMemo(
    () => bodyDiff?.filter((e) => e.type !== "unchanged") ?? [],
    [bodyDiff]
  );

  const headerDiff = useMemo(
    () => computeMapDiff(left.headers, right.headers),
    [left.headers, right.headers]
  );

  const queryDiff = useMemo(
    () => computeMapDiff(left.queryParams, right.queryParams),
    [left.queryParams, right.queryParams]
  );

  const changedCount = useMemo(() => {
    let count = 0;
    if (bodyDiff) count += bodyDiff.filter((e) => e.type !== "unchanged").length;
    count += headerDiff.filter((e) => e.type !== "unchanged").length;
    count += queryDiff.filter((e) => e.type !== "unchanged").length;
    if (left.method !== right.method) count++;
    if (left.path !== right.path) count++;
    return count;
  }, [bodyDiff, headerDiff, queryDiff, left.method, right.method, left.path, right.path]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b-2 border-foreground px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-xs font-bold uppercase tracking-wide">Comparing</span>
            <span className="font-mono text-xs text-muted-foreground">#{leftId.slice(-6)}</span>
            <span className="text-xs text-muted-foreground">vs</span>
            <span className="font-mono text-xs text-muted-foreground">#{rightId.slice(-6)}</span>
            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide border-2 border-foreground bg-muted">
              {changedCount} difference{changedCount !== 1 ? "s" : ""}
            </span>
          </div>
          <button
            onClick={onExit}
            className="neo-btn-outline py-1! px-2! text-xs flex items-center gap-1"
          >
            <X className="h-3 w-3" />
            Exit
          </button>
        </div>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Method + Path */}
        {(left.method !== right.method || left.path !== right.path) && (
          <DiffSection title="Request">
            {left.method !== right.method && (
              <DiffRow
                label="method"
                type="changed"
                leftValue={left.method}
                rightValue={right.method}
              />
            )}
            {left.path !== right.path && (
              <DiffRow label="path" type="changed" leftValue={left.path} rightValue={right.path} />
            )}
          </DiffSection>
        )}

        {/* Headers */}
        <DiffSection title="Headers">
          {headerDiff.length === 0 ? (
            <span className="text-xs text-muted-foreground">(identical)</span>
          ) : (
            headerDiff.map((entry) => (
              <DiffRow
                key={entry.path}
                label={entry.key}
                type={entry.type}
                leftValue={entry.leftValue}
                rightValue={entry.rightValue}
              />
            ))
          )}
        </DiffSection>

        {/* Body */}
        <DiffSection title="Body">
          {bodyDiff ? (
            changedBodyDiff.length === 0 ? (
              <span className="text-xs text-muted-foreground">(identical)</span>
            ) : (
              changedBodyDiff.map((entry) => (
                <DiffRow
                  key={entry.path}
                  label={entry.path}
                  type={entry.type}
                  leftValue={entry.leftValue}
                  rightValue={entry.rightValue}
                />
              ))
            )
          ) : (
            <div className="text-xs font-mono">
              {left.body === right.body ? (
                <span className="text-muted-foreground">(identical)</span>
              ) : (
                <>
                  <DiffRow label="body" type="removed" leftValue={truncate(left.body)} />
                  <DiffRow label="body" type="added" rightValue={truncate(right.body)} />
                </>
              )}
            </div>
          )}
        </DiffSection>

        {/* Query Params */}
        <DiffSection title="Query Params">
          {queryDiff.length === 0 ? (
            <span className="text-xs text-muted-foreground">(identical)</span>
          ) : (
            queryDiff.map((entry) => (
              <DiffRow
                key={entry.path}
                label={entry.key}
                type={entry.type}
                leftValue={entry.leftValue}
                rightValue={entry.rightValue}
              />
            ))
          )}
        </DiffSection>

        {/* Metadata */}
        <DiffSection title="Metadata">
          <div className="grid grid-cols-2 gap-4 text-xs font-mono">
            <div>
              <div className="text-muted-foreground mb-1">#{leftId.slice(-6)}</div>
              <div>{left.ip}</div>
              <div>{formatBytes(left.size)}</div>
              <div>{formatTimestamp(left.receivedAt)}</div>
            </div>
            <div>
              <div className="text-muted-foreground mb-1">#{rightId.slice(-6)}</div>
              <div>{right.ip}</div>
              <div>{formatBytes(right.size)}</div>
              <div>{formatTimestamp(right.receivedAt)}</div>
            </div>
          </div>
        </DiffSection>
      </div>
    </div>
  );
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
        {title}
      </h3>
      <div className="neo-code p-3 space-y-0.5">{children}</div>
    </div>
  );
}

function DiffRow({
  label,
  type,
  leftValue,
  rightValue,
}: {
  label: string;
  type: DiffType;
  leftValue?: unknown;
  rightValue?: unknown;
}) {
  if (type === "unchanged") {
    return (
      <div className="flex items-start gap-2 py-0.5 text-xs font-mono">
        <span className="text-muted-foreground/40 w-3 shrink-0">{DIFF_LABELS[type]}</span>
        <span className="text-muted-foreground shrink-0">{label}:</span>
        <span className="break-all">{formatValue(leftValue)}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-2 py-0.5 text-xs font-mono px-1", DIFF_COLORS[type])}>
      <span className="font-bold w-3 shrink-0">{DIFF_LABELS[type]}</span>
      <span className="font-semibold shrink-0">{label}:</span>
      {type === "changed" ? (
        <span className="break-all">
          <span className="line-through opacity-60">{formatValue(leftValue)}</span>
          <span className="mx-1">&rarr;</span>
          <span>{formatValue(rightValue)}</span>
        </span>
      ) : (
        <span className="break-all">{formatValue(type === "added" ? rightValue : leftValue)}</span>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(value?: string, max = 200): string {
  if (!value) return "(empty)";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function tryParse(json?: string): unknown | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
