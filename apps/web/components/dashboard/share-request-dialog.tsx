"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, EyeOff, Link2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { Segmented, SwitchRow } from "./settings-primitives";
import { trackRequestShared } from "@/lib/analytics";
import {
  createRequestShare,
  fetchRequestShares,
  revokeRequestShare,
  type RequestShareLink,
} from "@/lib/dashboard-api";
import {
  DEFAULT_SHARE_EXPIRY_DAYS,
  SHARE_EXPIRY_DAYS,
  redactHeaders,
  redactQuery,
  type ShareExpiryDays,
} from "@/lib/request-share";

interface ShareRequestDialogProps {
  requestId: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  accessToken: string;
}

function shareUrl(token: string): string {
  return `${window.location.origin}/s/${token}`;
}

function expiryLabel(days: ShareExpiryDays): string {
  return days === 1 ? "1 day" : `${days} days`;
}

function formatExpiry(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Publish the request as a read-only link, and list or revoke its live links. */
export function ShareRequestDialog({
  requestId,
  headers,
  queryParams,
  accessToken,
}: ShareRequestDialogProps) {
  const [open, setOpen] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<ShareExpiryDays>(DEFAULT_SHARE_EXPIRY_DAYS);
  const [hideSensitive, setHideSensitive] = useState(true);
  const [links, setLinks] = useState<RequestShareLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const hidden = useMemo(
    () => [
      ...redactHeaders(headers, hideSensitive).redacted,
      ...redactQuery(queryParams, hideSensitive).redacted,
    ],
    [headers, queryParams, hideSensitive]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLinks(null);
    setError(null);
    fetchRequestShares(accessToken, requestId)
      .then((result) => {
        if (!cancelled) setLinks(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLinks([]);
          setError(err instanceof Error ? err.message : "Could not load share links");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, accessToken, requestId]);

  const copy = useCallback(async (link: RequestShareLink) => {
    if (await copyToClipboard(shareUrl(link.token))) {
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((current) => (current === link.id ? null : current)), 2000);
    }
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await createRequestShare(accessToken, requestId, {
        expiresInDays,
        hideSensitive,
      });
      setLinks((current) => [link, ...(current ?? [])]);
      trackRequestShared(expiresInDays, hideSensitive);
      await copy(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the link");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: RequestShareLink) => {
    setError(null);
    try {
      await revokeRequestShare(accessToken, link.id);
      setLinks((current) => (current ?? []).filter((entry) => entry.id !== link.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5">
          <Link2 className="h-3 w-3" />
          Share
        </button>
      </DialogTrigger>
      <DialogContent className="border-strong border-line shadow-raised">
        <DialogHeader>
          <DialogTitle className="font-bold caps">Share Request</DialogTitle>
          <DialogDescription>
            A read-only link to a copy of this request, for a pull request, a ticket or a chat.
            Anyone with the link can open it, no account needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <span className="text-sm font-bold caps mb-2 block">Expires after</span>
            <Segmented
              name="Expires after"
              value={String(expiresInDays)}
              onChange={(next) => setExpiresInDays(Number(next) as ShareExpiryDays)}
              options={SHARE_EXPIRY_DAYS.map((days) => ({
                value: String(days),
                label: expiryLabel(days),
              }))}
            />
          </div>

          <SwitchRow
            id="share-hide-sensitive"
            label="Hide signatures, tokens and keys"
            help="Authorization and cookie headers are always hidden."
            checked={hideSensitive}
            onChange={setHideSensitive}
          />

          <div className="rounded-md border-strong border-line bg-muted px-3 py-2 text-xs text-muted-foreground space-y-1">
            {hidden.length > 0 ? (
              <p className="flex items-start gap-1.5">
                <EyeOff className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  Hidden: <span className="font-mono">{hidden.join(", ")}</span>
                </span>
              </p>
            ) : (
              <p>Nothing in the headers or query looks secret.</p>
            )}
            <p>
              The body is shared as it is. Check that it holds no customer data or secrets first.
            </p>
          </div>

          {error && (
            <div className="border-strong border-destructive rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button onClick={create} disabled={busy} className="w-full ui-btn-primary">
            {busy ? "Creating..." : "Create link and copy it"}
          </Button>

          <p className="text-xs text-muted-foreground">
            Every live link, including those whose request is gone, is under{" "}
            <Link href="/account/share-links" className="font-medium text-foreground underline">
              Account, Share links
            </Link>
            .
          </p>

          {links && links.length > 0 && (
            <div>
              <span className="text-sm font-bold caps mb-2 block">Live links</span>
              <ul className="space-y-2">
                {links.map((link) => (
                  <li
                    key={link.id}
                    className="flex items-center gap-2 rounded-md border-strong border-line px-2 py-1.5"
                  >
                    {/* ph-no-capture keeps the token out of session recordings. */}
                    <span className="ph-no-capture min-w-0 flex-1 truncate font-mono text-xs">
                      /s/{link.token}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      until {formatExpiry(link.expiresAt)}
                    </span>
                    <button
                      onClick={() => copy(link)}
                      className="p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                      aria-label="Copy link"
                    >
                      {copiedId === link.id ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => revoke(link)}
                      className="p-1 text-muted-foreground hover:text-destructive cursor-pointer"
                      aria-label="Revoke link"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
