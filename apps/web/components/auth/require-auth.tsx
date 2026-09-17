"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { identifyUser, trackAccountCreated } from "@/lib/analytics";
import { consumeSignupSignal } from "@/lib/signup-signal";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  return (
    <SupabaseAuthProvider>
      <RequireAuthInner>{children}</RequireAuthInner>
    </SupabaseAuthProvider>
  );
}

function RequireAuthInner({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (user) {
      identifyUser(user.id, {
        email: user.email ?? undefined,
      });
      trackSignupOnce(user);
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

/**
 * The auth routes leave a cookie behind when a sign-in created the account, so
 * an email confirmation opened hours later still counts. identifyUser has just
 * run, so the event lands on the person PostHog already knows as the anonymous
 * visitor. The stored key makes a second fire impossible in this browser.
 */
function trackSignupOnce(user: { id: string; app_metadata?: { provider?: string } }) {
  if (!consumeSignupSignal()) return;
  const key = `account-created-tracked:${user.id}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    // Blocked storage: better a possible duplicate than a missing signup.
  }
  trackAccountCreated(user.app_metadata?.provider);
}
