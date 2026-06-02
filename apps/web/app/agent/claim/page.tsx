"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { getMaintenanceTopOffset } from "@/lib/announcements";

export default function AgentClaimPage() {
  return (
    <SupabaseAuthProvider>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center">
            <div className="animate-pulse text-muted-foreground">Loading...</div>
          </div>
        }
      >
        <AgentClaimContent />
      </Suspense>
    </SupabaseAuthProvider>
  );
}

function AgentClaimContent() {
  const { isAuthenticated, isLoading, session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const token = searchParams.get("token");
  const clientName = searchParams.get("client_name") ?? searchParams.get("name");
  // Allow prefilling the code from the URL too (e.g. ?code=ABCD-EFGH).
  const initialCode = searchParams.get("code") ?? "";

  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(initialCode);

  // When there is no claim_token in the URL, fall back to the human-typed
  // code-entry path (a person reads the short code off the agent's output).
  const usingCode = !token;

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Preserve the claim token (and any other query params) across login.
      const here = "/agent/claim" + window.location.search;
      router.push(`/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router]);

  const handleConfirm = async () => {
    const trimmedCode = code.trim();
    if (!token && !trimmedCode) {
      setStatus("error");
      setError("Enter the claim code shown by your agent, or open its claim link again.");
      return;
    }

    const accessToken = session?.access_token;
    if (!accessToken) {
      setStatus("error");
      setError("Your session expired. Please sign in again.");
      return;
    }

    setStatus("submitting");
    setError(null);

    try {
      const response = await fetch("/api/agent/auth/claim/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        // Send the claim_token when present (link path); otherwise the
        // human-typed user_code (code-entry path).
        body: JSON.stringify(token ? { claim_token: token } : { user_code: trimmedCode }),
      });

      const result = (await response.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
      };

      if (!response.ok) {
        if (response.status === 410) {
          throw new Error("This claim code has expired");
        }
        if (response.status === 409) {
          throw new Error("This credential was already claimed");
        }
        if (result.error === "invalid_claim_token") {
          throw new Error(
            usingCode
              ? "That claim code was not found. Check the code and try again."
              : "This claim link is invalid"
          );
        }
        throw new Error(result.error || "Failed to claim agent credential");
      }

      setStatus("success");
    } catch (err) {
      setStatus("error");
      const message = err instanceof Error ? err.message : "Failed to claim agent credential";
      setError(message);
    }
  };

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <nav
        className="fixed left-4 right-4 z-50"
        style={{ top: `calc(${getMaintenanceTopOffset()} + var(--ann-h, 0px))` }}
      >
        <div className="max-w-6xl mx-auto border-2 border-foreground bg-background shadow-neo">
          <div className="px-6 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl tracking-tight">
              webhooks.cc
            </Link>
            <div className="flex items-center gap-6">
              <ThemeToggle />
              <Link
                href="/dashboard"
                className="neo-btn-outline text-sm py-2 px-4 w-28 text-center"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-24">
        <div className="w-full max-w-sm">
          {status === "success" ? (
            <div className="text-center">
              <div className="text-4xl mb-4">&#10003;</div>
              <h1 className="text-2xl font-bold mb-2">Agent Claimed</h1>
              <p className="text-muted-foreground mb-4">
                Agent credential claimed; it is now attached to your account.
              </p>
              <Link
                href="/account"
                className="neo-btn-outline text-sm py-2 px-4 inline-block text-center"
              >
                View API keys
              </Link>
            </div>
          ) : (
            <>
              <div className="text-center mb-8">
                <h1 className="text-2xl font-bold mb-2">Claim Agent Credential</h1>
                <p className="text-muted-foreground">
                  {clientName
                    ? `Attach the credential for ${clientName} to your account.`
                    : usingCode
                      ? "Enter the claim code shown by your agent to attach its credential to your account."
                      : "Attach this agent credential to your account."}
                </p>
              </div>

              {error && (
                <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded mb-4">
                  {error}
                </div>
              )}

              {usingCode && (
                <label className="block mb-4">
                  <span className="text-sm font-medium">Claim code</span>
                  <input
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="ABCD-EFGH"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && code.trim() && status !== "submitting") {
                        handleConfirm();
                      }
                    }}
                    className="mt-1 w-full h-12 border-2 border-foreground bg-background px-3 text-center text-lg font-mono tracking-widest uppercase"
                  />
                </label>
              )}

              <Button
                type="button"
                onClick={handleConfirm}
                className="w-full h-12 text-base"
                disabled={(usingCode ? !code.trim() : !token) || status === "submitting"}
              >
                {status === "submitting" ? (
                  <span className="animate-pulse">Claiming...</span>
                ) : (
                  "Confirm & Claim"
                )}
              </Button>

              <p className="text-center text-sm text-muted-foreground mt-6">
                Claiming binds this agent&apos;s API key to your account so you can manage and
                revoke it.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
