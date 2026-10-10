"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
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
  const [agents, setAgents] = useState<ConnectedAgent[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const response = await fetch("/api/agent/registrations", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) setAgents((await response.json()) as ConnectedAgent[]);
    } catch {
      // silent: non-critical
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disconnect = async (id: string) => {
    if (!accessToken) return;
    setRevoking(id);
    try {
      const response = await fetch(`/api/agent/registrations/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) setAgents((previous) => previous.filter((agent) => agent.id !== id));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="space-y-4" id="connected-agents">
      <h2 className="text-lg font-semibold">Connected Agents</h2>
      <p className="text-sm text-muted-foreground">
        AI agents you connected with a code. They use the API on your behalf, but cannot change your
        API keys, billing or account.{" "}
        <Link href="/docs/agents" className="text-primary hover:underline font-bold">
          How agents connect
        </Link>
      </p>

      <div className="border rounded-lg bg-card divide-y" data-testid="connected-agents">
        {agents.length === 0 ? (
          <div className="p-6">
            <p className="text-sm text-muted-foreground">No agents connected.</p>
          </div>
        ) : (
          agents.map((agent) => {
            const name = agent.clientName ?? "Unnamed agent";
            return (
              <div key={agent.id} className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium truncate">{name}</p>
                  <p className="text-xs text-muted-foreground">
                    Connected {new Date(agent.connectedAt).toLocaleDateString()}
                    {agent.lastUsedAt &&
                      ` · Last used ${new Date(agent.lastUsedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={revoking === agent.id}
                      title="Disconnect agent"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect agent?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {name} loses access to your account immediately. Endpoints it created stay
                        in your account.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => disconnect(agent.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
