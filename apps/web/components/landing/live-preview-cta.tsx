"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import {
  SupabaseAuthProvider,
  useIsAuthenticated,
} from "@/components/providers/supabase-auth-provider";

export function LivePreviewCTA() {
  return (
    <SupabaseAuthProvider>
      <LivePreviewCTAInner />
    </SupabaseAuthProvider>
  );
}

function LivePreviewCTAInner() {
  const isAuthenticated = useIsAuthenticated();

  // Signed-out is the default branch so the CTA is part of the prerendered
  // HTML; authenticated visitors see it swap to the dashboard link.
  return (
    <div className="flex flex-col items-center gap-3 pt-2">
      {isAuthenticated ? (
        <Link href="/dashboard" className="neo-btn-primary">
          Go to Dashboard
          <ArrowRight className="inline-block ml-2 h-5 w-5" />
        </Link>
      ) : (
        <>
          <OAuthSignInButtons
            redirectTo="/dashboard"
            layout="horizontal"
            buttonClassName="h-11 text-base px-5 neo-btn-outline cursor-pointer"
          />
          <p className="text-sm text-muted-foreground">
            or{" "}
            <Link
              href="/go"
              className="text-foreground font-bold hover:text-primary transition-colors"
            >
              try without an account
              <ArrowRight className="inline-block ml-1 h-3.5 w-3.5" />
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
