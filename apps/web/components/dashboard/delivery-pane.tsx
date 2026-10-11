"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  ForwardingOffError,
  fetchRequestDeliveries,
  redeliverRequest,
  type DeliveryAttempt,
  type DeliveryFormat,
  type ForwardFormatSetting,
  type RequestDelivery,
} from "@/lib/dashboard-api";
import { resolveFormat } from "@/lib/forwarding/format";
import { formatDuration, senderTimestamp, type SenderTime } from "@/lib/forwarding/timing";
import {
  CLOCKS_DIFFER_TITLE,
  DELIVERY_TIME_UTC_KEY,
  FORWARD_TIMEOUT_SECONDS,
  describeAnswer,
  describeSenderSource,
  formatAbout,
  formatClock,
  formatIn,
  formatSenderLag,
  formatTries,
  isAccepted,
  leadVerb,
  retryWindowName,
  senderTimeFromRecord,
  targetOfUrl,
} from "@/lib/forwarding/display";
import type { DisplayableRequest } from "./request-detail";
import { DeliveryJourney, type JourneyStop } from "./delivery-journey";

/** What the pane needs to know about the endpoint's forwarding. */
export interface DeliveryEndpoint {
  slug: string;
  forwardEnabled?: boolean;
  /** Only the owner has it. */
  forwardUrl?: string | null;
  hasForwardSecret?: boolean;
  forwardHttp?: boolean;
  forwardEmail?: boolean;
  forwardFormat?: ForwardFormatSetting;
  forwardAppendPath?: boolean;
  forwardRetrySeconds?: number;
  forwardSentField?: string | null;
}

const MAX_FORWARD_BYTES = 10 * 1024 * 1024;
const TRIES_SHOWN = 3;
const TIMEOUT_SECONDS = FORWARD_TIMEOUT_SECONDS;

export type ChipStatus = "succeeded" | "pending" | "failed" | "queued";

const CHIP: Record<ChipStatus, { label: string; className: string }> = {
  succeeded: {
    label: "Delivered",
    className: "bg-primary text-primary-foreground clean:bg-primary/12 clean:text-primary",
  },
  pending: {
    label: "Retrying",
    className:
      "bg-secondary text-black clean:bg-amber-500/15 clean:text-amber-700 dark:clean:text-amber-400",
  },
  failed: {
    label: "Failed",
    className: "bg-destructive text-white clean:bg-destructive/12 clean:text-destructive",
  },
  queued: {
    label: "Queued",
    className: "bg-muted text-muted-foreground",
  },
};

export function chipStatus(status: RequestDelivery["status"], attempts: number): ChipStatus {
  return status === "pending" && attempts === 0 ? "queued" : status;
}

/** The status chip of a delivery, as the log and the cards show it. */
export function DeliveryChip({ status }: { status: ChipStatus }) {
  const chip = CHIP[status];
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 text-[11px] font-bold caps rounded-sm border-strong border-line clean:border-transparent clean:font-medium whitespace-nowrap",
        chip.className
      )}
    >
      {chip.label}
    </span>
  );
}

/** Local or UTC for every time in the delivery views, remembered per browser. */
export function useUtcPreference(): [boolean, (next: boolean) => void] {
  const [utc, setUtcState] = useState(false);
  useEffect(() => {
    try {
      setUtcState(localStorage.getItem(DELIVERY_TIME_UTC_KEY) === "true");
    } catch {
      // localStorage unavailable
    }
  }, []);
  const setUtc = useCallback((next: boolean) => {
    setUtcState(next);
    try {
      localStorage.setItem(DELIVERY_TIME_UTC_KEY, String(next));
    } catch {
      // localStorage unavailable
    }
  }, []);
  return [utc, setUtc];
}

function Code({ bad, children }: { bad?: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("font-mono", bad ? "text-destructive" : "text-foreground")}>
      {children}
    </span>
  );
}

/** The sender's own timestamp for this request: as recorded, else read now with the same rules. */
function senderTimeFor(
  delivery: RequestDelivery | null,
  request: DisplayableRequest,
  endpoint: DeliveryEndpoint
): SenderTime | null {
  const recorded = delivery ? senderTimeFromRecord(delivery.senderAt, delivery.senderSource) : null;
  if (recorded) return recorded;
  return senderTimestamp(
    {
      kind: request.kind ?? "http",
      headers: request.headers,
      body: request.bodyRaw ? null : (request.body ?? null),
      emailDate: request.email?.date ?? null,
    },
    endpoint.forwardSentField ?? null
  );
}

