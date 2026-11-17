"use client";

import { PageLoading } from "@/components/page-loading";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  SupabaseAuthProvider,
  useAuth,
  useSessionChecked,
} from "@/components/providers/supabase-auth-provider";
import { MfaChallenge, useNeedsSecondFactor } from "./mfa-challenge";

/**
 * Where a signed-out visitor is sent: the login page, with the way back to
 * `here` only for someone who arrived signed out (a link to one request).
 */
export function loginPathFor(here: string, wasSignedIn: boolean): string {
  return here === "/" || wasSignedIn ? "/login" : `/login?redirect=${encodeURIComponent(here)}`;
}

/**
 * Whether this page counts as signed in, given whether it did before: once
 * a session is there and GoTrue has confirmed it on this load. A session
 * from the cookie that ended elsewhere is found out a moment after the page
 * opens, before that, so its visitor still gets the way back.
 */
export function signedInHere(
  before: boolean,
  isAuthenticated: boolean,
  sessionChecked: boolean
): boolean {
  return before || (isAuthenticated && sessionChecked);
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <SupabaseAuthProvider>
      <RequireAuthInner>{children}</RequireAuthInner>
    </SupabaseAuthProvider>
  );
}

function RequireAuthInner({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, session } = useAuth();
  const sessionChecked = useSessionChecked();
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

  // Whether this page was signed in: once the session ends in this tab
  // (a sign-out in another tab, a refused refresh), the login page does not
  // offer the way back. A session counts only once GoTrue has confirmed it
  // on this load: one from the cookie that ended elsewhere is found out a
  // moment after the page opens, and that visitor still gets the way back.
  const wasSignedIn = useRef(false);

  useEffect(() => {
    wasSignedIn.current = signedInHere(wasSignedIn.current, isAuthenticated, sessionChecked);
  }, [isAuthenticated, sessionChecked]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Arriving signed out, back to this page after signing in (the login
      // page accepts only a path on this site: lib/auth-redirect.ts), so a
      // link to one request still opens it.
      router.replace(
        loginPathFor(`${window.location.pathname}${window.location.search}`, wasSignedIn.current)
      );
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading || (isAuthenticated && needsSecondFactor === null)) {
    return <PageLoading />;
  }

  if (!isAuthenticated) {
    return null;
  }

  if (needsSecondFactor && verifiedUserId !== (session?.user.id ?? null)) {
    return <MfaChallenge onVerified={() => setVerifiedUserId(session?.user.id ?? null)} />;
  }

  return <>{children}</>;
}
