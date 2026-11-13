"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, Check, Copy, ExternalLink, Lock, Square } from "lucide-react";
import {
  InlineMessage,
  Notice,
  Panel,
  PanelRow,
  SettingsPageSkeleton,
  StatusTag,
  settingsLink,
} from "@/components/settings/panel";
import { longDate, shortDate } from "@/lib/dates";
import { useSettingsData } from "@/components/settings/settings-data";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCopyWithFeedback } from "@/hooks/use-copy-with-feedback";
import {
  durationText,
  listNames,
  listShares,
  SharesApiError,
  splitShares,
  stopShare,
  usagePercent,
  type ApiShare,
  type NamesListing,
  type SharesListing,
} from "@/lib/shares-api";
import {
  dataText,
  reservedNamesText,
  sessionText,
  sharesAtOnceText,
} from "@/lib/tunnels/plan-text";
import { formatBytes } from "@/types/request";
import { cn } from "@/lib/utils";
import { CommandBlock } from "./command-block";
import { NamesPanel } from "./names-panel";
import { QrDialog } from "./qr-dialog";
import { RequestLog } from "./request-log";
import { Meter } from "@/components/ui/meter";

const REFRESH_MS = 10_000;
const INSTALL = "curl -fsSL https://webhooks.cc/install.sh | sh";

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  team: "Teams",
  team_business: "Team Business",
};

type Loaded =
  | { state: "loading" }
  | { state: "off" }
  | { state: "error"; message: string }
  | { state: "ready"; shares: SharesListing; names: NamesListing };

/**
 * The Shares page: previews of localhost opened with `whk share` (and live
 * sessions of `whk tunnel --live`), the names kept for them, this month's
 * data and the plan's limits. Live shares are read again every 10 seconds
 * while the page is on screen.
 */