/** Where a delivery with no try yet would go: the current URL, the path appended where it applies. */
function fallbackTarget(
  request: DisplayableRequest,
  endpoint: DeliveryEndpoint,
  format: DeliveryFormat
): string | null {
  if (!endpoint.forwardUrl) return null;
  if (
    format === "as_received" &&
    (request.kind ?? "http") === "http" &&
    endpoint.forwardAppendPath !== false &&
    request.path &&
    request.path !== "/"
  ) {
    const base = endpoint.forwardUrl.replace(/\/+$/, "");
    const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
    return targetOfUrl(`${base}${path}`, format);
  }
  return targetOfUrl(endpoint.forwardUrl, format);
}

interface Journey {
  stops: JourneyStop[];
  label: string;
  note: React.ReactNode | null;
  meta: string;
}

function journeyFor(
  delivery: RequestDelivery,
  request: DisplayableRequest,
  endpoint: DeliveryEndpoint,
  utc: boolean,
  now: number,
  isRedelivery: boolean,
  settingsLink: React.ReactNode
): Journey {
  const clock = (ms: number, wholeSeconds = false) => formatClock(ms, { utc, wholeSeconds, now });
  const receivedAt = request.receivedAt;
  const latest: DeliveryAttempt | undefined = delivery.attemptLog[0];
  const attempts = delivery.attempts;
  const stops: JourneyStop[] = [];
  let label = "";

  const sent = senderTimeFor(delivery, request, endpoint);
  if (sent) {
    const lag = formatSenderLag(sent, receivedAt);
    const behind = lag.startsWith("-") || lag.startsWith("about -");
    stops.push({
      key: "sent",
      name: "Sent",
      time: clock(sent.at, sent.wholeSeconds),
      sub: describeSenderSource(sent.source),
      tone: "hollow",
      segment: {
        label: behind ? (
          <span className="text-destructive">{lag}</span>
        ) : (
          <b className="font-semibold text-foreground">{lag}</b>
        ),
        title: behind ? CLOCKS_DIFFER_TITLE : "From the sender's own timestamp to our receipt",
      },
    });
    label += `Sent at ${clock(sent.at, sent.wholeSeconds)} according to ${sent.source}, ${lag} before receipt. `;
  }

  const received: JourneyStop = {
    key: "received",
    name: "Received",
    time: clock(receivedAt),
    tone: "solid",
  };
  let note: React.ReactNode = null;
  let meta = formatTries(attempts);
  const window = retryWindowName(endpoint.forwardRetrySeconds ?? 86_400);

  if (delivery.status === "succeeded") {
    const at = delivery.finishedAt ?? latest?.attemptedAt ?? delivery.createdAt;
    const after = formatDuration(at - receivedAt);
    received.segment = {
      label: (
        <>
          <b className="font-semibold text-foreground">{after}</b> later
          {attempts > 1 ? `, ${formatTries(attempts)}` : ""}
        </>
      ),
      title: "From receipt to the accepted delivery",
    };
    stops.push(received, {
      key: "out",
      name: "Delivered",
      time: clock(at),
      tone: "delivered",
      sub: latest ? (
        <>
          <Code>{latest.status}</Code> in {formatDuration(latest.durationMs)}
        </>
      ) : null,
    });
    label += `Received at ${clock(receivedAt)}, delivered ${after} later at ${clock(at)}.`;
    if (latest)
      label += ` Your server answered ${latest.status} in ${formatDuration(latest.durationMs)}.`;
  } else if (delivery.status === "failed") {
    const at = delivery.finishedAt ?? latest?.attemptedAt ?? delivery.createdAt;
    const span = formatDuration(at - receivedAt);
    const answer = describeAnswer(
      latest?.status ?? null,
      latest?.error ?? delivery.lastError,
      attempts
    );
    received.segment = {
      label: (
        <>
          <b className="font-semibold text-foreground">{span}</b>
          {attempts > 1 ? `, ${formatTries(attempts)}` : ""}
        </>
      ),
    };
    const duration = latest ? formatDuration(latest.durationMs) : null;
    stops.push(received, {
      key: "out",
      name: "Failed",
      time: clock(at),
      tone: "failed",
      sub:
        answer.kind === "status" || answer.kind === "timeout" ? (
          <>
            <Code bad>{answer.label}</Code>
            {duration ? ` in ${duration}` : ""}
          </>
        ) : (
          <span className="text-destructive">{answer.label}</span>
        ),
    });
    const what =
      answer.kind === "status"
        ? `your server answered ${answer.label}`
        : answer.kind === "timeout"
          ? `your server gave no answer within ${TIMEOUT_SECONDS} seconds`
          : answer.kind === "unreachable"
            ? "your server could not be reached"
            : (delivery.lastError ?? "it was not sent");
    label += `Received at ${clock(receivedAt)}. Failed at ${clock(at)} after ${formatTries(attempts)}: ${what}.`;
    if (attempts > 1) {
      meta = `${formatTries(attempts)} over ${formatDuration(at - delivery.createdAt)}`;
    }
    if (answer.kind === "refused" && delivery.lastError) {
      note = delivery.lastError;
    } else if ((endpoint.forwardRetrySeconds ?? 86_400) <= 0 && attempts <= 1) {
      note = "Not retried, as set under Advanced. Redeliver sends it again now.";
    } else {
      note =
        "Marked failed after the last retry. Redeliver sends it again with the current URL, format and headers.";
    }
  } else if (attempts === 0 || !latest) {
    received.segment = { label: "delivering", dashed: true };
    stops.push(received, {
      key: "queued",
      name: "Queued",
      time: clock(delivery.createdAt),
      tone: "queued",
      sub: "the result shows here within a few seconds",
    });
    label += `Received at ${clock(receivedAt)}. Queued at ${clock(delivery.createdAt)}; the result shows here within a few seconds.`;
    meta = isRedelivery
      ? now - delivery.createdAt < 60_000
        ? "requested just now, with the current settings"
        : `requested ${clock(delivery.createdAt)}`
      : "waiting for its first try";
  } else {
    const tryEnd = latest.attemptedAt;
    const answer = describeAnswer(latest.status, latest.error, attempts);
    received.segment = { label: formatDuration(tryEnd - receivedAt) };
    const next = delivery.nextAttemptAt;
    stops.push(
      received,
      {
        key: "try",
        name: `Try ${attempts}`,
        time: clock(tryEnd),
        tone: "retrying",
        sub:
          answer.kind === "status" || answer.kind === "timeout" ? (
            <>
              <Code bad>{answer.label}</Code> in {formatDuration(latest.durationMs)}
            </>
          ) : (
            <span className="text-destructive">{answer.label}</span>
          ),
        segment: {
          label: next ? `next try ${formatIn(next, now)}` : "next try soon",
          dashed: true,
        },
      },
      {
        key: "next",
        name: `Try ${attempts + 1}`,
        tone: "queued",
        sub: next ? formatAbout(next, utc) : null,
      }
    );
    const got =
      answer.kind === "status"
        ? `got ${answer.label}`
        : answer.kind === "timeout"
          ? `got no answer within ${TIMEOUT_SECONDS} seconds`
          : "could not reach the server";
    label += `Received at ${clock(receivedAt)}. Try ${attempts} at ${clock(tryEnd)} ${got}.${next ? ` The next try is ${formatIn(next, now)}.` : ""}`;
    meta = `${formatTries(attempts)}${next ? `, next ${formatIn(next, now)}` : ""}`;
    const cause =
      answer.kind === "status"
        ? `Your server answered ${answer.label}.`
        : answer.kind === "timeout"
          ? `Your server did not answer within ${TIMEOUT_SECONDS} s.`
          : "Your server could not be reached.";
    note = (
      <>
        {cause} Tries continue for {window}; change that under Advanced in {settingsLink}.
      </>
    );
  }
  return { stops, label, note, meta };
}

