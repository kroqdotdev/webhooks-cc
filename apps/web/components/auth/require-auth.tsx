"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { MfaChallenge, useNeedsSecondFactor } from "./mfa-challenge";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <SupabaseAuthProvider>
      <RequireAuthInner>{children}</RequireAuthInner>
    </SupabaseAuthProvider>
  );
}

function RequireAuthInner({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, session } = useAuth();
  const router = useRouter();
  // An account with an authenticator app finishes signing in here; the API
  // refuses its session until it has (lib/mfa.ts).
  const needsSecondFactor = useNeedsSecondFactor(
    session?.user.id ?? null,
    session?.access_token ?? null
  );
  // Who passed the code here: another account signed in from another tab
  // must pass its own.
  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Back to this page after signing in (the login page accepts only a
      // path on this site: lib/auth-redirect.ts), so a link to one request
      // still opens it.
      const here = `${window.location.pathname}${window.location.search}`;
      router.push(here === "/" ? "/login" : `/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading || (isAuthenticated && needsSecondFactor === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  if (needsSecondFactor && verifiedUserId !== (session?.user.id ?? null)) {
    return <MfaChallenge onVerified={() => setVerifiedUserId(session?.user.id ?? null)} />;
  }

  return <>{children}</>;
}
