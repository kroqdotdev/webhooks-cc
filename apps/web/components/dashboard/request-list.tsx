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
  Paperclip,
  Check,
  Copy,
  Clock,
} from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSite } from "@/components/providers/site-provider";
import { SignatureVerificationBadge } from "./signature-tab";
import { ProviderBadge } from "./provider-badge";
import {
  getMethodColor,
  formatTimestamp,
  formatRelativeTimestamp,
  formatBytes,
  getContentTypeLabel,
  isEmailItem,
} from "@/types/request";
import type { AnyRequestSummary, KindFilter } from "@/types/request";
import type { ParsedEmail } from "@webhooks-cc/sdk/email";
import { ResponseAnswerCompact } from "./response-answer";
import { Button } from "@/components/ui/button";

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
  /** Set for endpoints that receive email: shows the All / HTTP / Email switch. */
  kindFilter?: KindFilter;
  onKindFilterChange?: (kind: KindFilter) => void;
  /** The endpoint's address, shown when no email has arrived yet. */
  emailAddress?: string | null;
  /** What the layouts made of each email, by id (the rows carry no parse). */
  parsedById?: Map<string, ParsedEmail | null>;
  /** Each HTTP request's query string ("?a=b"), by id, when it has one (the rows carry none). */
  queryById?: Map<string, string>;
  /** The endpoint has layouts: an email without a result says so. */
  layoutsActive?: boolean;
  /** The time the page last looked at parses, for "reading..." (see PARSE_FRESH_MS). */
  parseNow?: number;
  /**
   * When this page saw the layouts saved, if it did: email from before that
   * was never queued for a layout, so it is not "reading...".
   */
  parseSince?: number | null;
}

/** An email that arrived this recently with no result may still be read by a layout. */
const PARSE_FRESH_MS = 2 * 60 * 1000;

const KINDS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "http", label: "HTTP" },
  { id: "email", label: "Email" },
];
/** mailhooks.cc leads with email, like its endpoint bar. */
const MAIL_KINDS: { id: KindFilter; label: string }[] = [KINDS[0], KINDS[2], KINDS[1]];

