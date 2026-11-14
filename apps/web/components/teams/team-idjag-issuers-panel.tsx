"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * Each member connects their own agent here: Connect opens a 10-minute
 * window in which the first sign-in from the issuer with the member's email
 * connects at once; the row then shows the agent and a Disconnect button.
 * While a window is open the panel reads the list again every few seconds.
 */

interface Connection {
  id: string;
  client_name: string | null;
  connected_at: string;
}

interface IssuerRow {
  id: string;
  issuer: string;
  allowed_client_ids: string[];
  created_at: string;
  connect?: { window_expires_at: string | null; connections: Connection[] };
}

interface IssuersState {
  issuers: IssuerRow[];
  prefixes: string[];
  max_issuers: number;
  connect_window_seconds?: number;
  can_manage: boolean;
}

const POLL_MS = 4000;

function hostOf(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
  const [rowMessage, setRowMessage] = useState<{
    id: string;
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const waitingRef = useRef<Set<string>>(new Set());

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

  const windowOpen = (state?.issuers ?? []).some(
    (row) => row.connect?.window_expires_at && Date.parse(row.connect.window_expires_at) > now
  );

  // While a window is open: tick the countdown and read the list again, so
  // the row turns to Connected when the agent signs in.
  useEffect(() => {
    if (!windowOpen) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      load().catch(() => {});
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [windowOpen, load]);

  // A window that ends with a new connection says so once.
  useEffect(() => {
    for (const row of state?.issuers ?? []) {
      const open =
        row.connect?.window_expires_at && Date.parse(row.connect.window_expires_at) > Date.now();
      if (open) {
        waitingRef.current.add(row.id);
      } else if (waitingRef.current.has(row.id)) {
        waitingRef.current.delete(row.id);
        const connected = (row.connect?.connections.length ?? 0) > 0;
        setRowMessage({
          id: row.id,
          tone: connected ? "success" : "error",
          text: connected
            ? "Connected."
            : "The window closed before an agent signed in. Choose Connect to try again.",
        });
      }
    }
  }, [state]);

  if (!state) return null;

  async function connect(row: IssuerRow) {
    if (!accessToken) return;
    setBusy(true);
    setRowMessage(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(row.id)}/connect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        setRowMessage({
          id: row.id,
          tone: "error",
          text: await errorText(res, "Could not open the connection window."),
        });
        return;
      }
      // `now` is older than the new window's end, so the countdown starts.
      await load();
    } catch {
      setRowMessage({ id: row.id, tone: "error", text: "Could not open the connection window." });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(row: IssuerRow) {
    if (!accessToken) return;
    setBusy(true);
    setRowMessage(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(row.id)}/connect`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        setRowMessage({
          id: row.id,
          tone: "error",
          text: await errorText(res, "Could not disconnect."),
        });
        return;
      }
      waitingRef.current.delete(row.id);
      setRowMessage({ id: row.id, tone: "success", text: "Disconnected." });
      await load();
    } catch {
      setRowMessage({ id: row.id, tone: "error", text: "Could not disconnect." });
    } finally {
      setBusy(false);
    }
  }

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
          the member&apos;s organisation sign-in. Each member chooses Connect below and then signs
          their agent in; removing the issuer, or leaving the team, disconnects every agent it
          connected.{" "}
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
                {row.connect && (
                  <MemberConnect
                    row={row}
                    now={now}
                    busy={busy}
                    windowMinutes={Math.round((state.connect_window_seconds ?? 600) / 60)}
                    onConnect={() => void connect(row)}
                    onDisconnect={() => void disconnect(row)}
                  />
                )}
                {rowMessage?.id === row.id && (
                  <div className="pt-1">
                    <InlineMessage tone={rowMessage.tone}>{rowMessage.text}</InlineMessage>
                  </div>
                )}
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

/** The signed-in member's own connection through one issuer. */
function MemberConnect({
  row,
  now,
  busy,
  windowMinutes,
  onConnect,
  onDisconnect,
}: {
  row: IssuerRow;
  now: number;
  busy: boolean;
  windowMinutes: number;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connect = row.connect!;
  const host = hostOf(row.issuer);
  const expiresAt = connect.window_expires_at ? Date.parse(connect.window_expires_at) : 0;
  const open = expiresAt > now;
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="space-y-2 pt-2">
      {connect.connections.map((connection) => (
        <div key={connection.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
            <span>
              Connected:{" "}
              <span className="font-medium break-all">
                {connection.client_name ?? "Unnamed agent"}
              </span>
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            since {longDate(connection.connected_at)}
          </span>
        </div>
      ))}

      {open ? (
        <p className="text-sm" role="status" aria-live="polite">
          Waiting for your agent to sign in through {host}, until{" "}
          {timeOf(connect.window_expires_at!)}{" "}
          <span className="font-mono text-xs text-muted-foreground tabular-nums">({left})</span>.
          Ask it to connect to webhooks.cc now.
        </p>
      ) : (
        connect.connections.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Connect, then ask your agent to connect to webhooks.cc within {windowMinutes} minutes.
            The first sign-in from {host} with your email connects it.
          </p>
        )
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!open && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onConnect}>
            {connect.connections.length > 0 ? "Connect another agent" : "Connect"}
          </Button>
        )}
        {(connect.connections.length > 0 || open) && (
          <AlertDialog>
            <AlertDialogTrigger render={<Button size="sm" variant="ghost" disabled={busy} />}>
              {connect.connections.length > 0 ? "Disconnect" : "Cancel"}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {connect.connections.length > 0
                    ? "Disconnect your agents?"
                    : "Close the connection window?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {connect.connections.length > 0
                    ? `Every agent you connected through ${host} is disconnected now, and its tokens stop working. You can connect again later.`
                    : "No agent connects through this window. You can open a new one later."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDisconnect}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {connect.connections.length > 0 ? "Disconnect" : "Close window"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
