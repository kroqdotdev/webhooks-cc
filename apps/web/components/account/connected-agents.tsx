"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { InlineMessage, Panel } from "@/components/settings/panel";
import { Skeleton } from "@/components/ui/skeleton";
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
import { shortDate } from "@/components/settings/format";

interface ConnectedAgent {
  id: string;
  clientName: string | null;
  kind: "anonymous" | "service_auth" | "identity_assertion";
  connectedAt: number;
  lastUsedAt: number | null;
}

/**
 * Agents connected to the account through the auth.md claim ceremony, with
 * a one-click disconnect. Their tokens are not API keys and are not listed
 * with them.
 */
export function ConnectedAgents({ accessToken }: { accessToken: string | null }) {
  const [agents, setAgents] = useState<ConnectedAgent[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const response = await fetch("/api/agent/registrations", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        setAgents((await response.json()) as ConnectedAgent[]);
        setError(null);
      } else {
        setError("Your connected agents could not be loaded.");
      }
    } catch {
      setError("Your connected agents could not be loaded.");
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disconnect = async (agent: ConnectedAgent, name: string) => {
    if (!accessToken) return;
    setRevoking(agent.id);
    setError(null);
    try {
      const response = await fetch(`/api/agent/registrations/${agent.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        setAgents((previous) => previous?.filter((a) => a.id !== agent.id) ?? previous);
      } else {
        setError(`${name} is still connected. Try again.`);
      }
    } catch {
      setError(`${name} is still connected. Check your connection.`);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Panel id="connected-agents" flush testId="connected-agents">
      {agents === null ? (
        error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading agents" className="space-y-3 p-5">
            <Skeleton className="h-4 w-1/2 rounded-md" />
            <Skeleton className="h-4 w-1/3 rounded-md" />
          </div>
        )
      ) : agents.length === 0 ? (
        <div className="space-y-1 p-5">
          <p className="text-sm font-medium">No agents connected.</p>
          <p className="text-sm text-muted-foreground">
            When an agent asks you for a code, it shows up here once you approve it.
          </p>
        </div>
      ) : (
        <ul>
          {agents.map((agent) => {
            const name = agent.clientName ?? "Unnamed agent";
            return (
              <li
                key={agent.id}
                className="flex items-center justify-between gap-4 border-b border-line/60 px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">{name}</p>
                  <dl className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    <div className="flex gap-1">
                      <dt>Connected</dt>
                      <dd className="text-foreground">{shortDate(agent.connectedAt)}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>Last used</dt>
                      <dd className="text-foreground">
                        {agent.lastUsedAt ? shortDate(agent.lastUsedAt) : "Never"}
                      </dd>
                    </div>
                  </dl>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={revoking === agent.id}
                      title="Disconnect agent"
                      aria-label={`Disconnect agent ${name}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        It loses access to your account at once. Endpoints it created stay in your
                        account.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep connected</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void disconnect(agent, name)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            );
          })}
        </ul>
      )}
      {error && agents !== null && (
        <div className="border-t-strong border-line px-5 py-3">
          <InlineMessage tone="error">{error}</InlineMessage>
        </div>
      )}
    </Panel>
  );
}
