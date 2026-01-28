"use client";

import { cn } from "@/lib/utils";
import { Circle, ArrowUpDown } from "lucide-react";

interface Request {
  _id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  queryParams: Record<string, string>;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
}

interface RequestListProps {
  requests: Request[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  liveMode: boolean;
  onToggleLiveMode: () => void;
  sortNewest: boolean;
  onToggleSort: () => void;
  newCount?: number;
  onJumpToNew?: () => void;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-primary text-primary-foreground",
  POST: "bg-secondary text-secondary-foreground",
  PUT: "bg-accent text-accent-foreground",
  DELETE: "bg-destructive text-destructive-foreground",
  PATCH: "bg-accent text-accent-foreground",
  HEAD: "bg-muted text-muted-foreground",
  OPTIONS: "bg-muted text-muted-foreground",
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

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
}: RequestListProps) {
  const sorted = sortNewest ? requests : [...requests].reverse();

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b-2 border-foreground px-3 py-2 flex items-center justify-between shrink-0">
        <span className="text-sm font-bold">
          {requests.length} request{requests.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
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
              liveMode
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-muted"
            )}
            title={liveMode ? "Live mode: auto-selects new requests" : "Review mode: new requests won't interrupt"}
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

      {/* New requests banner */}
      {!liveMode && newCount && newCount > 0 && onJumpToNew && (
        <button
          onClick={onJumpToNew}
          className="bg-primary text-primary-foreground text-xs font-bold text-center py-1.5 cursor-pointer hover:bg-primary/90 transition-colors shrink-0"
        >
          {newCount} new request{newCount !== 1 ? "s" : ""}
        </button>
      )}

      {/* Request rows */}
      <div className="flex-1 overflow-y-auto">
        {sorted.map((request) => (
          <button
            key={request._id}
            onClick={() => onSelect(request._id)}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer transition-colors border-b border-foreground/10",
              selectedId === request._id
                ? "bg-muted border-l-4 border-l-primary"
                : "hover:bg-muted/50 border-l-4 border-l-transparent"
            )}
          >
            <span
              className={cn(
                "px-1.5 py-0.5 text-[10px] font-mono font-bold border-2 border-foreground shrink-0 w-14 text-center",
                METHOD_COLORS[request.method] || "bg-muted"
              )}
            >
              {request.method}
            </span>
            <span className="text-xs text-muted-foreground font-mono truncate flex-1">
              #{request._id.slice(-6)}
            </span>
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {formatRelativeTime(request.receivedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
