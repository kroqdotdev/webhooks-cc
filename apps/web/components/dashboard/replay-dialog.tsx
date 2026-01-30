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

interface ReplayDialogProps {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Validates that a URL is safe to send requests to.
 * Blocks internal IPs, localhost, and cloud metadata endpoints to prevent SSRF.
 */
function isValidTargetUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https protocols
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Only http:// and https:// URLs are allowed" };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost variants (including subdomains containing localhost)
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost") ||
      hostname.includes("localhost.")
    ) {
      return { valid: false, error: "localhost URLs are not allowed" };
    }

    // Block cloud metadata endpoints (AWS, GCP, Azure, and others)
    if (
      hostname === "169.254.169.254" ||
      hostname === "metadata.google.internal" ||
      hostname === "metadata.internal" ||
      hostname === "100.100.100.200" // Alibaba Cloud
    ) {
      return { valid: false, error: "Cloud metadata endpoints are not allowed" };
    }

    // Block IPv6 private/local addresses
    // Link-local (fe80::), unique local (fc00::/7), loopback (::1)
    const ipv6Hostname = hostname.replace(/^\[|\]$/g, ""); // Remove brackets if present
    if (
      ipv6Hostname.startsWith("fe80:") ||
      ipv6Hostname.startsWith("fc") ||
      ipv6Hostname.startsWith("fd") ||
      ipv6Hostname === "::1"
    ) {
      return { valid: false, error: "Private IPv6 addresses are not allowed" };
    }

    // Block IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) to prevent SSRF bypass
    if (ipv6Hostname.toLowerCase().startsWith("::ffff:")) {
      return { valid: false, error: "IPv4-mapped IPv6 addresses are not allowed" };
    }

    // Block private IP ranges (IPv4)
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      // 10.0.0.0/8
      if (a === 10) {
        return { valid: false, error: "Private IP addresses are not allowed" };
      }
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) {
        return { valid: false, error: "Private IP addresses are not allowed" };
      }
      // 192.168.0.0/16
      if (a === 192 && b === 168) {
        return { valid: false, error: "Private IP addresses are not allowed" };
      }
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) {
        return { valid: false, error: "Link-local addresses are not allowed" };
      }
      // 127.0.0.0/8 (loopback)
      if (a === 127) {
        return { valid: false, error: "Loopback addresses are not allowed" };
      }
      // 0.0.0.0/8
      if (a === 0) {
        return { valid: false, error: "Invalid IP address" };
      }
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
          <DialogDescription>Send this captured request to another URL.</DialogDescription>
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
