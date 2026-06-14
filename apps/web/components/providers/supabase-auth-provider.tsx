"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User, Session } from "@supabase/supabase-js";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

// Module-level auth store shared by every useAuth() consumer. Pages mount
// several auth-aware CTAs at once; a single getSession() call and a single
// onAuthStateChange subscription serve all of them for the app's lifetime.
const INITIAL_STATE: AuthContextValue = {
  user: null,
  session: null,
  isLoading: true,
  isAuthenticated: false,
};

let authState: AuthContextValue = INITIAL_STATE;
const storeListeners = new Set<() => void>();
let authListenerStarted = false;

function setAuthSession(session: Session | null) {
  authState = {
    session,
    user: session?.user ?? null,
    isLoading: false,
    isAuthenticated: !!session?.user,
  };
  storeListeners.forEach((listener) => listener());
}

function startAuthListener() {
  if (authListenerStarted || typeof window === "undefined") return;
  authListenerStarted = true;

  const supabase = createClient();

  // Get initial session
  supabase.auth.getSession().then(({ data: { session } }) => {
    setAuthSession(session);
  });

  // Listen for auth state changes (login, logout, token refresh).
  // Intentionally never unsubscribed: the store outlives any one component.
  supabase.auth.onAuthStateChange((_event, session) => {
    setAuthSession(session);
  });
}

function subscribe(listener: () => void) {
  startAuthListener();
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getSnapshot(): AuthContextValue {
  return authState;
}

function getServerSnapshot(): AuthContextValue {
  return INITIAL_STATE;
}

/**
 * Kept for API compatibility — auth state now lives in a module-level store,
 * so this wrapper no longer provides anything. useAuth() works anywhere.
 */
export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useAuth(): AuthContextValue {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Boolean-only selector for consumers that just need isAuthenticated — e.g. the
 * marketing CTAs mounted several-per-page. The snapshot is a primitive, so
 * useSyncExternalStore skips re-rendering on auth events that don't flip the
 * boolean (token refresh, focus-triggered revalidation).
 */
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => authState.isAuthenticated,
    () => false
  );
}