function TriesList({
  delivery,
  utc,
  now,
}: {
  delivery: RequestDelivery;
  utc: boolean;
  now: number;
}) {
  const [all, setAll] = useState(false);
  const tries = delivery.attemptLog;
  if (tries.length === 0) return null;
  const shown = all ? tries : tries.slice(0, TRIES_SHOWN);
  return (
    <div className="mt-3.5 border-t border-line/20">
      <p className="pt-2.5 pb-0.5 text-[10px] font-bold caps text-muted-foreground">Tries</p>
      <ol className="text-[13px]">
        {shown.map((attempt, index) => {
          const number = tries.length - index;
          const answer = describeAnswer(attempt.status, attempt.error, 1);
          const bad = !isAccepted(attempt.status);
          return (
            <li
              key={`${attempt.attemptedAt}-${index}`}
              className={cn(
                "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5",
                index > 0 && "border-t border-line/15"
              )}
            >
              <span className="text-muted-foreground tabular-nums">{number}</span>
              <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                {formatClock(attempt.attemptedAt - attempt.durationMs, { utc, now })}
              </span>
              <span className={cn("font-mono whitespace-nowrap", bad && "text-destructive")}>
                {answer.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                {formatDuration(attempt.durationMs)}
              </span>
              {attempt.error ? (
                <span className="basis-full md:basis-auto md:flex-1 min-w-0 text-xs text-destructive">
                  {attempt.error}
                </span>
              ) : attempt.responseExcerpt ? (
                <code className="basis-full md:basis-auto md:flex-1 min-w-0 block font-mono text-xs text-muted-foreground break-all line-clamp-3">
                  {attempt.responseExcerpt}
                </code>
              ) : null}
            </li>
          );
        })}
      </ol>
      {tries.length > TRIES_SHOWN && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-xs underline underline-offset-2 cursor-pointer"
        >
          Show all {formatTries(tries.length)}
        </button>
      )}
    </div>
  );
}

