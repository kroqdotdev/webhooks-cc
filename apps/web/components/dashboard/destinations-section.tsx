"use client";

import { INBOUND_EMAIL_FORMAT_NAMES } from "@webhooks-cc/sdk/email";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  ChevronDown,
  Globe,
  Mail,
  MessageSquare,
  Sheet,
  FolderUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  emitDashboardEndpointsChanged,
  fetchDestinations,
  reorderDestinations,
  updateDestination,
  type DashboardDestination,
  type DashboardEndpoint,
} from "@/lib/dashboard-api";
import { describeConditions } from "@/lib/condition-labels";
import { isChatUrl } from "@/lib/forwarding/format";
import { chatServiceName, formatCappedCount } from "@/lib/forwarding/display";
import { StatusDot } from "./delivery-journey";
import { DestinationEditor, type DestinationPreset } from "./destination-editor";
import { Section, Switch } from "./settings-primitives";
import { useDocumentVisible, useOnScreen } from "./use-delivery-summary";

/**
 * Where an endpoint's captures go: a list of destinations, each a row that
 * says in one line what it gets and how, with its last 24 hours, and opens
 * into its editor. Notifications are one of them (a chat message, at most
 * one a second). Adding one starts from what it is for: your server, a
 * chat channel, or a JSON body of your own.
 */

const PRESETS: { id: DestinationPreset; label: string; detail: string; icon: typeof Globe }[] = [
  {
    id: "server",
    label: "Your server",
    detail: "Requests relayed as they came, emails as signed JSON.",
    icon: Globe,
  },
  {
    id: "chat",
    label: "Slack or Discord",
    detail: "A message in a channel for each request, or a heads-up at most once a second.",
    icon: MessageSquare,
  },
  {
    id: "template",
    label: "Your own JSON",
    detail: "Pick the fields to send and shape the body, for Zapier, n8n or your own API.",
    icon: Braces,
  },
  {
    id: "sheets",
    label: "Google Sheets",
    detail: "A row in a spreadsheet for each email or request, with the columns you choose.",
    icon: Sheet,
  },
  {
    id: "file_drop",
    label: "File drop",
    detail:
      "A CSV, XML or JSON file on your SFTP, FTP or S3 server, per email or per batch. Business.",
    icon: FolderUp,
  },
  {
    id: "inbound",
    label: "Inbound email handler",
    detail:
      "Emails shaped as Postmark, SendGrid, Mailgun or CloudMailin post them, to test your handler.",
    icon: Mail,
  },
];

const FORMAT_NAMES: Record<string, string> = {
  as_received: "As received",
  json: "Signed JSON",
  template: "Your JSON",
  chat: "Chat message",
  sheets: "Google Sheets",
  file_drop: "File drop",
  ...INBOUND_EMAIL_FORMAT_NAMES,
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatName(destination: DashboardDestination): string {
  if (destination.format !== "auto") return FORMAT_NAMES[destination.format];
  if (isChatUrl(destination.url)) return "Chat message";
  return destination.http ? "As received" : "Signed JSON";
}

/** The row's sentence: what it gets, when, and how often. */
function describe(destination: DashboardDestination): string {
  const kinds =
    destination.http && destination.email
      ? "HTTP requests and emails"
      : destination.http
        ? "HTTP requests"
        : "Emails";
  const filter = destination.filter
    ? `, only when ${describeConditions(destination.filter.conditions, destination.filter.logic)}`
    : "";
  const throttle =
    destination.throttleSeconds > 0
      ? `, at most one every ${destination.throttleSeconds === 1 ? "second" : `${destination.throttleSeconds} s`}`
      : "";
  const delay = destination.delaySeconds > 0 ? `, ${destination.delaySeconds} s after arrival` : "";
  return `${kinds}${filter}${throttle}${delay}.`;
}

function Health({ destination }: { destination: DashboardDestination }) {
  const summary = destination.summary;
  if (!summary) return null;
  const { delivered, failed, skipped } = summary.last24h;
  if (delivered + failed + skipped + summary.pending === 0) {
    return <span className="text-xs text-muted-foreground">Nothing sent in 24 h</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone="delivered" />
        <span className="font-mono">{formatCappedCount(delivered)}</span> delivered
      </span>
      {summary.pending > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="retrying" />
          <span className="font-mono">{formatCappedCount(summary.pending)}</span> waiting
        </span>
      )}
      {failed > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="failed" />
          <span className="font-mono">{formatCappedCount(failed)}</span> failed
        </span>
      )}
      {skipped > 0 && (
        <span className="text-muted-foreground">
          <span className="font-mono">{formatCappedCount(skipped)}</span> filtered out
        </span>
      )}
    </span>
  );
}

