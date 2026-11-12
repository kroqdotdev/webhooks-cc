"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  SupabaseAuthProvider,
  useIsAuthenticated,
} from "@/components/providers/supabase-auth-provider";

/**
 * A Dashboard button for pages anyone can land on (the 404s), shown only to
 * someone signed in. It renders nothing on the server, so a prerendered page
 * stays the same at every URL and gains the button after hydration.
 */
export function DashboardLinkIfSignedIn() {
  return (
    <SupabaseAuthProvider>
      <Inner />
    </SupabaseAuthProvider>
  );
}

function Inner() {
  const isAuthenticated = useIsAuthenticated();
  if (!isAuthenticated) return null;
  return (
    <Button variant="primary" render={<Link href="/dashboard" />}>
      Dashboard
    </Button>
  );
}
