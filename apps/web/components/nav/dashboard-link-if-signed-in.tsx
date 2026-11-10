"use client";

import Link from "next/link";
import {
  SupabaseAuthProvider,
  useIsAuthenticated,
} from "@/components/providers/supabase-auth-provider";

/**
 * A Dashboard button for pages anyone can land on (the 404s), shown only to
 * someone signed in. It renders nothing on the server, so a prerendered page
 * stays the same at every URL and gains the button after hydration.
 */
export function DashboardLinkIfSignedIn({ className = "ui-btn-primary" }: { className?: string }) {
  return (
    <SupabaseAuthProvider>
      <Inner className={className} />
    </SupabaseAuthProvider>
  );
}

function Inner({ className }: { className: string }) {
  const isAuthenticated = useIsAuthenticated();
  if (!isAuthenticated) return null;
  return (
    <Link href="/dashboard" className={className}>
      Dashboard
    </Link>
  );
}
