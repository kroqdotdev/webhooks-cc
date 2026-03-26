"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  Circle,
  ArrowUpDown,
  Search,
  X,
  Loader2,
  Star,
  StickyNote,
  BarChart3,
  List,
  GitCompareArrows,
  Clipboard,
} from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import {
  getMethodColor,
  formatTimestamp,
  formatRelativeTimestamp,
  formatBytes,
  getContentTypeLabel,
} from "@/types/request";
import type { AnyRequestSummary } from "@/types/request";

const TS_PREF_KEY = "request_list_relative_time";

/** Extract a string ID from a RequestSummary or ClickHouseSummary. */
function getItemId(item: AnyRequestSummary): string {
  return "_id" in item ? item._id : item.id;
}

interface RequestListProps {
  requests: AnyRequestSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  liveMode: boolean;
  onToggleLiveMode: () => void;
  sortNewest: boolean;
  onToggleSort: () => void;
  newCount?: number;
  onJumpToNew?: () => void;
  totalCount?: number;
  methodFilter: string;
  onMethodFilterChange: (method: string) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  searchLoading?: boolean;
  searchError?: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  pinnedIds?: Set<string>;
  onTogglePin?: (id: string) => void;
  noteIds?: Set<string>;
  compareId?: string | null;
  onCompareSelect?: (id: string) => void;
  viewMode?: "list" | "timeline";
  onViewModeChange?: (mode: "list" | "timeline") => void;
  timelineSlot?: React.ReactNode;
}

