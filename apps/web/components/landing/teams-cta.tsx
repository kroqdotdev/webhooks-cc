"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { trackCTAClick } from "@/lib/analytics";
import {
  SupabaseAuthProvider,
  useIsAuthenticated,
} from "@/components/providers/supabase-auth-provider";

/** Sends visitors to the team page, through sign-in when they are signed out. */
export function TeamsCTA({ className = "inline-block" }: { className?: string }) {
  return (
    <SupabaseAuthProvider>
      <TeamsCTAInner className={className} />
    </SupabaseAuthProvider>
  );
}

function TeamsCTAInner({ className }: { className: string }) {
  const isAuthenticated = useIsAuthenticated();

  // Signed-out is the default branch so the CTA is part of the prerendered
  // HTML; authenticated visitors go straight to the team page.
  return (
    <Button
      variant="primary"
      className={className}
      render={
        <Link
          href={isAuthenticated ? "/teams" : "/login?redirect=/teams"}
          onClick={() => trackCTAClick("create_team")}
        />
      }
    >
      {isAuthenticated ? "Create a team" : "Sign up and create a team"}
      <ArrowRight className="inline-block ml-2 h-5 w-5" />
    </Button>
  );
}
