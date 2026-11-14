"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { InlineMessage, Panel, PanelRow, settingsLink } from "@/components/settings/panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldControl } from "@/components/ui/field";
import { longDate } from "@/lib/dates";

/**
 * Organisation issuers a team trusts for agent sign-in
 * (/api/teams/[teamId]/idjag-issuers). Renders nothing while the feature is
 * off (the route answers 404). Members see the list; the owner adds and
 * removes. Adding takes a session, so it lives here and not in the clients.
 */

interface IssuerRow {
  id: string;
  issuer: string;
  allowed_client_ids: string[];
  created_at: string;
}

interface IssuersState {
  issuers: IssuerRow[];
  prefixes: string[];
  max_issuers: number;
  can_manage: boolean;
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.status < 500 && data.error ? data.error : fallback;
}

export function TeamIdJagIssuersPanel({
  accessToken,
  teamId,
}: {
  accessToken: string | null;
  teamId: string;
}) {
  const [state, setState] = useState<IssuersState | null>(null);
  const [issuer, setIssuer] = useState("");
  const [clientIds, setClientIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const base = `/api/teams/${encodeURIComponent(teamId)}/idjag-issuers`;

  const load = useCallback(async () => {
    if (!accessToken) return;
    const res = await fetch(base, { headers: { Authorization: `Bearer ${accessToken}` } });
    // 404: the feature is off (or no longer a member); show nothing.
    if (!res.ok) {
      setState(null);
      return;
    }
    setState((await res.json()) as IssuersState);
  }, [accessToken, base]);

  useEffect(() => {
    // A failed read leaves the panel hidden, as when the feature is off.
    load().catch(() => setState(null));
  }, [load]);

  if (!state) return null;

  async function add() {
    if (!accessToken || !issuer.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const ids = clientIds
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const res = await fetch(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          issuer: issuer.trim(),
          ...(ids.length > 0 ? { allowed_client_ids: ids } : {}),
        }),
      });
      if (!res.ok) {
        setMessage({ tone: "error", text: await errorText(res, "Could not add the issuer.") });
        return;
      }
      setIssuer("");
      setClientIds("");
      setMessage({ tone: "success", text: "Issuer added." });
      await load();
    } catch {
      setMessage({ tone: "error", text: "Could not add the issuer." });
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: IssuerRow) {
    if (!accessToken) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        setMessage({ tone: "error", text: await errorText(res, "Could not remove the issuer.") });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { revoked_connections?: number };
      const revoked = data.revoked_connections ?? 0;
      setMessage({
        tone: "success",
        text:
          revoked === 0
            ? "Issuer removed."
            : `Issuer removed. ${revoked === 1 ? "One agent was" : `${revoked} agents were`} disconnected.`,
      });
      await load();
    } catch {
      setMessage({ tone: "error", text: "Could not remove the issuer." });
    } finally {
      setBusy(false);
    }
  }

  const full = state.issuers.length >= state.max_issuers;

  return (
    <Panel
      id="agent-sign-in"
      title="Agent sign-in from your organisation"
      description={
        <>
          Trust your organisation&apos;s identity issuer, and members&apos; agents can connect with
          the member&apos;s organisation sign-in. Each member confirms an agent once; removing the
          issuer, or leaving the team, disconnects every agent it connected.{" "}
          <Link href="/docs/teams#agent-sign-in-from-your-organisation" className={settingsLink}>
            About agent sign-in
          </Link>
        </>
      }
      flush
    >
      {state.issuers.length > 0 ? (
        <ul aria-label="Trusted issuers" className="ph-no-capture">
          {state.issuers.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-5 py-3 last:border-b-0"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-mono text-sm break-all">{row.issuer}</p>
                <p className="text-xs text-muted-foreground">
                  {row.allowed_client_ids.length > 0
                    ? `Only ${row.allowed_client_ids.join(", ")}`
                    : "Any client"}
                  {", added "}
                  {longDate(row.created_at)}
                </p>
              </div>
              {state.can_manage && (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Remove ${row.issuer}`}
                      />
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Stop trusting this issuer?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Every agent it connected is disconnected now, and their tokens stop working.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep issuer</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void remove(row)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Remove issuer
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {state.can_manage
            ? "No issuer yet. Add your organisation's issuer URL below."
            : "The team trusts no issuer. The owner can add one."}
        </p>
      )}
      {state.can_manage && (
        <div className="space-y-2 border-t border-border/60 px-5 py-4">
          {full ? (
            <p className="text-sm text-muted-foreground">
              A team can trust at most {state.max_issuers} issuers.
            </p>
          ) : (
            <>
              <PanelRow
                label="Issuer URL"
                htmlFor="idjag-issuer"
                hint={`Exactly as your organisation publishes it, under ${state.prefixes.join(" or ")}`}
              >
                <FieldControl
                  className="w-full max-w-md text-sm py-1.5! ph-no-capture"
                  id="idjag-issuer"
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder={`${state.prefixes[0] ?? "https://"}...`}
                  autoComplete="off"
                  spellCheck={false}
                />
              </PanelRow>
              <PanelRow
                label="Allowed clients"
                htmlFor="idjag-client-ids"
                hint="Optional. Client ids the issuer may name, separated by commas. Empty allows any."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <FieldControl
                    className="w-full max-w-md text-sm py-1.5! ph-no-capture"
                    id="idjag-client-ids"
                    value={clientIds}
                    onChange={(event) => setClientIds(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button size="sm" disabled={busy || !issuer.trim()} onClick={() => void add()}>
                    {busy ? "Adding..." : "Add issuer"}
                  </Button>
                </div>
              </PanelRow>
            </>
          )}
          {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
        </div>
      )}
      {!state.can_manage && message && (
        <div className="px-5 py-3">
          <InlineMessage tone={message.tone}>{message.text}</InlineMessage>
        </div>
      )}
    </Panel>
  );
}
