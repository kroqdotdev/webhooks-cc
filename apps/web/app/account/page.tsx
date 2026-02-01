"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApiKeyDialog } from "@/components/account/api-key-dialog";
import Link from "next/link";
import { Trash2 } from "lucide-react";

export default function AccountPage() {
  const user = useQuery(api.users.current);
  const apiKeys = useQuery(api.apiKeys.list);
  const revokeApiKey = useMutation(api.apiKeys.revoke);

  if (user === undefined) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </main>
    );
  }

  if (user === null) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <p className="text-muted-foreground">User not found</p>
      </main>
    );
  }

  const usagePercent =
    user.requestLimit > 0 ? Math.min((user.requestsUsed / user.requestLimit) * 100, 100) : 0;

  const handleRevoke = async (id: Id<"apiKeys">) => {
    if (confirm("Are you sure you want to revoke this API key?")) {
      await revokeApiKey({ id });
    }
  };

  return (
    <main className="container mx-auto px-4 py-8 max-w-2xl space-y-8">
      {/* Account Info */}
      <section className="space-y-4">
        <h1 className="text-2xl font-bold">Account</h1>

        <div className="border rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{user.name || user.email}</p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
            <Badge variant={user.plan === "pro" ? "default" : "secondary"}>
              {user.plan === "pro" ? "Pro" : "Free"}
            </Badge>
          </div>
        </div>
      </section>

      {/* Usage */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Usage</h2>

        <div className="border rounded-lg p-6 space-y-4">
          <div className="flex justify-between text-sm">
            <span>Requests this period</span>
            <span className="font-medium">
              {user.requestsUsed.toLocaleString()} / {user.requestLimit.toLocaleString()}
            </span>
          </div>

          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${usagePercent}%` }}
            />
          </div>

          {user.plan === "free" && (
            <div className="pt-2">
              <Button asChild>
                <Link href="/upgrade">Upgrade to Pro</Link>
              </Button>
              <p className="text-sm text-muted-foreground mt-2">
                Get 500,000 requests/month and 30-day data retention
              </p>
            </div>
          )}
        </div>
      </section>

      {/* API Keys */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">API Keys</h2>
          <ApiKeyDialog />
        </div>

        <div className="border rounded-lg divide-y">
          {apiKeys === undefined ? (
            <div className="p-4 text-muted-foreground">Loading...</div>
          ) : apiKeys.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              <p>No API keys yet</p>
              <p className="text-sm mt-1">
                Create an API key to access webhooks.cc programmatically
              </p>
            </div>
          ) : (
            apiKeys.map((key) => (
              <div key={key._id} className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{key.name}</p>
                  <p className="text-sm text-muted-foreground font-mono">{key.keyPrefix}...</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt && (
                      <> &middot; Last used {new Date(key.lastUsedAt).toLocaleDateString()}</>
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRevoke(key._id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
