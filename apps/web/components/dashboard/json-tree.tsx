"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, Check, ChevronsUpDown } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

/** Valid JS identifier — hoisted to avoid recreation in render loops (js-hoist-regexp) */
const JS_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

interface JsonTreeProps {
  data: unknown;
  defaultExpandDepth?: number;
}

export function JsonTree({ data, defaultExpandDepth = 2 }: JsonTreeProps) {
  // expandAll uses a version counter: when bumped, every node syncs its
  // localOpen to expandTarget, then resumes independent control.
  const [expandTarget, setExpandTarget] = useState(true);
  const [expandVersion, setExpandVersion] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopyPath = useCallback(async (path: string) => {
    const success = await copyToClipboard(path);
    if (success) {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      setCopiedPath(path);
      copyTimeoutRef.current = setTimeout(() => setCopiedPath(null), 1500);
    }
  }, []);

  const toggleAll = useCallback(() => {
    setExpandTarget((prev) => !prev);
    setExpandVersion((v) => v + 1);
  }, []);

  return (
    <div className="font-mono text-sm">
      <div className="flex items-center justify-end mb-2">
        <button
          onClick={toggleAll}
          className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 cursor-pointer transition-colors uppercase tracking-wide font-bold font-sans"
        >
          <ChevronsUpDown className="h-3 w-3" />
          {expandTarget ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <JsonNode
        keyName={null}
        value={data}
        path=""
        depth={0}
        defaultExpandDepth={defaultExpandDepth}
        expandTarget={expandTarget}
        expandVersion={expandVersion}
        onCopyPath={handleCopyPath}
        copiedPath={copiedPath}
      />
    </div>
  );
}

interface JsonNodeProps {
  keyName: string | null;
  value: unknown;
  path: string;
  depth: number;
  defaultExpandDepth: number;
  expandTarget: boolean;
  expandVersion: number;
  onCopyPath: (path: string) => void;
  copiedPath: string | null;
}

function JsonNode({
  keyName,
  value,
  path,
  depth,
  defaultExpandDepth,
  expandTarget,
  expandVersion,
  onCopyPath,
  copiedPath,
}: JsonNodeProps) {
  const isExpandable = value !== null && typeof value === "object";
  const defaultOpen = depth < defaultExpandDepth;
  const [isOpen, setIsOpen] = useState(defaultOpen);

  // Sync to expand/collapse all — only fires when version bumps (not on mount)
  const prevVersion = useRef(expandVersion);
  useEffect(() => {
    if (expandVersion !== prevVersion.current) {
      prevVersion.current = expandVersion;
      setIsOpen(expandTarget);
    }
  }, [expandVersion, expandTarget]);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const currentPath = useMemo(() => {
    if (!keyName) return path;
    if (JS_IDENT.test(keyName)) {
      return path ? `${path}.${keyName}` : keyName;
    }
    const quotedKey = JSON.stringify(keyName);
    return path ? `${path}[${quotedKey}]` : `[${quotedKey}]`;
  }, [path, keyName]);

  if (!isExpandable) {
    return (
      <div className="flex items-start group py-px" style={{ paddingLeft: depth * 16 }}>
        {keyName !== null && (
          <span
            className="syntax-property shrink-0 cursor-pointer hover:underline"
            onClick={() => onCopyPath(currentPath)}
            title={`Copy: ${currentPath}`}
          >
            {copiedPath === currentPath ? (
              <Check className="inline h-3 w-3 mr-1 text-primary" />
            ) : null}
            {keyName}
            <span className="syntax-punctuation">: </span>
          </span>
        )}
        <PrimitiveValue value={value} />
        <TypeAnnotation value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const count = entries.length;
  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  const MAX_ITEMS = 100;
  const displayEntries = entries.slice(0, MAX_ITEMS);
  const hasMore = entries.length > MAX_ITEMS;

  return (
    <div>
      <div
        className="flex items-center group py-px cursor-pointer hover:bg-muted/50 transition-colors"
        style={{ paddingLeft: depth * 16 }}
        onClick={toggle}
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {keyName !== null && (
          <span
            className="syntax-property shrink-0 ml-0.5 cursor-pointer hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onCopyPath(currentPath);
            }}
            title={`Copy: ${currentPath}`}
          >
            {copiedPath === currentPath ? (
              <Check className="inline h-3 w-3 mr-1 text-primary" />
            ) : null}
            {keyName}
            <span className="syntax-punctuation">: </span>
          </span>
        )}
        <span className="syntax-punctuation">{openBracket}</span>
        {!isOpen && (
          <span className="text-muted-foreground ml-1">
            {isArray ? `${count} items` : `${count} keys`}
            <span className="syntax-punctuation ml-1">{closeBracket}</span>
          </span>
        )}
        <TypeAnnotation value={value} />
      </div>
      {isOpen && (
        <>
          {displayEntries.map(([k, v]) => (
            <JsonNode
              key={k}
              keyName={isArray ? null : k}
              value={v}
              path={isArray ? `${currentPath}[${k}]` : currentPath}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
              expandTarget={expandTarget}
              expandVersion={expandVersion}
              onCopyPath={onCopyPath}
              copiedPath={copiedPath}
            />
          ))}
          {hasMore && (
            <div
              className="text-muted-foreground italic py-px"
              style={{ paddingLeft: (depth + 1) * 16 }}
            >
              ... {entries.length - MAX_ITEMS} more items
            </div>
          )}
          <div className="py-px" style={{ paddingLeft: depth * 16 }}>
            <span className="syntax-punctuation ml-[18px]">{closeBracket}</span>
          </div>
        </>
      )}
    </div>
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) return <span className="syntax-keyword">null</span>;
  if (typeof value === "boolean") return <span className="syntax-number">{String(value)}</span>;
  if (typeof value === "number") return <span className="syntax-number">{String(value)}</span>;
  if (typeof value === "string") {
    const truncated = value.length > 120 ? `${value.slice(0, 120)}...` : value;
    return <span className="syntax-string break-all">&quot;{truncated}&quot;</span>;
  }
  return <span className="text-muted-foreground">{String(value)}</span>;
}

function TypeAnnotation({ value }: { value: unknown }) {
  let label: string;
  if (value === null) label = "null";
  else if (Array.isArray(value)) label = `array(${value.length})`;
  else if (typeof value === "object") label = `object(${Object.keys(value as object).length})`;
  else label = typeof value;

  return (
    <span className="text-[10px] text-muted-foreground/60 ml-2 shrink-0 select-none">{label}</span>
  );
}
