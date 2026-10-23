"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, Trash2 } from "lucide-react";
import { InlineMessage, Panel } from "@/components/settings/panel";
import { shortDate } from "@/components/settings/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import { revokeRequestShare } from "@/lib/dashboard-api";

interface ShareLink {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  method: string;
  path: string;
  detectedProvider: string | null;
  detectedEvent: string | null;
  requestId: string | null;
  endpointSlug: string | null;
}

/**
 * Every live share link of the account, with copy and revoke. The request
 * dialog lists only one request's links, and a link outlives its request.
 */
export function ShareLinks({ accessToken }: { accessToken: string | null }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const response = await fetch("/api/request-shares", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        setLinks((await response.json()) as ShareLink[]);
        setError(null);
      } else {
        setError("Your share links could not be loaded.");
      }
    } catch {
      setError("Your share links could not be loaded.");
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async (link: ShareLink) => {
    if (await copyToClipboard(`${window.location.origin}/s/${link.token}`)) {
      setCopied(link.id);
      setTimeout(() => setCopied((current) => (current === link.id ? null : current)), 2000);
    }
  };

  const revoke = async (link: ShareLink) => {
    if (!accessToken) return;
    setRevoking(link.id);
    setError(null);
    try {
      await revokeRequestShare(accessToken, link.id);
      setLinks((previous) => previous?.filter((entry) => entry.id !== link.id) ?? previous);
    } catch {
      setError("The link is still live. Try again.");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Panel id="share-links" flush testId="share-links">
      {links === null ? (
        error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading share links" className="space-y-3 p-5">
            <Skeleton className="h-4 w-1/2 rounded-md" />
            <Skeleton className="h-4 w-1/3 rounded-md" />
          </div>
        )
      ) : links.length === 0 ? (
        <div className="space-y-1 p-5">
          <p className="text-sm font-medium">No live share links.</p>
          <p className="text-sm text-muted-foreground">
            Share a request from the dashboard with the Share button above it.
          </p>
        </div>
      ) : (
        <ul>
          {links.map((link) => {
            const provider = link.detectedProvider
              ? (getWebProviderInfo(link.detectedProvider)?.label ?? link.detectedProvider)
              : null;
            const title = link.detectedEvent
              ? [provider, link.detectedEvent].filter(Boolean).join(" ")
              : `${link.method} ${link.path}`;
            return (
              <li
                key={link.id}
                className="flex items-center justify-between gap-4 border-b border-line/60 px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {/* ph-no-capture keeps the token out of session recordings. */}
                    <Link href={`/s/${link.token}`} className="ph-no-capture hover:underline">
                      {title}
                    </Link>
                  </p>
                  <dl className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    {link.endpointSlug && (
                      <div className="flex gap-1">
                        <dt>Endpoint</dt>
                        <dd className="font-mono text-foreground">{link.endpointSlug}</dd>
                      </div>
                    )}
                    <div className="flex gap-1">
                      <dt>Shared</dt>
                      <dd className="text-foreground">{shortDate(link.createdAt)}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>Expires</dt>
                      <dd className="text-foreground">{shortDate(link.expiresAt)}</dd>
                    </div>
                    {link.requestId === null && <div>Request deleted</div>}
                  </dl>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void copy(link)}
                    title="Copy link"
                    aria-label={`Copy link to ${title}`}
                  >
                    {copied === link.id ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={revoking === link.id}
                    onClick={() => void revoke(link)}
                    title="Revoke link"
                    aria-label={`Revoke link to ${title}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && links !== null && (
        <div className="border-t-strong border-line px-5 py-3">
          <InlineMessage tone="error">{error}</InlineMessage>
        </div>
      )}
    </Panel>
  );
}
