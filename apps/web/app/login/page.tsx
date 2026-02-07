"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { useConvexAuth } from "convex/react";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawRedirect = searchParams.get("redirect");
  const redirectTo =
    rawRedirect && rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")
      ? rawRedirect
      : "/dashboard";

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(redirectTo);
    }
  }, [isAuthenticated, isLoading, router, redirectTo]);

  if (isLoading || isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="fixed top-4 left-4 right-4 z-50">
        <div className="max-w-6xl mx-auto border-2 border-foreground bg-background shadow-neo">
          <div className="px-6 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl tracking-tight">
              webhooks.cc
            </Link>
            <div className="flex items-center gap-6">
              <Link
                href="/docs"
                className="text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Docs
              </Link>
              <Link
                href="/installation"
                className="text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Install
              </Link>
              <ThemeToggle />
              <Link href="/" className="neo-btn-outline text-sm py-2 px-4 w-28 text-center">
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
            <p className="text-muted-foreground">Continue with your preferred provider</p>
          </div>

          <OAuthSignInButtons redirectTo={redirectTo} />

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
