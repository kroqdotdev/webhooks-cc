"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiKeyDialog } from "@/components/account/api-key-dialog";
import { DeleteAccountDialog } from "@/components/account/delete-account-dialog";
import { ManageSubscriptionDialog } from "@/components/billing/manage-subscription-dialog";
import { PastDueBanner } from "@/components/billing/past-due-banner";
import { UpgradeButton } from "@/components/billing/upgrade-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ACCOUNT_PROFILE_SELECT, type AccountProfile } from "@/lib/account-profile";
import { trackUpgradeCompleted, identifyUser } from "@/lib/analytics";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { createClient } from "@/lib/supabase/client";
import { subscribeToUserRow } from "@/lib/supabase/realtime";
import { CheckCircle, Trash2 } from "lucide-react";
import { GitHubIcon } from "@/components/ui/icons";
import Link from "next/link";
import { APP_VERSION } from "@/lib/changelog";

interface ApiKeyEntry {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

function UsageResetCountdown({ periodEnd }: { periodEnd: string }) {
  const [timeRemaining, setTimeRemaining] = useState<string>("");

  useEffect(() => {
    const update = () => {
      const remaining = new Date(periodEnd).getTime() - Date.now();
      if (remaining <= 0) {
        setTimeRemaining("New 24h period starts on next request");
        return;
      }
      if (remaining < 60_000) {
        setTimeRemaining("Resets in <1m");
        return;
      }
      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      setTimeRemaining(`Resets in ${hours}h ${minutes}m`);
    };
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [periodEnd]);

  return <span>{timeRemaining}</span>;
}

function UpgradeSuccessBanner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (searchParams.get("upgraded") === "true") {
      setShow(true);
      trackUpgradeCompleted();
      const url = new URL(window.location.href);
      url.searchParams.delete("upgraded");
      router.replace(url.pathname, { scroll: false });
    }
  }, [searchParams, router]);

  if (!show) return null;

  return (
    <div className="rounded-md border border-green-500/20 bg-green-500/10 p-4 mb-4">
      <div className="flex items-center gap-3">
        <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-green-500">Welcome to Pro!</p>
          <p className="text-sm text-muted-foreground">
            Your subscription is now active. Enjoy 100K requests/month and 30-day data retention.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShow(false)} className="ml-auto">
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { user: authUser, session, isLoading: authLoading } = useAuth();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

  const refreshProfile = useCallback(async () => {
    if (!authUser) {
      setProfile(null);
      setProfileLoading(false);
      return;
    }

    const supabase = createClient();
    const { data, error } = await supabase
      .from("users")
      .select(ACCOUNT_PROFILE_SELECT)
      .eq("id", authUser.id)
      .single<AccountProfile>();

    if (error) {
      console.error("Failed to fetch user profile:", error);
    }

    setProfile(data ?? null);
    setProfileLoading(false);

    if (data) {
      identifyUser(authUser.id, {
        email: authUser.email ?? undefined,
        plan: data.plan,
        request_limit: data.request_limit,
      });
    }
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setProfile(null);
      setProfileLoading(false);
      return;
    }

    setProfileLoading(true);
    void refreshProfile();
  }, [authUser, refreshProfile]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    return subscribeToUserRow(authUser.id, (row) => {
      setProfile(row ? (row as AccountProfile) : null);
      setProfileLoading(false);
    });
  }, [authUser]);

  const refreshApiKeys = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const response = await fetch("/api/api-keys", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (response.ok) {
        setApiKeys((await response.json()) as ApiKeyEntry[]);
      }
    } catch {
      // silent — non-critical
    }
  }, [session?.access_token]);

  useEffect(() => {
    void refreshApiKeys();
  }, [refreshApiKeys]);

  const handleDeleteKey = async (keyId: string) => {
    if (!session?.access_token) return;
    setDeletingKeyId(keyId);
    try {
      await fetch(`/api/api-keys?id=${keyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
    } catch {
      // silent
    } finally {
      setDeletingKeyId(null);
    }
  };

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  if (authLoading || profileLoading) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <p className="text-muted-foreground">User not found</p>
      </main>
    );
  }

  const providers =
    authUser?.identities?.map((identity) => identity.provider).filter(Boolean) ?? [];

  const periodEndMs = profile.period_end ? Date.parse(profile.period_end) : NaN;
  const freePeriodExpired =
    profile.plan === "free" && Number.isFinite(periodEndMs) && periodEndMs <= nowMs;
  const displayedRequestsUsed = freePeriodExpired ? 0 : profile.requests_used;
  const usagePercent =
    profile.request_limit > 0
      ? Math.min((displayedRequestsUsed / profile.request_limit) * 100, 100)
      : 0;
  const isNearLimit = usagePercent > 80;
  const accessToken = session?.access_token ?? null;

  return (
    <main className="container mx-auto px-4 py-8 max-w-2xl space-y-8">
      <Suspense fallback={null}>
        <UpgradeSuccessBanner />
      </Suspense>

      <PastDueBanner subscriptionStatus={profile.subscription_status} />

      <section className="space-y-4">
        <h1 className="text-2xl font-bold">Account</h1>

        <div className="border rounded-lg p-6 space-y-4 bg-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{profile.name || profile.email}</p>
              <p className="text-sm text-muted-foreground">{profile.email}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={profile.plan === "pro" ? "default" : "secondary"}>
                {profile.plan === "pro" ? "Pro" : "Free"}
              </Badge>
              {providers.map((provider) => (
                <Badge key={provider} variant="outline" className="capitalize">
                  {provider === "github" ? (
                    <span className="flex items-center gap-1">
                      <GitHubIcon className="h-3 w-3" />
                      GitHub
                    </span>
                  ) : provider === "google" ? (
                    <span className="flex items-center gap-1">
                      <svg className="h-3 w-3" viewBox="0 0 24 24">
                        <path
                          fill="currentColor"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="currentColor"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="currentColor"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="currentColor"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                      Google
                    </span>
                  ) : (
                    provider
                  )}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Billing & Usage</h2>

        <div className="border rounded-lg p-6 space-y-4 bg-card">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{profile.plan === "free" ? "Requests today" : "Requests this period"}</span>
              <span className={isNearLimit ? "text-destructive font-medium" : "font-medium"}>
                {displayedRequestsUsed.toLocaleString()} / {profile.request_limit.toLocaleString()}
              </span>
            </div>

            <div
              className="h-2 bg-muted rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={usagePercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Usage: ${displayedRequestsUsed.toLocaleString()} of ${profile.request_limit.toLocaleString()} requests`}
            >
              <div
                className={`h-full transition-all ${isNearLimit ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>

            {profile.period_end && (
              <p className="text-xs text-muted-foreground">
                {profile.plan === "free" ? (
                  <UsageResetCountdown periodEnd={profile.period_end} />
                ) : (
                  `Resets ${new Date(profile.period_end).toLocaleDateString()}`
                )}
              </p>
            )}
            {profile.plan === "free" && !profile.period_end && (
              <p className="text-xs text-muted-foreground">
                Your 24h period starts on first request
              </p>
            )}
          </div>

          {profile.plan === "free" ? (
            <div className="pt-2 border-t space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium">Free Plan</p>
                  <p className="text-sm text-muted-foreground">
                    50 requests/day, 7-day data retention
                  </p>
                </div>
                <UpgradeButton accessToken={accessToken} />
              </div>
              <p className="text-sm text-muted-foreground">
                Upgrade to Pro for 100,000 requests/month, 30-day data retention, and Teams
                ($8/month).
              </p>
            </div>
          ) : (
            <div className="pt-2 border-t space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Pro Plan</p>
                  <p className="text-sm text-muted-foreground">
                    100K requests/month, 30-day data retention
                  </p>
                </div>
                <p className="font-medium">$8/month</p>
              </div>
              <ManageSubscriptionDialog
                accessToken={accessToken}
                profile={profile}
                onUpdated={refreshProfile}
              />
              {profile.cancel_at_period_end && profile.period_end && (
                <div className="rounded-md bg-muted p-3 text-sm">
                  Your subscription will end on{" "}
                  {new Date(profile.period_end).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  . You&apos;ll be downgraded to the free tier after this date.
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">API Keys</h2>
          <ApiKeyDialog accessToken={accessToken} onCreated={refreshApiKeys} />
        </div>

        <p className="text-sm text-muted-foreground">
          Use API keys with the{" "}
          <Link href="/docs/cli" className="text-primary hover:underline font-bold">CLI</Link>,{" "}
          <Link href="/docs/sdk" className="text-primary hover:underline font-bold">SDK</Link>,{" "}
          <Link href="/docs/mcp" className="text-primary hover:underline font-bold">MCP server</Link>, or the{" "}
          <Link href="/api-explorer" className="text-primary hover:underline font-bold">API explorer</Link>.
        </p>

        <div className="border rounded-lg bg-card divide-y">
          {apiKeys.length === 0 ? (
            <div className="p-6">
              <p className="text-sm text-muted-foreground">
                No API keys yet. Create one to get started.
              </p>
            </div>
          ) : (
            apiKeys.map((key) => (
              <div key={key.id} className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium truncate">{key.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{key.key_prefix}...</p>
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(key.created_at).toLocaleDateString()}
                    {key.last_used_at &&
                      ` \u00b7 Last used ${new Date(key.last_used_at).toLocaleDateString()}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteKey(key.id)}
                  disabled={deletingKeyId === key.id}
                  title="Delete key"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
        <div className="border rounded-lg p-6 bg-card space-y-2">
          <p className="text-sm text-muted-foreground">
            Permanently delete your account and all captured request data.
          </p>
          <DeleteAccountDialog accessToken={accessToken} />
        </div>
      </section>

      <section className="flex justify-end">
        <Link href="/changelog" className="text-xs text-muted-foreground hover:text-foreground">
          v{APP_VERSION}
        </Link>
      </section>
    </main>
  );
}
