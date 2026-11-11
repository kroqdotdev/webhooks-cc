"use client";

import { useEffect, useState } from "react";
import { InlineMessage, Panel } from "@/components/settings/panel";
import { formatBytes } from "@/types/request";
import { shareRequests, type ApiShare, type SeenRequest } from "@/lib/shares-api";
import { cn } from "@/lib/utils";

const POLL_MS = 4_000;

/** "18:04:12": times in the log, in the viewer's zone. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusTone(status: number): string {
  if (status >= 500) return "text-destructive-ink";
  if (status >= 400) return "text-amber-700 dark:text-amber-400";
  return "text-foreground";
}

/**
 * The last requests visitors made to a live preview, from the edge's memory,
 * read again every 4 seconds while the page is on screen. Nothing here
 * outlives an edge restart, and visitors are numbers, never addresses.
 */
export function RequestLog({
  accessToken,
  share,
  onClose,
}: {
  accessToken: string;
  share: ApiShare;
  onClose: () => void;
}) {
  const [requests, setRequests] = useState<SeenRequest[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const result = await shareRequests(accessToken, share.id);
          if (stopped) return;
          setRequests(result.requests);
          setAvailable(result.available);
          setError(null);
        } catch (err) {
          if (!stopped) setError(err instanceof Error ? err.message : "Could not load requests.");
        }
      }
      if (!stopped) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, share.id]);

  return (
    <Panel
      id="share-requests"
      flush
      title={
        <>
          Requests to <span className="ph-no-capture font-mono">{share.name}</span>
        </>
      }
      description="The latest 50, newest first. They update while this page is open."
      actions={
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Close
        </button>
      }
    >
      {error && (
        <div className="px-5 py-3">
          <InlineMessage tone="error">{error}</InlineMessage>
        </div>
      )}
      {requests === null ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Loading...</p>
      ) : !available ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          The request log is not reachable right now. The preview itself is not affected.
        </p>
      ) : requests.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No visitors yet. Open the link to see requests arrive here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="ph-no-capture w-full text-xs">
            <caption className="sr-only">Recent requests to this preview</caption>
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-medium">
                  Time
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Request
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Size
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Time taken
                </th>
                <th scope="col" className="px-5 py-2 font-medium">
                  Visitor
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r, index) => (
                <tr key={`${r.at}-${index}`} className="border-b border-border/40 last:border-b-0">
                  <td className="whitespace-nowrap px-5 py-1.5 font-mono text-muted-foreground">
                    {clock(r.at)}
                  </td>
                  <td className="max-w-[24rem] truncate px-2 py-1.5 font-mono" title={r.path}>
                    <span className="font-semibold">{r.method}</span> {r.path}
                  </td>
                  <td className={cn("px-2 py-1.5 font-mono", statusTone(r.status))}>{r.status}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">
                    {formatBytes(r.bytes)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">{r.ms} ms</td>
                  <td className="whitespace-nowrap px-5 py-1.5 text-muted-foreground">
                    {[r.visitor !== null ? `#${r.visitor}` : null, r.country, r.device]
                      .filter(Boolean)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
