"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { identifyUser, trackAccountCreated } from "@/lib/analytics";

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

/** A fresh account reaches its first authenticated page within a few minutes of
 * being created; identifyUser has just run, so the event lands on the person
 * PostHog already knows as the anonymous visitor. Keyed per user id so it
 * cannot fire twice in the same browser. */
const SIGNUP_WINDOW_MS = 10 * 60 * 1000;

function trackSignupOnce(user: {
  id: string;
  created_at?: string;
  app_metadata?: { provider?: string };
}) {
  const createdAt = user.created_at ? Date.parse(user.created_at) : NaN;
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > SIGNUP_WINDOW_MS) return;
  const key = `account-created-tracked:${user.id}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    // Blocked storage: better a possible duplicate than a missing signup.
  }
  trackAccountCreated(user.app_metadata?.provider);
}
