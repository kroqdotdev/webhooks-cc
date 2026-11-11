"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  liveResponseBytes,
  liveResponseSummary,
  liveResponseText,
  type LiveResponse,
} from "@/lib/live-response";
import { formatBytes } from "@/types/request";

/**
 * The Response tab of a live capture (`whk tunnel --live`): what the app
 * behind the tunnel answered the sender, or why the sender got an error
 * instead. The body is the first 64 KB, as recorded.
 */
export function LiveResponseView({ response }: { response: LiveResponse }) {
  const text = useMemo(() => liveResponseText(response), [response]);
  const headers = Object.entries(response.headers);
  const failed = response.outcome !== "answered";
  return (
    <div className="space-y-4" data-testid="live-response">
      <p
        className={cn(
          "text-sm font-medium",
          failed || (response.status ?? 0) >= 500
            ? "text-destructive-ink"
            : (response.status ?? 0) >= 400
              ? "text-amber-700 dark:text-amber-400"
              : "text-foreground"
        )}
      >
        {liveResponseSummary(response)}
      </p>
      {failed ? (
        <p className="text-sm text-muted-foreground max-w-[62ch]">
          The request was captured all the same, and most senders retry an error later.
        </p>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-[11px] font-mono font-bold caps text-muted-foreground">
              Headers <span className="font-normal">{headers.length}</span>
            </h3>
            {headers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No headers.</p>
            ) : (
              <div className="ui-code overflow-x-auto p-3">
                <table className="ph-no-capture w-full font-mono text-xs">
                  <tbody>
                    {headers.map(([name, value]) => (
                      <tr key={name} className="align-top">
                        <td className="whitespace-nowrap py-0.5 pr-4 font-semibold">{name}</td>
                        <td className="break-all py-0.5">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="space-y-2">
            <h3 className="text-[11px] font-mono font-bold caps text-muted-foreground">Body</h3>
            {response.body === "" ? (
              <p className="text-sm text-muted-foreground">(empty body)</p>
            ) : text === null ? (
              <p className="text-sm text-muted-foreground">
                {formatBytes(liveResponseBytes(response))} of binary data.
              </p>
            ) : (
              <pre className="ph-no-capture ui-code overflow-x-auto whitespace-pre-wrap break-all text-sm">
                {text}
              </pre>
            )}
            {response.bodyTruncated && (
              <p className="text-xs text-muted-foreground">
                Only the first 64 KB is kept; the sender got the whole body.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