const METHODS = ["ALL", "GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const METHOD_LABELS: Record<(typeof METHODS)[number], string> = {
  ALL: "All methods",
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
};

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
  kindFilter = "all",
  onKindFilterChange,
  emailAddress,
  parsedById,
  queryById,
  layoutsActive = false,
  parseNow,
  parseSince = null,
}: RequestListProps) {
  // The mail site, or a list filtered to email, talks about emails.
  const site = useSite();
  const talksEmail = site.key === "mailhooks" || kindFilter === "email";
  const itemNoun = talksEmail ? "emails" : "requests";
  // A list of only emails (the Email filter, or a mail inbox holding nothing else)
  // drops the per-row EMAIL badge and the indent made for it.
  const onlyEmail =
    kindFilter === "email" || (site.key === "mailhooks" && requests.every(isEmailItem));
  const displayCount = totalCount ?? requests.length;
  const kinds = site.key === "mailhooks" ? MAIL_KINDS : KINDS;
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
    const menuH = 160;
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

  // The rows are one listbox: one tab stop (the selected row, else the first),
  // arrow keys, Home and End move the selection and focus with it.
  const listboxRef = useRef<HTMLDivElement>(null);
  const orderedIds = useMemo(() => [...pinned, ...unpinned].map(getItemId), [pinned, unpinned]);
  const tabStopId =
    selectedId && orderedIds.includes(selectedId) ? selectedId : (orderedIds[0] ?? null);

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, id: string) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (e.shiftKey && onCompareSelect) onCompareSelect(id);
        else onSelect(id);
        return;
      }
      const index = orderedIds.indexOf(id);
      let nextIndex: number;
      switch (e.key) {
        case "ArrowDown":
          nextIndex = Math.min(index + 1, orderedIds.length - 1);
          break;
        case "ArrowUp":
          nextIndex = Math.max(index - 1, 0);
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = orderedIds.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const nextId = orderedIds[nextIndex];
      if (!nextId) return;
      if (nextId !== id) onSelect(nextId);
      listboxRef.current
        ?.querySelector<HTMLElement>(`[role="option"][data-request-id="${CSS.escape(nextId)}"]`)
        ?.focus();
    },
    [orderedIds, onSelect, onCompareSelect]
  );

  const rowClass = (id: string, isComparing: boolean) =>
    cn(
      "w-full px-3 py-2 text-left cursor-pointer transition-colors border-b border-foreground/10",
      // The ring sits inside the row, so the scrolling list never clips it.
      "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:-outline-offset-2",
      isComparing
        ? "bg-amber-100 dark:bg-amber-900/30 border-l-4 border-l-amber-500"
        : selectedId === id
          ? "bg-muted border-l-4 border-l-primary"
          : "hover:bg-muted/50 border-l-4 border-l-transparent"
    );

  const rowProps = (id: string, isComparing: boolean) => ({
    role: "option" as const,
    "aria-selected": selectedId === id,
    tabIndex: tabStopId === id ? 0 : -1,
    "data-request-id": id,
    onClick: (e: React.MouseEvent) => handleRowClick(e, id),
    onContextMenu: (e: React.MouseEvent) => handleContextMenu(e, id),
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => handleRowKeyDown(e, id),
    className: rowClass(id, isComparing),
  });

  const loadMore = hasMore ? (
    <div className="px-3 py-3 flex justify-center border-t border-foreground/10">
      <Button
        variant="outlined"
        className={cn(
          "py-1.5! px-4! text-xs flex items-center gap-2",
          loadingMore && "opacity-60 cursor-not-allowed"
        )}
        onClick={onLoadMore}
        disabled={loadingMore}
      >
        {loadingMore ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading...
          </>
        ) : (
          "Load More"
        )}
      </Button>
    </div>
  ) : null;

  return (
    <div className="ph-no-capture flex flex-col h-full">
      {/* Toolbar */}
      <div className="@container border-b px-3 py-2 flex items-center justify-between gap-2 shrink-0">
        {onKindFilterChange ? (
          <div
            role="radiogroup"
            aria-label="Show"
            className="flex min-w-0 overflow-hidden rounded-md border"
          >
            {kinds.map((kind, index) => (
              <button
                key={kind.id}
                type="button"
                role="radio"
                aria-checked={kindFilter === kind.id}
                // The count is read as part of the name, not run into it ("Email1").
                aria-label={
                  kindFilter === kind.id ? `${kind.label}, ${displayCount} shown` : kind.label
                }
                // One tab stop for the group; arrow keys move the choice, as in a radio group.
                tabIndex={kindFilter === kind.id ? 0 : -1}
                onClick={() => onKindFilterChange(kind.id)}
                onKeyDown={(event) => {
                  const step =
                    event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowLeft" || event.key === "ArrowUp"
                        ? -1
                        : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = kinds[(index + step + kinds.length) % kinds.length];
                  onKindFilterChange(next.id);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>("[role=radio]")
                    [(index + step + kinds.length) % kinds.length]?.focus();
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 max-md:py-2 text-xs font-bold cursor-pointer transition-colors whitespace-nowrap",
                  index > 0 && "border-l border-border",
                  kindFilter === kind.id
                    ? "bg-selected text-selected-foreground"
                    : "bg-background hover:bg-muted"
                )}
              >
                {kind.label}
                {/* The count of what is shown, from the server, so only the picked kind has one. */}
                {kindFilter === kind.id && (
                  <span
                    aria-hidden
                    className="hidden @[300px]:inline font-mono font-normal opacity-90"
                  >
                    {displayCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-sm font-bold">
            {displayCount} request{displayCount !== 1 ? "s" : ""}
          </span>
        )}
        <div className="flex items-center gap-2 shrink-0">
          {onViewModeChange && (
            <button
              onClick={() => onViewModeChange(viewMode === "list" ? "timeline" : "list")}
              className="p-1.5 max-md:p-2.5 hover:bg-muted transition-colors cursor-pointer rounded-md border"
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
            className="p-1.5 max-md:p-2.5 hover:bg-muted transition-colors cursor-pointer rounded-md border"
            title={sortNewest ? "Showing newest first" : "Showing oldest first"}
            aria-label={
              sortNewest
                ? "Newest first. Switch to oldest first"
                : "Oldest first. Switch to newest first"
            }
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onToggleLiveMode}
            aria-pressed={liveMode}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 max-md:py-2 text-xs font-bold rounded-md border cursor-pointer transition-colors",
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
      <div className="border-b px-3 py-2 flex items-center gap-2 shrink-0">
        {kindFilter !== "email" && (
          <Select value={methodFilter} onValueChange={onMethodFilterChange}>
            <SelectTrigger
              aria-label="Method"
              className="h-auto w-auto shrink-0 gap-1.5 text-xs font-bold rounded-md border border-border bg-background px-2 py-1 max-md:py-2 cursor-pointer focus:ring-offset-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m} className="text-xs font-bold">
                  {METHOD_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ui-control flex-1 flex items-center gap-1 rounded-md border px-2 py-1 bg-background focus-within:ring-2 focus-within:ring-ring">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            aria-label="Search requests"
            placeholder={onKindFilterChange ? "Search" : "Search..."}
            className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground font-mono min-w-0"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchQueryChange("")}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* New requests banner */}
      {/* Screen readers hear the count change as requests arrive. */}
      <p role="status" aria-live="polite" className="sr-only">
        {displayCount} {displayCount === 1 ? itemNoun.slice(0, -1) : itemNoun}
      </p>
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
        <div className="bg-amber-100 dark:bg-amber-900/30 text-xs font-bold text-center py-1 shrink-0 border-b">
          Shift-click another request to compare
        </div>
      )}

      {/* Request rows */}
      <div className="flex-1 overflow-y-auto">
        {viewMode === "timeline" && timelineSlot ? (
          <>
            {timelineSlot}
            {/* The timeline pages like the list, so older matches stay reachable. */}
            {loadMore}
          </>
        ) : searchLoading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground font-bold flex items-center justify-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Searching...
          </div>
        ) : pinned.length === 0 &&
          unpinned.length === 0 &&
          talksEmail &&
          emailAddress &&
          kindFilter !== "http" &&
          !searchQuery &&
          methodFilter === "ALL" &&
          !hasMore &&
          !searchError ? (
          // Nothing filtered away: no email has arrived yet.
          <NoEmailsYet address={emailAddress} />
        ) : pinned.length === 0 && unpinned.length === 0 ? (
          <>
            <div className="px-3 py-6 text-center text-xs text-muted-foreground font-bold">
              {searchError
                ? "Search unavailable"
                : hasMore
                  ? `None in the newest ${itemNoun}`
                  : searchQuery
                    ? // The detail pane explains an empty search and offers to clear it.
                      "0 results"
                    : `No matching ${itemNoun}`}
            </div>
            {/* A filter can match nothing loaded so far and still match older pages. */}
            {loadMore}
          </>
        ) : (
          <>
            <div
              ref={listboxRef}
              role="listbox"
              aria-label={kindFilter === "email" ? "Emails" : "Requests"}
            >
              {pinned.length > 0 ? (
                <>
                  <div role="group" aria-label="Pinned">
                    <div
                      aria-hidden="true"
                      className="px-3 py-1 text-xs font-bold text-muted-foreground bg-muted/50 border-b border-foreground/10 flex items-center gap-1"
                    >
                      <Star className="h-2.5 w-2.5 fill-current" />
                      Pinned
                    </div>
                    {pinned.map((request) => renderRow(request))}
                  </div>
                  {unpinned.length > 0 && (
                    <div role="group" aria-label={`All ${itemNoun}`}>
                      <div
                        aria-hidden="true"
                        className="px-3 py-1 text-xs font-bold text-muted-foreground bg-muted/50 border-b border-foreground/10 border-t border-t-foreground/10"
                      >
                        All {itemNoun}
                      </div>
                      {unpinned.map((request) => renderRow(request))}
                    </div>
                  )}
                </>
              ) : (
                unpinned.map((request) => renderRow(request))
              )}
            </div>

            {loadMore}
          </>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed z-50 overflow-hidden rounded-lg border bg-background shadow-float min-w-[160px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {onTogglePin && (
            <button
              onClick={() => {
                onTogglePin(ctxMenu.id);
                setCtxMenu(null);
              }}
              className="w-full px-3 py-2 text-left text-xs font-bold hover:bg-muted cursor-pointer transition-colors border-b flex items-center gap-2"
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
              className="w-full px-3 py-2 text-left text-xs font-bold hover:bg-muted cursor-pointer transition-colors border-b flex items-center gap-2"
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
            className="w-full px-3 py-2 text-left text-xs font-bold hover:bg-muted cursor-pointer transition-colors border-b flex items-center gap-2"
          >
            <Clipboard className="h-3 w-3" />
            Copy ID
          </button>
          <button
            onClick={() => {
              toggleTimestampMode();
              setCtxMenu(null);
            }}
            className="w-full px-3 py-2 text-left text-xs font-bold hover:bg-muted cursor-pointer transition-colors flex items-center gap-2"
          >
            <Clock className="h-3 w-3" />
            {relativeTime ? "Show clock times" : "Show relative times"}
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
    if (isEmailItem(request)) return renderEmailRow(request, id, isPinned, hasNote, isComparing);
    return (
      <div key={id} {...rowProps(id, isComparing)}>
        {/* Top line: method + path + icons + timestamp */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "px-1.5 py-0.5 text-xs font-mono font-bold rounded-sm border shrink-0 min-w-15 text-center border-transparent",
              getMethodColor(request.method)
            )}
          >
            {request.method}
          </span>
          {request.detectedProvider && <ProviderBadge provider={request.detectedProvider} />}
          {request.signatureVerified != null && (
            <SignatureVerificationBadge
              signatureVerified={request.signatureVerified}
              signatureError={request.signatureError}
              signingProvider={request.signingProvider}
            />
          )}
          <span className="text-xs font-mono flex-1 min-w-0 flex">
            <span className="truncate shrink-0 max-w-full">{request.path}</span>
            {queryById?.get(id) && (
              <span className="truncate min-w-0 text-muted-foreground">{queryById.get(id)}</span>
            )}
          </span>
          {isPinned && <Star className="h-2.5 w-2.5 text-amber-500 fill-amber-500 shrink-0" />}
          {hasNote && <StickyNote className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {renderTimestamp(request.receivedAt)}
          </span>
        </div>
        {/* Bottom line: ID + content type + size */}
        <div className="flex items-center gap-2 mt-0.5 ml-[calc(3.75rem+0.5rem)]">
          <span className="text-xs text-muted-foreground font-mono">#{id.slice(-6)}</span>
          {ctLabel && (
            <>
              <span className="text-xs text-muted-foreground">&middot;</span>
              <span className="text-xs text-muted-foreground font-mono">{ctLabel}</span>
            </>
          )}
          {request.detectedEvent && (
            <>
              <span className="text-xs text-muted-foreground">&middot;</span>
              <span className="text-xs text-muted-foreground font-mono truncate">
                {request.detectedEvent}
              </span>
            </>
          )}
          {request.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">&middot;</span>
              <span className="text-xs text-muted-foreground font-mono shrink-0 whitespace-nowrap">
                {formatBytes(request.size)}
              </span>
            </>
          )}
          {request.responseStatus != null && (
            <>
              <span className="text-xs text-muted-foreground" aria-hidden>
                &middot;
              </span>
              <ResponseAnswerCompact
                request={request}
                className="text-xs text-muted-foreground font-mono"
              />
            </>
          )}
        </div>
      </div>
    );
  }

  /** Emails lead with what a person wrote: the subject, then who sent it. */
  function renderEmailRow(
    request: AnyRequestSummary,
    id: string,
    isPinned: boolean | undefined,
    hasNote: boolean | undefined,
    isComparing: boolean
  ) {
    const email = request.email;
    const sender = email?.from?.name || email?.from?.address || null;
    const parse = parseStatus(id, request.receivedAt);
    return (
      <div key={id} {...rowProps(id, isComparing)}>
        <div className="flex items-center gap-2">
          {/* A list of only emails needs no badge saying so on every row. */}
          {!onlyEmail && (
            <span
              className={cn(
                "px-1.5 py-0.5 text-xs font-mono font-bold rounded-sm border shrink-0 min-w-15 text-center border-transparent",
                getMethodColor("EMAIL")
              )}
            >
              EMAIL
            </span>
          )}
          <span
            className={cn(
              "text-[13px] truncate flex-1",
              !email?.subject && "text-muted-foreground"
            )}
          >
            {email?.subject || "(no subject)"}
          </span>
          {isPinned && <Star className="h-2.5 w-2.5 text-amber-500 fill-amber-500 shrink-0" />}
          {hasNote && <StickyNote className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {renderTimestamp(request.receivedAt)}
          </span>
        </div>
        <div
          className={cn(
            "flex items-center gap-2 mt-0.5 min-w-0",
            !onlyEmail && "ml-[calc(3.75rem+0.5rem)]"
          )}
        >
          {sender && <span className="text-xs text-muted-foreground truncate">{sender}</span>}
          {email?.tag && (
            <span className="text-xs font-mono font-semibold text-kind-email truncate max-w-[40%]">
              +{email.tag}
            </span>
          )}
          {(email?.attachmentCount ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground font-mono flex items-center gap-0.5 shrink-0">
              <Paperclip className="h-2.5 w-2.5" />
              {email!.attachmentCount}
            </span>
          )}
          {request.size > 0 && (
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {formatBytes(request.size)}
            </span>
          )}
          <span className="text-xs text-muted-foreground font-mono shrink-0">#{id.slice(-6)}</span>
          {parse && (
            <span
              className={cn(
                "text-xs truncate min-w-0",
                parse.kind === "read" ? "text-primary" : "text-muted-foreground"
              )}
            >
              &middot;{" "}
              {parse.kind === "read"
                ? parse.layout
                : parse.kind === "none"
                  ? "no layout"
                  : "reading..."}
            </span>
          )}
        </div>
      </div>
    );
  }

  /** How the layouts read an email, for its row: null when there is nothing to say. */
  function parseStatus(
    id: string,
    receivedAt: number
  ): { kind: "read"; layout: string } | { kind: "none" } | { kind: "pending" } | null {
    const parsed = parsedById?.get(id);
    if (parsed?.status === "matched")
      return { kind: "read", layout: parsed.layout?.name ?? "layout" };
    if (!layoutsActive || parsed === undefined) return null;
    if (
      parsed === null &&
      parseNow !== undefined &&
      parseNow - receivedAt < PARSE_FRESH_MS &&
      (parseSince === null || receivedAt >= parseSince)
    ) {
      return { kind: "pending" };
    }
    return { kind: "none" };
  }
}

/** The list's empty state while an endpoint has no email: where to send some. */
function NoEmailsYet({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    if (!(await copyToClipboard(address))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="px-4 py-8 text-center space-y-3">
      <p className="text-sm font-semibold">No emails yet.</p>
      <div className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background pl-2.5 pr-1 py-1">
        <span className="font-mono text-xs truncate">{address}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy email address"
          className="shrink-0 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground max-w-[32ch] mx-auto">
        Forward a mailbox here or give this address to the sender.
      </p>
    </div>
  );
}