function PresetPicker({
  onPick,
  email,
}: {
  onPick: (preset: DestinationPreset) => void;
  /** Whether the endpoint receives email (the inbound handler preset is for that). */
  email: boolean;
}) {
  const presets = email ? PRESETS : PRESETS.filter((preset) => preset.id !== "inbound");
  return (
    <div className={cn("grid gap-2", presets.length === 4 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
      {presets.map((preset) => {
        const Icon = preset.icon;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onPick(preset.id)}
            className="text-left border-strong border-line rounded-md p-3 bg-card hover:bg-muted/60 transition-colors motion-reduce:transition-none cursor-pointer space-y-1"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Icon className="h-4 w-4" />
              {preset.label}
            </span>
            <span className="block text-xs text-muted-foreground">{preset.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DestinationsSection({
  endpoint,
  onSeeDeliveries,
}: {
  endpoint: DashboardEndpoint;
  onSeeDeliveries: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const sectionRef = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(sectionRef);
  const documentVisible = useDocumentVisible();
  const [destinations, setDestinations] = useState<DashboardDestination[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState<DestinationPreset | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setDestinations(await fetchDestinations(accessToken, endpoint.slug, { summary: true }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Destinations could not be loaded.");
    }
  }, [accessToken, endpoint.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the health lines current while the section is on screen.
  useEffect(() => {
    if (!onScreen || !documentVisible) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [onScreen, documentVisible, load]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const changed = () => {
    void load();
    emitDashboardEndpointsChanged();
  };

  const setEnabled = async (destination: DashboardDestination, enabled: boolean) => {
    if (!accessToken) return;
    setDestinations(
      (prev) => prev?.map((d) => (d.id === destination.id ? { ...d, enabled } : d)) ?? prev
    );
    try {
      await updateDestination(accessToken, endpoint.slug, destination.id, { enabled });
      changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The destination could not be changed.");
      void load();
    }
  };

  const move = async (index: number, by: -1 | 1) => {
    if (!accessToken || !destinations) return;
    const ids = destinations.map((d) => d.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setDestinations(ids.map((id) => destinations.find((d) => d.id === id)!));
    try {
      await reorderDestinations(accessToken, endpoint.slug, ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The order could not be saved.");
    }
    void load();
  };

  const signingConfigured = !!endpoint.signingProvider;
  const emailFieldNames = (endpoint.emailFields ?? []).map((field) => field.name);
  const count = destinations?.length ?? 0;
  const anyDelivered = (destinations ?? []).some(
    (d) => d.summary && d.summary.last24h.delivered + d.summary.last24h.failed > 0
  );

  return (
    <Section
      id="forwarding"
      sectionRef={sectionRef}
      title="Forwarding"
      description="Send what this endpoint captures to your servers and chat channels. Each destination chooses what it gets and how it is sent; every delivery is queued, retried if it is not accepted, and logged."
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {destinations === null && !error && (
        <p className="text-sm text-muted-foreground">Loading destinations...</p>
      )}

      {destinations !== null && count === 0 && !adding && (
        <div className="space-y-2">
          <p className="text-sm">Nothing is forwarded yet. Where should captures go?</p>
          <PresetPicker onPick={setAdding} email={!!endpoint.emailAddress} />
        </div>
      )}

      {count > 0 && (
        <ul
          aria-label="Destinations"
          className="border-strong border-line rounded-md divide-y divide-line/30 overflow-hidden"
        >
          {destinations!.map((destination, index) => {
            const isOpen = open.has(destination.id);
            const panelId = `destination-panel-${destination.id}`;
            const chat = formatName(destination) === "Chat message";
            const title =
              destination.name ??
              (chat && isChatUrl(destination.url)
                ? `${chatServiceName(destination.url)} channel`
                : hostOf(destination.url));
            return (
              <li key={destination.id} className="bg-card">
                <div className="flex items-start gap-3 px-3 py-3">
                  <div className="pt-0.5">
                    <Switch
                      id={`${panelId}-on`}
                      checked={destination.enabled}
                      onChange={(enabled) => void setEnabled(destination, enabled)}
                      label={`${title} on`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(destination.id)}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    className={cn(
                      "flex-1 min-w-0 text-left space-y-1 cursor-pointer",
                      !destination.enabled && "opacity-60"
                    )}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold">{title}</span>
                      <span className="text-xs text-muted-foreground font-mono truncate max-w-[24rem]">
                        {destination.name ? hostOf(destination.url) : ""}
                      </span>
                      <span className="ml-auto text-[11px] font-bold caps text-muted-foreground">
                        {formatName(destination)}
                      </span>
                    </span>
                    <span className="block text-[13px] text-muted-foreground">
                      {destination.enabled ? describe(destination) : "Off. Nothing is sent."}
                    </span>
                    <Health destination={destination} />
                  </button>
                  <div className="flex flex-col items-center gap-1 pt-0.5">
                    <button
                      type="button"
                      onClick={() => toggle(destination.id)}
                      aria-label={`${isOpen ? "Close" : "Open"} ${title}`}
                      className="inline-flex items-center justify-center h-7 w-7 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                    >
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 transition-transform motion-reduce:transition-none",
                          isOpen && "rotate-180"
                        )}
                      />
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div id={panelId} className="px-3 pb-4 pt-4 border-t border-line/20">
                    <DestinationEditor
                      slug={endpoint.slug}
                      destination={destination}
                      signingConfigured={signingConfigured}
                      emailFieldNames={emailFieldNames}
                      onSaved={(saved) => {
                        setDestinations(
                          (prev) =>
                            prev?.map((d) =>
                              d.id === saved.id ? { ...saved, summary: d.summary } : d
                            ) ?? prev
                        );
                        changed();
                      }}
                      onDeleted={() => {
                        setOpen((prev) => {
                          const next = new Set(prev);
                          next.delete(destination.id);
                          return next;
                        });
                        changed();
                      }}
                    />
                    {count > 1 && (
                      <div className="flex flex-wrap items-center gap-2 pt-3 mt-3 border-t border-line/20">
                        <span className="text-xs text-muted-foreground">Place in the list</span>
                        <button
                          type="button"
                          onClick={() => void move(index, -1)}
                          disabled={index === 0}
                          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ArrowUp className="h-3 w-3" /> Up
                        </button>
                        <button
                          type="button"
                          onClick={() => void move(index, 1)}
                          disabled={index === count - 1}
                          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ArrowDown className="h-3 w-3" /> Down
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <div className="border-strong border-line rounded-md p-3 bg-card space-y-3">
          <p className="text-sm font-semibold">
            New destination: {PRESETS.find((p) => p.id === adding)?.label}
          </p>
          <DestinationEditor
            slug={endpoint.slug}
            destination={null}
            preset={adding}
            signingConfigured={signingConfigured}
            emailFieldNames={emailFieldNames}
            onSaved={(saved) => {
              setAdding(null);
              setOpen((prev) => new Set(prev).add(saved.id));
              changed();
            }}
            onCancel={() => setAdding(null)}
          />
        </div>
      )}

      {count > 0 && !adding && (
        <div className="space-y-2">
          {picking ? (
            <>
              <PresetPicker
                email={!!endpoint.emailAddress}
                onPick={(preset) => {
                  setPicking(false);
                  setAdding(preset);
                }}
              />
              <button
                type="button"
                onClick={() => setPicking(false)}
                className="text-xs text-muted-foreground underline underline-offset-2 cursor-pointer"
              >
                Cancel
              </button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setPicking(true)}
                disabled={count >= 10}
                className={cn(
                  "ui-btn-outline py-1.5! px-3! text-xs",
                  count >= 10 && "opacity-50 cursor-not-allowed"
                )}
              >
                Add destination
              </button>
              {count >= 10 && (
                <span className="text-xs text-muted-foreground">
                  An endpoint can send to at most 10 destinations.
                </span>
              )}
              {anyDelivered && (
                <button
                  type="button"
                  onClick={onSeeDeliveries}
                  className="text-xs underline underline-offset-2 cursor-pointer ml-auto"
                >
                  See deliveries
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
