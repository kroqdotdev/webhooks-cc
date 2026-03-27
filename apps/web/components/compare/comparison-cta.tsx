"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

export function ComparisonCTA({ compact = false }: { compact?: boolean }) {
  return (
    <SupabaseAuthProvider>
      <ComparisonCTAInner compact={compact} />
    </SupabaseAuthProvider>
  );
}

function ComparisonCTAInner({ compact }: { compact: boolean }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (compact) {
    return (
      <div className="neo-card neo-card-static bg-card mb-10 flex flex-col sm:flex-row sm:items-center gap-4">
        <p className="font-bold shrink-0">Try it yourself</p>
        {isLoading ? (
          <div className="h-10" />
        ) : isAuthenticated ? (
          <Link href="/dashboard" className="neo-btn-primary text-sm">
            Go to Dashboard
            <ArrowRight className="inline-block ml-1.5 h-4 w-4" />
          </Link>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <OAuthSignInButtons
              redirectTo="/dashboard"
              layout="horizontal"
              buttonClassName="h-10 text-sm px-4 neo-btn-outline cursor-pointer"
            />
            <span className="text-sm text-muted-foreground">
              or{" "}
              <Link
                href="/go"
                className="text-foreground font-semibold hover:text-primary transition-colors"
              >
                try without an account
              </Link>
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="neo-card neo-card-static bg-card mt-12">
      <h2 className="text-2xl font-bold mb-2">Start testing webhooks in under a minute</h2>
      <p className="text-muted-foreground mb-5">
        Sign up with one click. No credit card, no setup wizard, no trial limits on core features.
      </p>

      {isLoading ? (
        <div className="h-12" />
      ) : isAuthenticated ? (
        <Link href="/dashboard" className="neo-btn-primary">
          Go to Dashboard
          <ArrowRight className="inline-block ml-2 h-5 w-5" />
        </Link>
      ) : (
        <div className="space-y-4">
          <OAuthSignInButtons
            redirectTo="/dashboard"
            layout="horizontal"
            buttonClassName="h-11 text-base px-5 neo-btn-outline cursor-pointer"
          />
          <p className="text-sm text-muted-foreground">
            or{" "}
            <Link
              href="/go"
              className="text-foreground font-semibold hover:text-primary transition-colors"
            >
              try without an account
              <ArrowRight className="inline-block ml-1 h-3.5 w-3.5" />
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}
