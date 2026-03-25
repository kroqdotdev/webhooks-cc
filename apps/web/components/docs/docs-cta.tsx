"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { trackCTAClick } from "@/lib/analytics";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

export function DocsCTA() {
  return (
    <SupabaseAuthProvider>
      <DocsCTAInner />
    </SupabaseAuthProvider>
  );
}

function DocsCTAInner() {
  const { isAuthenticated, isLoading } = useAuth();

  // Don't show CTA to authenticated users
  if (isLoading || isAuthenticated) return null;

  return (
    <div className="mt-16 pt-8 border-t-2 border-foreground">
      <div className="neo-card neo-card-static bg-muted">
        <p className="font-bold text-lg mb-1">Start testing webhooks</p>
        <p className="text-sm text-muted-foreground mb-4">
          Free account. 50 requests/day. CLI, SDK, and MCP included.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <OAuthSignInButtons
            redirectTo="/dashboard"
            layout="horizontal"
            buttonClassName="h-9 text-sm px-4 neo-btn-outline cursor-pointer"
          />
        </div>
        <p className="text-sm text-muted-foreground mt-3">
          or{" "}
          <Link
            href="/go"
            className="text-foreground font-bold hover:text-primary transition-colors"
            onClick={() => trackCTAClick("try_live")}
          >
            try without an account
            <ArrowRight className="inline-block ml-1 h-3.5 w-3.5" />
          </Link>
        </p>
      </div>
    </div>
  );
}