const METHODS = ["ALL", "GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function RequestList({
  requests,
  selectedId,
  onSelect,
  liveMode,
  onToggleLiveMode,
  sortNewest,
  onToggleSort,
  newCount,
  onJumpToNew,
  totalCount,
  methodFilter,
  onMethodFilterChange,
  searchQuery,
  onSearchQueryChange,
  onLoadMore,
  hasMore,
  loadingMore,
  searchLoading,
  searchError,
  searchInputRef,
  pinnedIds,
  onTogglePin,
  noteIds,
  compareId,
  onCompareSelect,
  viewMode,
  onViewModeChange,
  timelineSlot,
}: RequestListProps) {
  const displayCount = totalCount ?? requests.length;
  const internalSearchRef = useRef<HTMLInputElement>(null);
  const inputRef = searchInputRef ?? internalSearchRef;

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    function close(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setCtxMenu(null);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    // Clamp to viewport so the menu doesn't overflow off-screen
    const menuW = 180;
    const menuH = 120;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setCtxMenu({ x: Math.max(0, x), y: Math.max(0, y), id });
  }, []);

  // Pin/unpin split
  const { pinned, unpinned } = useMemo(() => {
    const sorted = sortNewest ? requests : [...requests].reverse();
    if (!pinnedIds || pinnedIds.size === 0) {
      return { pinned: [] as AnyRequestSummary[], unpinned: sorted };
    }
    const p: AnyRequestSummary[] = [];
    const u: AnyRequestSummary[] = [];
    for (const r of sorted) {
      if (pinnedIds.has(getItemId(r))) p.push(r);
      else u.push(r);
    }
    return { pinned: p, unpinned: u };
  }, [requests, sortNewest, pinnedIds]);

  // Shift-click compare
  const handleRowClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.shiftKey && onCompareSelect) {
        e.preventDefault();
        onCompareSelect(id);
      } else {
        onSelect(id);
      }
    },
    [onSelect, onCompareSelect]
  );

  // Timestamp mode: relative vs absolute
  const [relativeTime, setRelativeTime] = useState(false);
  useEffect(() => {
    try {
      setRelativeTime(localStorage.getItem(TS_PREF_KEY) === "true");
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Force re-render every 10s when in relative mode so timestamps stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!relativeTime) return;
    const interval = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(interval);
  }, [relativeTime]);

  const toggleTimestampMode = useCallback(() => {
    setRelativeTime((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TS_PREF_KEY, String(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  const renderTimestamp = (ts: number) =>
    relativeTime ? formatRelativeTimestamp(ts) : formatTimestamp(ts);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b-2 border-foreground px-3 py-2 flex items-center justify-between shrink-0">
        <span className="text-sm font-bold">
          {displayCount} request{displayCount !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          {onViewModeChange && (
            <button
              onClick={() => onViewModeChange(viewMode === "list" ? "timeline" : "list")}
              className="p-1.5 hover:bg-muted transition-colors cursor-pointer border-2 border-foreground"
              title={viewMode === "list" ? "Switch to timeline view" : "Switch to list view"}
              aria-label={viewMode === "list" ? "Switch to timeline view" : "Switch to list view"}
              aria-pressed={viewMode === "timeline"}
            >
              {viewMode === "list" ? (
                <BarChart3 className="h-3.5 w-3.5" />
              ) : (
                <List className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            onClick={onToggleSort}
            className="p-1.5 hover:bg-muted transition-colors cursor-pointer border-2 border-foreground"
            title={sortNewest ? "Showing newest first" : "Showing oldest first"}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onToggleLiveMode}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-xs font-bold uppercase tracking-wide border-2 border-foreground cursor-pointer transition-colors",
              liveMode ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
            )}
            title={
              liveMode
                ? "Live mode: auto-selects new requests"
                : "Review mode: new requests won't interrupt"
            }
          >
            <Circle
              className={cn(
                "h-2 w-2",
                liveMode ? "fill-current" : "fill-muted-foreground text-muted-foreground"
              )}
            />
            {liveMode ? "Live" : "Paused"}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="border-b-2 border-foreground px-3 py-2 flex items-center gap-2 shrink-0">
        <select
          value={methodFilter}
          onChange={(e) => onMethodFilterChange(e.target.value)}
          className="text-xs font-bold uppercase tracking-wide border-2 border-foreground bg-background px-2 py-1 cursor-pointer"
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="flex-1 flex items-center gap-1 border-2 border-foreground px-2 py-1 bg-background">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="Search..."
            className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground font-mono min-w-0"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchQueryChange("")}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* New requests banner */}
      {!liveMode && (newCount ?? 0) > 0 && onJumpToNew && (
        <button
          onClick={onJumpToNew}
          className="bg-primary text-primary-foreground text-xs font-bold text-center py-1.5 cursor-pointer hover:bg-primary/90 transition-colors shrink-0"
        >
          {newCount ?? 0} new request{newCount !== 1 ? "s" : ""}
        </button>
      )}

      {/* Compare hint */}
      {compareId && (
        <div className="bg-amber-100 dark:bg-amber-900/30 text-xs font-bold text-center py-1 shrink-0 border-b-2 border-foreground">
          Shift-click another request to compare
        </div>
      )}

      {/* Request rows */}
      <div className="flex-1 overflow-y-auto">
        {viewMode === "timeline" && timelineSlot ? (
          timelineSlot
        ) : searchLoading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground font-bold uppercase tracking-wide flex items-center justify-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Searching...
          </div>
        ) : pinned.length === 0 && unpinned.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground font-bold uppercase tracking-wide">
            {searchError ? "Search unavailable" : "No matching requests"}
          </div>
        ) : (
          <>
            {/* Pinned section */}
            {pinned.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted/50 border-b border-foreground/10 flex items-center gap-1">
                  <Star className="h-2.5 w-2.5 fill-current" />
                  Pinned
                </div>
                {pinned.map((request) => renderRow(request))}
                {unpinned.length > 0 && (
                  <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted/50 border-b border-foreground/10 border-t border-t-foreground/10">
                    All requests
                  </div>
                )}
              </>
            )}

            {unpinned.map((request) => renderRow(request))}

            {/* Load More button */}
            {hasMore && (
              <div className="px-3 py-3 flex justify-center border-t border-foreground/10">
                <button
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  className={cn(
                    "neo-btn-outline py-1.5! px-4! text-xs font-bold uppercase tracking-wide flex items-center gap-2",
                    loadingMore && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load More"
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed z-50 border-2 border-foreground bg-background shadow-neo min-w-[160px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {onTogglePin && (
            <button
              onClick={() => {
                onTogglePin(ctxMenu.id);
                setCtxMenu(null);
              }}
              className="w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors border-b-2 border-foreground flex items-center gap-2"
            >
              <Star className={cn("h-3 w-3", pinnedIds?.has(ctxMenu.id) && "fill-current")} />
              {pinnedIds?.has(ctxMenu.id) ? "Unpin" : "Pin"}
            </button>
          )}
          {onCompareSelect && (
            <button
              onClick={() => {
                onCompareSelect(ctxMenu.id);
                setCtxMenu(null);
              }}
              className="w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors border-b-2 border-foreground flex items-center gap-2"
            >
              <GitCompareArrows className="h-3 w-3" />
              Compare
            </button>
          )}
          <button
            onClick={() => {
              void copyToClipboard(ctxMenu.id);
              setCtxMenu(null);
            }}
            className="w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors flex items-center gap-2"
          >
            <Clipboard className="h-3 w-3" />
            Copy ID
          </button>
        </div>
      )}
    </div>
  );

  function renderRow(request: AnyRequestSummary) {
    const id = getItemId(request);
    const ctLabel = getContentTypeLabel(request.contentType);
    const isPinned = pinnedIds?.has(id);
    const hasNote = noteIds?.has(id);
    const isComparing = compareId === id;
    return (
      <button
        key={id}
        onClick={(e) => handleRowClick(e, id)}
        onContextMenu={(e) => handleContextMenu(e, id)}
        className={cn(
          "w-full px-3 py-2 text-left cursor-pointer transition-colors border-b border-foreground/10",
          isComparing
            ? "bg-amber-100 dark:bg-amber-900/30 border-l-4 border-l-amber-500"
            : selectedId === id
              ? "bg-muted border-l-4 border-l-primary"
              : "hover:bg-muted/50 border-l-4 border-l-transparent"
        )}
      >
        {/* Top line: method + path + icons + timestamp */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "px-1.5 py-0.5 text-[10px] font-mono font-bold border-2 border-foreground shrink-0 w-14 text-center",
              getMethodColor(request.method)
            )}
          >
            {request.method}
          </span>
          <span className="text-xs font-mono truncate flex-1">{request.path}</span>
          {isPinned && <Star className="h-2.5 w-2.5 text-amber-500 fill-amber-500 shrink-0" />}
          {hasNote && <StickyNote className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
          <span
            className="text-[10px] text-muted-foreground font-mono shrink-0 cursor-pointer hover:text-foreground transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              toggleTimestampMode();
            }}
            title="Click to toggle time format"
          >
            {renderTimestamp(request.receivedAt)}
          </span>
        </div>
        {/* Bottom line: ID + content type + size */}
        <div className="flex items-center gap-2 mt-0.5 ml-[calc(3.5rem+0.5rem)]">
          <span className="text-[10px] text-muted-foreground font-mono">#{id.slice(-6)}</span>
          {ctLabel && (
            <>
              <span className="text-[10px] text-muted-foreground">&middot;</span>
              <span className="text-[10px] text-muted-foreground font-mono">{ctLabel}</span>
            </>
          )}
          {request.size > 0 && (
            <>
              <span className="text-[10px] text-muted-foreground">&middot;</span>
              <span className="text-[10px] text-muted-foreground font-mono">
                {formatBytes(request.size)}
              </span>
            </>
          )}
        </div>
      </button>
    );
  }
}
