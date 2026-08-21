"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { EmailPasswordForm } from "@/components/auth/email-password-form";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { getMaintenanceTopOffset } from "@/lib/announcements";
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
    <div className="min-h-screen flex flex-col">
      <nav
        className="fixed left-4 right-4 z-50"
        style={{ top: `calc(${getMaintenanceTopOffset()} + var(--ann-h, 0px))` }}
      >
        <div className="max-w-6xl mx-auto border-2 border-foreground bg-background shadow-neo">
          <div className="px-6 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl tracking-tight">
              webhooks.cc
            </Link>
            <div className="flex items-center gap-6">
              <Link
                href="/docs"
                className="hidden sm:inline text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Docs
              </Link>
              <Link
                href="/installation"
                className="hidden sm:inline text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Install
              </Link>
              <ThemeToggle />
              <Link href="/" className="neo-btn-outline text-sm py-2 px-4 text-center">
                Home
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-24">
        <div className="w-full max-w-sm">
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

          <EmailPasswordForm />

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
        </div>
      </main>
    </div>
  );
}
