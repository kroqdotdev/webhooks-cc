"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { ApiKeyDialog } from "@/components/account/api-key-dialog";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  InlineMessage,
  Panel,
  SettingsPageHeader,
  settingsLink,
} from "@/components/settings/panel";
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

interface ApiKeyEntry {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export default function ApiKeysPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [keys, setKeys] = useState<ApiKeyEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Taken when the keys load, so expiry is judged against the same moment on every render.
  const [nowMs, setNowMs] = useState(0);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await fetch("/api/api-keys", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setKeys((await res.json()) as ApiKeyEntry[]);
      setNowMs(Date.now());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (key: ApiKeyEntry) => {
    if (!accessToken) return;
    setDeletingId(key.id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/api-keys?id=${encodeURIComponent(key.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        setDeleteError(`${key.name} was not deleted. Try again.`);
        return;
      }
      setKeys((previous) => previous?.filter((k) => k.id !== key.id) ?? previous);
    } catch {
      setDeleteError(`${key.name} was not deleted. Check your connection.`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <SettingsPageHeader
        title="API keys"
        description={
          <>
            Keys let the{" "}
            <Link href="/docs/cli" className={settingsLink}>
              CLI
            </Link>
            ,{" "}
            <Link href="/docs/sdk" className={settingsLink}>
              SDK
            </Link>
            ,{" "}
            <Link href="/docs/mcp" className={settingsLink}>
              MCP server
            </Link>{" "}
            and{" "}
            <Link href="/api-explorer" className={settingsLink}>
              API explorer
            </Link>{" "}
            act as you. A key is shown once, when you create it.
          </>
        }
        actions={<ApiKeyDialog accessToken={accessToken} onCreated={() => void refresh()} />}
      />

      <Panel id="keys" flush testId="api-keys">
        {keys === null && !loadError ? (
          <div role="status" aria-label="Loading keys" className="space-y-3 p-5">
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-3/4 rounded-md" />
          </div>
        ) : loadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-destructive">Your keys could not be loaded.</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : keys && keys.length === 0 ? (
          <div className="space-y-1 p-5">
            <p className="text-sm font-medium">No API keys yet</p>
            <p className="text-sm text-muted-foreground">
              Create one to sign in the CLI or call the API from your own code.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">Your API keys</caption>
              <thead>
                <tr className="border-b-strong border-line text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Key
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Last used
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="w-12 px-3 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys?.map((key) => {
                  const expiresMs = key.expires_at ? Date.parse(key.expires_at) : null;
                  const expired = expiresMs !== null && expiresMs <= nowMs;
                  return (
                    <tr key={key.id} className="border-b border-line/60 last:border-b-0">
                      <td className="max-w-[14rem] truncate px-5 py-3 font-medium">{key.name}</td>
                      <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                        {key.key_prefix}...
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">{shortDate(key.created_at)}</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {key.last_used_at ? (
                          shortDate(key.last_used_at)
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-3 whitespace-nowrap ${expired ? "text-destructive" : ""}`}
                      >
                        {key.expires_at ? (
                          expired ? (
                            "Expired"
                          ) : (
                            shortDate(key.expires_at)
                          )
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={deletingId === key.id}
                              title="Delete key"
                              aria-label={`Delete key ${key.name}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {key.name}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Anything using{" "}
                                <span className="font-mono font-medium">{key.key_prefix}...</span>{" "}
                                stops working at once. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep key</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => void handleDelete(key)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete key
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {deleteError && (
          <div className="border-t-strong border-line px-5 py-3">
            <InlineMessage tone="error">{deleteError}</InlineMessage>
          </div>
        )}
      </Panel>
    </>
  );
}
