"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { EmailPasswordForm } from "@/components/auth/email-password-form";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { describeLoginError } from "@/lib/auth-errors";

export default function LoginPage() {
  return (
    <SupabaseAuthProvider>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center">
            <div className="animate-pulse text-muted-foreground">Loading...</div>
          </div>
        }
      >
        <LoginContent />
      </Suspense>
    </SupabaseAuthProvider>
  );
}

function LoginContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const rawRedirect = searchParams.get("redirect");
  const redirectTo =
    rawRedirect && rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")
      ? rawRedirect
      : "/dashboard";
  // Set by /auth/callback (OAuth errors) and /auth/confirm (bad email links).
  const urlError = describeLoginError(searchParams.get("error"));

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(redirectTo);
    }
  }, [isAuthenticated, isLoading, router, redirectTo]);

  if (!hasMounted || isLoading || isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <AuthPageShell>
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold mb-2">Sign in to webhooks.cc</h1>
        <p className="text-muted-foreground">Continue with GitHub, Google, or email</p>
      </div>

      {urlError ? (
        <div
          className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded mb-4"
          role="alert"
        >
          {urlError}
        </div>
      ) : null}

      <OAuthSignInButtons redirectTo={redirectTo} />

      <div className="flex items-center gap-3 my-6" aria-hidden="true">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <EmailPasswordForm redirectTo={redirectTo} />

      <p className="text-center text-sm text-muted-foreground mt-8">
        By signing in, you agree to our{" "}
        <Link href="/terms" className="underline hover:text-foreground">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline hover:text-foreground">
          Privacy Policy
        </Link>
      </p>
    </AuthPageShell>
  );
}
