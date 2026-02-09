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

/**
 * Formats bytes into human-readable string (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
