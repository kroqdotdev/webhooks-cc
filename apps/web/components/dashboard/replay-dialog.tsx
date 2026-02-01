"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Play } from "lucide-react";

/** Props for the ReplayDialog component. */
interface ReplayDialogProps {
  /** HTTP method of the captured request (GET, POST, etc.) */
  method: string;
  /** Headers from the captured request. */
  headers: Record<string, string>;
  /** Request body, if present. */
  body?: string;
}

/**
 * Validates that a URL has a valid format for replaying requests.
 *
 * SECURITY NOTE: This is a client-side feature that runs entirely in the user's browser.
 * The fetch request is made from the user's browser, not from our servers. This means:
 * - There is no server-side SSRF risk
 * - The user can only access URLs their browser can reach
 * - Localhost/private IPs are intentionally allowed for local development testing
 *
 * We only validate protocol to prevent javascript: or data: URL attacks.
 */
function isValidTargetUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https protocols to prevent javascript:/data: attacks
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Only http:// and https:// URLs are allowed" };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

export function ReplayDialog({ method, headers, body }: ReplayDialogProps) {
  const [targetUrl, setTargetUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [response, setResponse] = useState<{
    status: number;
    statusText: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [open, setOpen] = useState(false);

  const handleReplay = async () => {
    if (!targetUrl) return;

    const validation = isValidTargetUrl(targetUrl);
    if (!validation.valid) {
      setErrorMsg(validation.error || "Invalid URL");
      setStatus("error");
      return;
    }
    setStatus("sending");
    setResponse(null);
    setErrorMsg("");

    try {
      const skipHeaders = ["host", "content-length", "connection", "accept-encoding"];
      const filteredHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (!skipHeaders.includes(key.toLowerCase())) {
          filteredHeaders[key] = value;
        }
      }

      const res = await fetch(targetUrl, {
        method,
        headers: filteredHeaders,
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
      });
      setResponse({ status: res.status, statusText: res.statusText });
      setStatus("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Request failed");
      setStatus("error");
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setStatus("idle");
      setResponse(null);
      setErrorMsg("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button className="neo-btn-outline !py-1.5 !px-3 text-xs flex items-center gap-1.5">
          <Play className="h-3 w-3" />
          Replay
        </button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground shadow-neo">
        <DialogHeader>
          <DialogTitle className="font-bold uppercase tracking-wide">Replay Request</DialogTitle>
          <DialogDescription>
            Send this captured request to another URL. Requests are made from your browser, so
            localhost URLs work for local development testing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="replay-url"
              className="text-sm font-bold uppercase tracking-wide mb-2 block"
            >
              Target URL
            </label>
            <input
              id="replay-url"
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="http://localhost:3000/webhook"
              className="neo-input w-full text-sm"
            />
          </div>

          <div className="text-xs font-mono text-muted-foreground">
            {method} with {Object.keys(headers).length} headers
            {body ? `, ${body.length} byte body` : ", no body"}
          </div>

          {status === "done" && response && (
            <div className="neo-code !p-3">
              <span className="font-bold">{response.status}</span> {response.statusText}
            </div>
          )}

          {status === "error" && (
            <div className="border-2 border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {errorMsg}
            </div>
          )}

          <Button
            onClick={handleReplay}
            disabled={!targetUrl || status === "sending"}
            className="w-full neo-btn-primary !rounded-none"
          >
            {status === "sending" ? "Sending..." : "Send Request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