function DeliveryCard({
  delivery,
  request,
  endpoint,
  utc,
  now,
  isRedelivery,
  settingsLink,
}: {
  delivery: RequestDelivery;
  request: DisplayableRequest;
  endpoint: DeliveryEndpoint;
  utc: boolean;
  now: number;
  isRedelivery: boolean;
  settingsLink: React.ReactNode;
}) {
  const journey = useMemo(
    () => journeyFor(delivery, request, endpoint, utc, now, isRedelivery, settingsLink),
    [delivery, request, endpoint, utc, now, isRedelivery, settingsLink]
  );
  const kind = isRedelivery ? "Redelivery" : "Delivery";
  return (
    <section className="ui-card ui-card-static p-0! overflow-hidden" aria-label={kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b border-line/20">
        <DeliveryChip status={chipStatus(delivery.status, delivery.attempts)} />
        <span className="text-sm">{kind}</span>
        <span className="text-xs text-muted-foreground">{journey.meta}</span>
      </div>
      <div className="px-4 pt-3.5 pb-4">
        <DeliveryJourney stops={journey.stops} label={journey.label} />
        {journey.note && <p className="mt-3.5 text-[13px]">{journey.note}</p>}
        <TriesList delivery={delivery} utc={utc} now={now} />
      </div>
    </section>
  );
}

/**
 * The Deliveries tab of a captured request: every copy forwarded, each with
 * its journey and tries, a Local time / UTC toggle, and Redeliver (or Deliver
 * now for a request that was never forwarded). Shared by the HTTP and email
 * detail views.
 */
export function DeliveriesPane({
  request,
  endpoint,
  canRedeliver,
  onOpenForwarding,
}: {
  request: DisplayableRequest;
  endpoint: DeliveryEndpoint;
  /** The owner can redeliver and is pointed at the Forwarding settings. */
  canRedeliver: boolean;
  onOpenForwarding?: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const requestId = "id" in request ? request.id : request._id;
  const kind = request.kind ?? "http";
  const [deliveries, setDeliveries] = useState<RequestDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [queuing, setQueuing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [utc, setUtc] = useUtcPreference();

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setDeliveries(await fetchRequestDeliveries(accessToken, requestId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deliveries could not be loaded.");
    }
    setNow(Date.now());
  }, [accessToken, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Watch a delivery that is still being tried, and keep "next in 8 min" current.
  const active = deliveries?.some((delivery) => delivery.status === "pending") ?? false;
  useEffect(() => {
    const timer = setInterval(
      () => (active ? void load() : setNow(Date.now())),
      active ? 3000 : 30_000
    );
    return () => clearInterval(timer);
  }, [active, load]);

  const kindOn = kind === "email" ? endpoint.forwardEmail !== false : endpoint.forwardHttp === true;
  const forwardingOn = endpoint.forwardEnabled === true && kindOn;

  const redeliver = async () => {
    if (!accessToken || queuing) return;
    setQueuing(true);
    setStatus(null);
    try {
      await redeliverRequest(accessToken, requestId);
      setStatus({ text: "Queued. The result shows here within a few seconds.", error: false });
      await load();
    } catch (err) {
      setStatus({
        text:
          err instanceof ForwardingOffError
            ? "Turn forwarding on first."
            : "The request could not be queued again.",
        error: true,
      });
    } finally {
      setQueuing(false);
    }
  };

  // The lead line: what was actually used, or why nothing was sent.
  const newest = deliveries?.[0] ?? null;
  const settingFormat = endpoint.forwardFormat === "auto" ? null : (endpoint.forwardFormat ?? null);
  const format: DeliveryFormat =
    newest?.format ?? resolveFormat(kind, settingFormat, endpoint.forwardUrl ?? "");
  const target = newest?.target ?? fallbackTarget(request, endpoint, format);
  const settingsLink =
    canRedeliver && onOpenForwarding ? (
      <button
        type="button"
        onClick={onOpenForwarding}
        className="underline underline-offset-2 cursor-pointer"
      >
        Settings
      </button>
    ) : (
      "Settings"
    );

  let lead: React.ReactNode;
  if (deliveries && deliveries.length > 0) {
    lead = (
      <>
        {leadVerb(format)}{" "}
        {target ? (
          <span className="font-mono text-foreground [overflow-wrap:anywhere]">{target}</span>
        ) : (
          "the forwarding URL"
        )}
        .
      </>
    );
  } else if (!kindOn && endpoint.forwardEnabled) {
    lead = (
      <>
        Not forwarded. {kind === "email" ? "Emails" : "HTTP requests"} are not included; change what
        is forwarded in {settingsLink}.
      </>
    );
  } else if (!endpoint.forwardEnabled) {
    lead = "Not forwarded. Forwarding is off for this endpoint.";
  } else if (request.size > MAX_FORWARD_BYTES) {
    lead = "Not forwarded. The body is larger than 10 MB.";
  } else {
    lead = "Not forwarded. It arrived before forwarding was turned on.";
  }

  const oldestId =
    deliveries && deliveries.length > 0 ? deliveries[deliveries.length - 1].id : null;
  const never = deliveries !== null && deliveries.length === 0;

  return (
    <div className="max-w-[860px] space-y-3">
      <div className="flex flex-col md:flex-row md:items-start gap-3">
        <p className="flex-1 text-sm text-muted-foreground">{lead}</p>
        <div className="flex items-center justify-between md:justify-start gap-2.5 shrink-0">
          <button
            type="button"
            aria-pressed={utc}
            onClick={() => setUtc(!utc)}
            className="text-xs text-muted-foreground underline underline-offset-2 cursor-pointer hover:text-foreground"
          >
            {utc ? "UTC. Show local time" : "Local time. Show UTC"}
          </button>
          {canRedeliver && (
            <button
              type="button"
              onClick={() => void redeliver()}
              disabled={queuing || !forwardingOn || deliveries === null}
              title={!forwardingOn ? "Turn forwarding on to redeliver." : undefined}
              className={cn(
                "ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5 shrink-0",
                (queuing || !forwardingOn || deliveries === null) && "opacity-50 cursor-not-allowed"
              )}
            >
              <RefreshCw className={cn("h-3 w-3", queuing && "animate-spin")} />
              {queuing ? "Queuing..." : never ? "Deliver now" : "Redeliver"}
            </button>
          )}
        </div>
      </div>
      {status && (
        <p
          role="status"
          aria-live="polite"
          className={cn("text-[13px]", status.error ? "text-destructive" : "text-foreground")}
        >
          {status.text}
        </p>
      )}
      {never && canRedeliver && forwardingOn && target && (
        <p className="text-xs text-muted-foreground max-w-[62ch]">
          Deliver now sends it to <span className="font-mono text-foreground">{target}</span> with
          the current settings, once, and logs it like any delivery.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {deliveries === null && !error && <p className="text-sm text-muted-foreground">Loading...</p>}
      {deliveries?.map((delivery) => (
        <DeliveryCard
          key={delivery.id}
          delivery={delivery}
          request={request}
          endpoint={endpoint}
          utc={utc}
          now={now}
          isRedelivery={delivery.id !== oldestId}
          settingsLink={settingsLink}
        />
      ))}
    </div>
  );
}
