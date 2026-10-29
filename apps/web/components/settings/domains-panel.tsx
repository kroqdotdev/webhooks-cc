"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import {
  InlineMessage,
  Panel,
  PanelRow,
  StatusTag,
  settingsLink,
} from "@/components/settings/panel";
import { shortDate } from "@/components/settings/format";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import {
  addDomainRequest,
  fetchDomains,
  removeDomainRequest,
  saveDomainRouting,
  verifyDomainRequest,
  type DomainRoute,
  type InboundDomain,
} from "@/lib/domains-api";

export interface RoutableEndpoint {
  id: string;
  name: string | null;
  slug: string;
}

function endpointLabel(endpoint: RoutableEndpoint): string {
  return endpoint.name ? `${endpoint.name} (${endpoint.slug})` : endpoint.slug;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <code className="ui-code text-xs px-2 py-1 break-all shadow-none!">{value}</code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
        onClick={() =>
          void copyToClipboard(value).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

function statusOf(domain: InboundDomain) {
  if (domain.status === "pending") return <StatusTag tone="warning">Waiting for DNS</StatusTag>;
  if (domain.status === "lapsed") return <StatusTag tone="danger">Records missing</StatusTag>;
  if (!domain.active) return <StatusTag tone="warning">Past your plan</StatusTag>;
  return <StatusTag tone="success">Receiving mail</StatusTag>;
}

/**
 * One domain: the DNS records to add, a check, where its mail goes (an
 * address per endpoint and a catch-all), and removal.
 */
function DomainCard({
  domain,
  endpoints,
  accessToken,
  teamId,
  onChanged,
}: {
  domain: InboundDomain;
  endpoints: RoutableEndpoint[];
  accessToken: string;
  teamId?: string;
  onChanged: (next: InboundDomain | null) => void;
}) {
  const [catchAll, setCatchAll] = useState(domain.catchAllEndpointId ?? "");
  const [routes, setRoutes] = useState<DomainRoute[]>(domain.routes);
  const [busy, setBusy] = useState<"verify" | "save" | "remove" | null>(null);
  const [message, setMessage] = useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);
  const dirty =
    catchAll !== (domain.catchAllEndpointId ?? "") ||
    JSON.stringify(routes) !== JSON.stringify(domain.routes);

  const verify = async () => {
    setBusy("verify");
    setMessage(null);
    try {
      const result = await verifyDomainRequest(accessToken, domain.id, teamId);
      onChanged(result.domain);
      if (result.domain.status === "verified") {
        setMessage({
          tone: "success",
          text: "Verified. Mail to this domain arrives within a minute.",
        });
      } else {
        const missing = [
          !result.records.txt && "the TXT record",
          !result.records.mx && "the MX record",
        ]
          .filter(Boolean)
          .join(" and ");
        setMessage({
          tone: "warning",
          text: `Not found yet: ${missing}. DNS changes can take a while to show; check again later.`,
        });
      }
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The check failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const next = await saveDomainRouting(
        accessToken,
        domain.id,
        { catchAllEndpointId: catchAll || null, routes: routes.filter((route) => route.localPart) },
        teamId
      );
      setRoutes(next.routes);
      setCatchAll(next.catchAllEndpointId ?? "");
      onChanged(next);
      setMessage({ tone: "success", text: "Saved." });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Saving failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${domain.domain}? Mail to it will be refused from then on.`))
      return;
    setBusy("remove");
    try {
      await removeDomainRequest(accessToken, domain.id, teamId);
      onChanged(null);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Removing failed.",
      });
      setBusy(null);
    }
  };

  return (
    <li
      className="border-b border-line/60 last:border-b-0 px-5 py-5 space-y-4"
      aria-label={domain.domain}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <p className="font-bold truncate">{domain.domain}</p>
          {statusOf(domain)}
        </div>
        <div className="flex items-center gap-2">
          {domain.status !== "verified" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void verify()}
            >
              {busy === "verify" ? "Checking..." : "Check records"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${domain.domain}`}
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {domain.status !== "verified" && (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Add these records where the domain&apos;s DNS is managed, then check them.
          </p>
          <dl className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] items-center">
            <dt className="font-medium">TXT</dt>
            <dd>
              <CopyValue value={domain.records.txt.name} label="TXT name" />
            </dd>
            <dd>
              <CopyValue value={domain.records.txt.value} label="TXT value" />
            </dd>
            <dt className="font-medium">MX</dt>
            <dd>
              <CopyValue value={domain.records.mx.name} label="MX name" />
            </dd>
            <dd>
              <CopyValue value={domain.records.mx.value} label="MX value" />
            </dd>
          </dl>
          {domain.status === "lapsed" && (
            <p className="text-muted-foreground">
              The records were missing on the last checks, so its mail is refused until they are
              back.
            </p>
          )}
        </div>
      )}
      {domain.status === "verified" && domain.verifiedAt && (
        <p className="text-xs text-muted-foreground">
          Verified {shortDate(Date.parse(domain.verifiedAt))}; checked again every day.
          {!domain.active &&
            " Your plan includes fewer domains: add an extra domain to receive mail here."}
        </p>
      )}

      <div className="space-y-3">
        <p className="text-sm font-medium">Where its mail goes</p>
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {teamId ? "Share an endpoint with the team first." : "Create an endpoint first."}
          </p>
        ) : (
          <>
            <ul className="space-y-2" aria-label={`Addresses at ${domain.domain}`}>
              {routes.map((route, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label="Address name"
                    value={route.localPart}
                    onChange={(event) =>
                      setRoutes((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, localPart: event.target.value } : item
                        )
                      )
                    }
                    placeholder="orders"
                    className="ui-input w-36 text-sm py-1.5!"
                  />
                  <span className="text-sm text-muted-foreground">@{domain.domain} to</span>
                  <select
                    aria-label="Endpoint"
                    value={route.endpointId}
                    onChange={(event) =>
                      setRoutes((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, endpointId: event.target.value } : item
                        )
                      )
                    }
                    className="ui-input text-sm py-1.5!"
                  >
                    {endpoints.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpointLabel(endpoint)}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Remove address"
                    onClick={() => setRoutes((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setRoutes((current) => [...current, { localPart: "", endpointId: endpoints[0].id }])
              }
            >
              <Plus className="h-4 w-4" />
              Add an address
            </Button>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span>Any other address to</span>
              <select
                value={catchAll}
                onChange={(event) => setCatchAll(event.target.value)}
                className="ui-input text-sm py-1.5!"
              >
                <option value="">Refuse it</option>
                {endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>
                    {endpointLabel(endpoint)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <Button size="sm" disabled={!dirty || busy !== null} onClick={() => void save()}>
                {busy === "save" ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        )}
      </div>
      {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
    </li>
  );
}

/**
 * Custom inbound domains (Business, or a team's with Team Business): mail
 * to the account's own domain lands on its endpoints. Lists, adds, verifies,
 * routes and removes them.
 */
export function DomainsPanel({
  accessToken,
  endpoints,
  teamId,
  canAdd,
}: {
  accessToken: string | null;
  endpoints: RoutableEndpoint[];
  teamId?: string;
  /** The plan includes domains; otherwise a pointer to the plan instead of the form. */
  canAdd: boolean;
}) {
  const [domains, setDomains] = useState<InboundDomain[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setDomains(await fetchDomains(accessToken, teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Domains could not be loaded.");
    }
  }, [accessToken, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!accessToken || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addDomainRequest(accessToken, draft.trim(), teamId);
      setDomains((current) => [...(current ?? []), added]);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The domain could not be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      id="domains"
      title="Custom domains"
      description={
        <>
          Receive mail at your own domain, such as orders@inbound.acme.com: prove the domain with a
          TXT record, point its MX at mailhooks.cc, and choose which endpoint each address goes to.{" "}
          <Link href="/docs/email-capture#your-own-domain" className={settingsLink}>
            About custom domains
          </Link>
        </>
      }
      flush
    >
      {domains && domains.length > 0 && (
        <ul aria-label="Domains">
          {domains.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              endpoints={endpoints}
              accessToken={accessToken!}
              teamId={teamId}
              onChanged={(next) =>
                setDomains((current) =>
                  next === null
                    ? (current ?? []).filter((item) => item.id !== domain.id)
                    : (current ?? []).map((item) => (item.id === next.id ? next : item))
                )
              }
            />
          ))}
        </ul>
      )}
      <div className="px-5 py-4 space-y-2">
        {canAdd ? (
          <PanelRow label="Add a domain" htmlFor="add-domain">
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="add-domain"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void add();
                }}
                placeholder="inbound.acme.com"
                className="ui-input w-64 text-sm py-1.5!"
              />
              <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void add()}>
                {busy ? "Adding..." : "Add"}
              </Button>
            </div>
          </PanelRow>
        ) : (
          <p className="text-sm text-muted-foreground">
            {teamId ? (
              "Custom domains come with Team Business."
            ) : (
              <>
                Custom domains are part of{" "}
                <Link href="/account/plan" className={settingsLink}>
                  Business
                </Link>
                : one included, more at $3 a month each.
              </>
            )}
          </p>
        )}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </div>
    </Panel>
  );
}