export function SharesPage({ accessToken }: { accessToken: string | null }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [watching, setWatching] = useState<string | null>(null);
  const [stopping, setStopping] = useState<ApiShare | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const { teams } = useSettingsData();

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [shares, names] = await Promise.all([listShares(accessToken), listNames(accessToken)]);
      setLoaded({ state: "ready", shares, names });
    } catch (err) {
      if (err instanceof SharesApiError && err.status === 503) {
        setLoaded({ state: "off" });
        return;
      }
      setLoaded((previous) =>
        previous.state === "ready"
          ? previous
          : {
              state: "error",
              message: err instanceof Error ? err.message : "Your shares could not be loaded.",
            }
      );
    }
  }, [accessToken]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), REFRESH_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const split = useMemo(
    () => (loaded.state === "ready" ? splitShares(loaded.shares.shares) : null),
    [loaded]
  );
  const watched = split?.live.find((s) => s.id === watching) ?? null;

  const stop = async (share: ApiShare) => {
    if (!accessToken) return;
    setMessage(null);
    try {
      await stopShare(accessToken, share.id);
      setMessage({ tone: "success", text: `${share.name ?? share.endpointSlug} is stopped.` });
      if (watching === share.id) setWatching(null);
      await refresh();
    } catch (err) {
      setMessage({
        tone: "error",
        text: err instanceof Error ? err.message : "The share is still running. Try again.",
      });
    }
  };

  if (!accessToken || loaded.state === "loading") {
    return <SettingsPageSkeleton label="Loading shares" panels={3} />;
  }

  if (loaded.state === "off") {
    return (
      <Notice tone="info" title="Sharing is not available here yet">
        Previews of localhost are not set up on this server. Webhook capture and the rest of your
        account work as usual.
      </Notice>
    );
  }

  if (loaded.state === "error") {
    return (
      <Notice
        tone="danger"
        title="Your shares could not be loaded"
        action={
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Try again
          </Button>
        }
      >
        {loaded.message}
      </Notice>
    );
  }

  const { shares, names } = loaded;
  const { usage, limits } = shares;
  const live = split?.live ?? [];
  const ended = split?.ended ?? [];
  const teamChoices = teams.filter((t) => !t.suspended).map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-6">
      {usage.over && (
        <Notice tone="warning" title="Your previews are paused for the rest of the month">
          They used this month&apos;s {dataText(limits.dataGb)}. They open again on{" "}
          {longDate(usage.resetsAt)}, or at once on a plan with more data.{" "}
          <Link href="/account/plan" className={settingsLink}>
            See plans
          </Link>
        </Notice>
      )}
      {message && (
        <div className="ph-no-capture">
          <InlineMessage tone={message.tone}>{message.text}</InlineMessage>
        </div>
      )}

      <Panel
        id="live-shares"
        flush
        title="Live"
        description={
          live.length > 0
            ? `${live.filter((s) => s.mine && s.kind === "share").length} of ${limits.shares} previews running.`
            : undefined
        }
      >
        {live.length === 0 ? (
          <div className="space-y-4 p-5">
            <div className="space-y-1">
              <p className="text-sm font-medium">Nothing is shared right now.</p>
              <p className="text-sm text-muted-foreground max-w-[62ch]">
                Run your app, then give it a link anyone can open: a client, a teammate, your phone.
                The link works for as long as the command runs.
              </p>
            </div>
            <ol className="space-y-3 text-sm">
              <li className="space-y-1">
                <p className="text-muted-foreground">1. Install the CLI, if you have not:</p>
                <CommandBlock command={INSTALL} />
              </li>
              <li className="space-y-1">
                <p className="text-muted-foreground">2. Sign in once:</p>
                <CommandBlock command="whk auth login" />
              </li>
              <li className="space-y-1">
                <p className="text-muted-foreground">3. Share the port your app runs on:</p>
                <CommandBlock command="whk share 3000" />
              </li>
            </ol>
            <p className="text-xs text-muted-foreground">
              Testing webhooks? <span className="font-mono">whk tunnel 3000 --live</span> sends them
              to your app and gives the sender your app&apos;s real answer.{" "}
              <Link href="/docs/share" className={settingsLink}>
                How sharing works
              </Link>
            </p>
          </div>
        ) : (
          <ul className="ph-no-capture">
            {live.map((share) => (
              <LiveShareRow
                key={share.id}
                share={share}
                watching={watching === share.id}
                onWatch={() => setWatching((current) => (current === share.id ? null : share.id))}
                onStop={() => setStopping(share)}
              />
            ))}
          </ul>
        )}
        {live.length > 0 && (
          <div className="border-t px-5 py-3">
            <p className="mb-1 text-xs text-muted-foreground">Share another port:</p>
            <CommandBlock command="whk share 3000" />
          </div>
        )}
      </Panel>

      {watched && accessToken && (
        <RequestLog accessToken={accessToken} share={watched} onClose={() => setWatching(null)} />
      )}

      <NamesPanel
        accessToken={accessToken}
        listing={names}
        passwords={limits.passwords}
        teams={teamChoices}
        onChange={refresh}
      />

      <Panel
        id="share-usage"
        title="This month"
        description={`Plan: ${PLAN_NAMES[limits.plan] ?? limits.plan}`}
      >
        <div className="space-y-5">
          <DataMeter
            bytes={usage.bytes}
            limitBytes={usage.limitBytes}
            percent={usagePercent(usage)}
            resetsAt={usage.resetsAt}
          />
          <div>
            <PanelRow label="Previews at once">{sharesAtOnceText(limits.shares)}</PanelRow>
            <PanelRow label="Names of your own">{reservedNamesText(limits.reservedNames)}</PanelRow>
            <PanelRow label="Each share lasts">{sessionText(limits.sessionMinutes)}</PanelRow>
            <PanelRow label="Passwords on links">{limits.passwords ? "Yes" : "No"}</PanelRow>
            <PanelRow
              label="Visitor notice"
              hint="A short page before your preview that says it is a preview shared through webhooks.cc."
            >
              {limits.notice ? "Shown to visitors" : "Not shown"}
            </PanelRow>
          </div>
          {limits.plan === "free" && (
            <p className="text-sm text-muted-foreground">
              Pro keeps names of your own, shares without a time limit, and puts passwords on links.{" "}
              <Link href="/account/plan" className={settingsLink}>
                See plans
              </Link>
            </p>
          )}
        </div>
      </Panel>

      {ended.length > 0 && (
        <Panel id="earlier-shares" flush title="Earlier">
          <ul className="ph-no-capture">
            {ended.map((share) => (
              <li
                key={share.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border/60 px-5 py-2.5 text-sm last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono">
                    {share.kind === "live" ? share.endpointSlug : share.name}
                    {share.kind === "live" && (
                      <span className="ml-2 font-sans text-xs text-muted-foreground">
                        live tunnel
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {shortDate(share.startedAt)}, {durationText(share.startedAt, share.endedAt)}
                    {share.endReason ? `, ${share.endReason}` : ""}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatBytes(share.bytes)}, {share.requests.toLocaleString()} requests
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <AlertDialog open={stopping !== null} onOpenChange={(open) => !open && setStopping(null)}>
        <AlertDialogContent className="ph-no-capture">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop {stopping?.kind === "live" ? "the live tunnel" : stopping?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {stopping?.kind === "live"
                ? "Captures stop reaching your app; the endpoint keeps capturing them."
                : "The link stops working at once, and the CLI that shares it exits and says why."}
              {stopping && !stopping.mine && stopping.startedBy
                ? ` ${stopping.startedBy.email} started it.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it running</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = stopping;
                setStopping(null);
                if (target) void stop(target);
              }}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LiveShareRow({
  share,
  watching,
  onWatch,
  onStop,
}: {
  share: ApiShare;
  watching: boolean;
  onWatch: () => void;
  onStop: () => void;
}) {
  const { copy: copyText, isCopied } = useCopyWithFeedback();
  const copied = isCopied();
  const label = share.kind === "live" ? (share.endpointSlug ?? "live tunnel") : (share.name ?? "");
  const copy = () => {
    if (share.url) void copyText(share.url);
  };
  return (
    <li
      className={cn(
        "space-y-2 border-b border-border/60 px-5 py-4 last:border-b-0",
        watching && "bg-muted/40"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {share.url ? (
            <a
              href={share.url}
              target="_blank"
              rel="noreferrer"
              className="block break-all font-mono text-base font-semibold hover:underline"
            >
              {share.url.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <p className="font-mono text-base font-semibold">{label}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {share.kind === "live" ? (
              <StatusTag>Live tunnel to endpoint {share.endpointSlug}</StatusTag>
            ) : null}
            {share.password && (
              <span className="inline-flex items-center gap-1" title="Visitors need a password">
                <Lock className="h-3 w-3" aria-hidden />
                Password
              </span>
            )}
            <span>From {share.client}</span>
            {!share.mine && share.startedBy && <span>Started by {share.startedBy.email}</span>}
            <span>Running {durationText(share.startedAt, null)}</span>
            {share.expiresAt && <span>Ends {new Date(share.expiresAt).toLocaleTimeString()}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {share.url && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void copy()}
                title="Copy link"
                aria-label={`Copy the link to ${label}`}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                render={
                  <a
                    href={share.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open"
                    aria-label={`Open ${label}`}
                  />
                }
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
              {share.kind === "share" && <QrDialog url={share.url} label={label} />}
            </>
          )}
          {share.kind === "share" && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onWatch}
              aria-pressed={watching}
              title={watching ? "Hide requests" : "Show requests"}
              aria-label={`${watching ? "Hide" : "Show"} requests to ${label}`}
            >
              <Activity className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onStop}
            title="Stop"
            aria-label={`Stop ${label}`}
          >
            <Square className="h-4 w-4 text-destructive-ink" />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(share.bytes)} sent, {share.requests.toLocaleString()} requests
      </p>
    </li>
  );
}

function DataMeter({
  bytes,
  limitBytes,
  percent,
  resetsAt,
}: {
  bytes: number;
  limitBytes: number;
  percent: number;
  resetsAt: string;
}) {
  const near = percent >= 80;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm">
          <span
            className={cn("text-2xl tabular-nums font-semibold", near && "text-destructive-ink")}
          >
            {formatBytes(bytes)}
          </span>{" "}
          <span className="text-muted-foreground">
            of {formatBytes(limitBytes)} sent to visitors
          </span>
        </p>
        <p className="text-xs text-muted-foreground">Resets {longDate(resetsAt)}</p>
      </div>
      <Meter
        value={percent}
        aria-label={`${percent}% of this month's preview data used`}
        className="h-3 overflow-hidden rounded-sm bg-muted/60"
      >
        <div
          className={cn("h-full", near ? "bg-destructive" : "bg-primary")}
          style={{ width: `${Math.max(percent, bytes > 0 ? 1 : 0)}%` }}
        />
      </Meter>
    </div>
  );
}
