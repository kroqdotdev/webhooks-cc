"use client";

import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ConvexAuthProvider } from "@/components/providers/convex-auth-provider";

export default function CliVerifyPage() {
  return (
    <ConvexAuthProvider>
      <CliVerifyContent />
    </ConvexAuthProvider>
  );
}

function CliVerifyContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const authorize = useMutation(api.deviceAuth.authorizeDeviceCode);

  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push(`/login?redirect=${encodeURIComponent("/cli/verify")}`);
    }
  }, [isAuthenticated, isLoading, router]);

  const formatCode = (value: string) => {
    // Allow typing with auto-formatting to XXXX-XXXX
    const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleaned.length <= 4) return cleaned;
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      const result = await authorize({ userCode: code });
      setStatus("success");
      setEmail(result.email ?? null);
    } catch (err) {
      setStatus("error");
      const message = err instanceof Error ? err.message : "Authorization failed";
      // Clean up Convex error prefix
      setError(message.replace(/^Uncaught Error:\s*/, ""));
    }
  };

  if (isLoading || !isAuthenticated) {
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
              <ThemeToggle />
              <Link
                href="/dashboard"
                className="neo-btn-outline text-sm py-2 px-4 w-28 text-center"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-24">
        <div className="w-full max-w-sm">
          {status === "success" ? (
            <div className="text-center">
              <div className="text-4xl mb-4">&#10003;</div>
              <h1 className="text-2xl font-bold mb-2">CLI Authorized</h1>
              <p className="text-muted-foreground mb-4">
                {email
                  ? `Signed in as ${email}. You can return to your terminal.`
                  : "You can return to your terminal."}
              </p>
              <p className="text-sm text-muted-foreground">You can close this page.</p>
            </div>
          ) : (
            <>
              <div className="text-center mb-8">
                <h1 className="text-2xl font-bold mb-2">Authorize CLI</h1>
                <p className="text-muted-foreground">Enter the code shown in your terminal</p>
              </div>

              {error && (
                <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded mb-4">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(formatCode(e.target.value))}
                  placeholder="XXXX-XXXX"
                  className="w-full text-center text-2xl tracking-[0.3em] font-mono px-4 py-3 border-2 border-foreground bg-background focus:outline-none focus:ring-2 focus:ring-foreground/20"
                  maxLength={9}
                  autoFocus
                  disabled={status === "submitting"}
                />
                <Button
                  type="submit"
                  className="w-full h-12 text-base"
                  disabled={code.length !== 9 || status === "submitting"}
                >
                  {status === "submitting" ? (
                    <span className="animate-pulse">Authorizing...</span>
                  ) : (
                    "Authorize"
                  )}
                </Button>
              </form>

              <p className="text-center text-sm text-muted-foreground mt-6">
                This code expires in 15 minutes.
                <br />
                Run <code className="font-mono bg-muted px-1 py-0.5 rounded">
                  whk auth login
                </code>{" "}
                to get a new code.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
