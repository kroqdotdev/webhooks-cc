"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { trackCTAClick } from "@/lib/analytics";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

export function HeroCTA() {
  return (
    <SupabaseAuthProvider>
      <HeroCTAInner />
    </SupabaseAuthProvider>
  );
}

function HeroCTAInner() {
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {isLoading ? (
          <div className="h-11" />
        ) : isAuthenticated ? (
          <Link href="/dashboard" className="neo-btn-primary">
            Go to Dashboard
            <ArrowRight className="inline-block ml-2 h-5 w-5" />
          </Link>
        ) : (
          <OAuthSignInButtons
            redirectTo="/dashboard"
            layout="horizontal"
            buttonClassName="h-11 text-base px-5 neo-btn-outline cursor-pointer"
          />
        )}
      </div>
      {!isAuthenticated && !isLoading && (
        <p className="text-muted-foreground">
          or{" "}
          <Link
            href="/go"
            className="text-foreground font-bold hover:text-primary transition-colors"
            onClick={() => trackCTAClick("try_live")}
          >
            try without an account
            <ArrowRight className="inline-block ml-1 h-4 w-4" />
          </Link>
          {" · "}
          <Link
            href="#faq"
            className="text-foreground font-bold hover:text-primary transition-colors"
            onClick={() => trackCTAClick("faq")}
          >
            FAQ
          </Link>
          {" · "}
          <Link
            href="/docs"
            className="text-foreground font-bold hover:text-primary transition-colors"
            onClick={() => trackCTAClick("docs")}
          >
            Docs
          </Link>
        </p>
      )}
    </div>
  );
}
