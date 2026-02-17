import { Id } from "@convex/_generated/dataModel";

export interface Request {
  _id: Id<"requests">;
  _creationTime: number;
  endpointId: Id<"endpoints">;
  method: HttpMethod | string; // HttpMethod for known methods, string for custom methods
  path: string;
  headers: Record<string, string>;
  body?: string;
  queryParams: Record<string, string>;
  contentType?: string;
  ip: string;
  size: number;
  receivedAt: number;
}

export interface RequestSummary {
  _id: Id<"requests">;
  _creationTime: number;
  method: HttpMethod | string;
  receivedAt: number;
}

/** A request from ClickHouse search/pagination (no Convex _id). */
export interface ClickHouseRequest {
  id: string;
  slug: string;
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

/** Summary shape for ClickHouse results displayed in the sidebar list. */
export interface ClickHouseSummary {
  id: string;
  method: string;
  receivedAt: number;
}

/** Union type for items in the request list (Convex or ClickHouse). */
export type AnyRequestSummary = RequestSummary | ClickHouseSummary;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

const METHOD_COLORS_MAP: Record<HttpMethod, string> = {
  GET: "bg-primary text-primary-foreground",
  POST: "bg-secondary text-secondary-foreground",
  PUT: "bg-accent text-accent-foreground",
  DELETE: "bg-destructive text-destructive-foreground",
  PATCH: "bg-accent text-accent-foreground",
  HEAD: "bg-muted text-muted-foreground",
  OPTIONS: "bg-muted text-muted-foreground",
};

const DEFAULT_METHOD_COLOR = "bg-muted text-muted-foreground";

/**
 * Gets the CSS color classes for an HTTP method.
 * Returns a default muted style for unknown methods.
 */
export function getMethodColor(method: string): string {
  return METHOD_COLORS_MAP[method as HttpMethod] ?? DEFAULT_METHOD_COLOR;
}

// Export for backwards compatibility, but prefer getMethodColor()
export const METHOD_COLORS: Record<string, string> = {
  ...METHOD_COLORS_MAP,
};

export function formatRelativeTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // Same day: show time only. Different day: show date + time.
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return time;
  }
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
}

/**
 * Formats bytes into human-readable string (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
