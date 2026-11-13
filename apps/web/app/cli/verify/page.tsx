"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SiteHeader } from "@/components/nav/site-header";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { MfaGate } from "@/components/auth/mfa-challenge";
import { trackCliDeviceAuthorized } from "@/lib/analytics";
import { networkNotice } from "@/lib/device-login-notice";

// The page a device login is approved on. `whk auth login` opens it with the
// code in the address (?code=), so nobody types it: the person compares it
// with the terminal instead, and sees which client asked, from where, and
// whether from this browser's network. A click alone is not enough, because
// a link that approves on one click is what device-code phishing sends.

export default function CliVerifyPage() {
  return (
    <SupabaseAuthProvider>
      <MfaGate>
        <Suspense fallback={<Loading />}>
          <CliVerifyContent />
        </Suspense>
      </MfaGate>
    </SupabaseAuthProvider>
  );
}

interface LoginRequest {
  userCode: string;
  client: string | null;
  country: string | null;
  remote: boolean;
  network: "same" | "different" | "unknown";
  createdAt: number;
  expiresAt: number;
}

type Phase =
  | { kind: "enter" }
  | { kind: "loading" }
  | { kind: "review"; login: LoginRequest }
  | { kind: "approved"; email: string | null }
  | { kind: "denied" }
  | { kind: "gone"; message: string }
  | { kind: "failed"; message: string };

const CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** XXXX-XXXX from whatever was typed or pasted. */
function formatCode(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length <= 4 ? cleaned : `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

function CliVerifyContent() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const codeInUrl = formatCode(searchParams.get("code") ?? "");
  const code = CODE_PATTERN.test(codeInUrl) ? codeInUrl : null;

  const [phase, setPhase] = useState<Phase>(code ? { kind: "loading" } : { kind: "enter" });
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const here = code ? `/cli/verify?code=${encodeURIComponent(code)}` : "/cli/verify";
      router.push(`/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router, code]);

  const load = useCallback(async (userCode: string) => {
    setPhase({ kind: "loading" });
    setProblem(null);
    try {
      const response = await fetch(`/api/auth/device-request?code=${encodeURIComponent(userCode)}`);
      const result = (await response.json()) as LoginRequest & { error?: string };
      if (response.status === 404) {
        setPhase({ kind: "gone", message: result.error ?? "This code has expired." });
      } else if (!response.ok) {
        // A rate limit or a failure on our side: the code may still be good.
        setPhase({ kind: "failed", message: result.error ?? "This login could not be loaded." });
      } else {
        setPhase({ kind: "review", login: result });
      }
    } catch {
      setPhase({ kind: "failed", message: "This login could not be loaded." });
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (code) void load(code);
    else setPhase({ kind: "enter" });
  }, [isAuthenticated, code, load]);

  const decide = async (userCode: string, approve: boolean) => {
    setSubmitting(true);
    setProblem(null);
    try {
      const response = await fetch(
        approve ? "/api/auth/device-authorize" : "/api/auth/device-deny",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userCode }),
        }
      );
      const result = (await response.json()) as { email?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "That did not work. Try again.");
      if (approve) {
        trackCliDeviceAuthorized();
        setPhase({ kind: "approved", email: result.email ?? null });
      } else {
        setPhase({ kind: "denied" });
      }
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading || !isAuthenticated) return <Loading />;

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 flex items-center justify-center px-4 pt-10 pb-12">
        <div className="w-full max-w-md" data-testid="cli-verify">
          {phase.kind === "loading" && <Loading inline />}

          {phase.kind === "enter" && (
            <EnterCode
              onSubmit={(entered) =>
                router.replace(`/cli/verify?code=${encodeURIComponent(entered)}`)
              }
            />
          )}

          {phase.kind === "review" && (
            <Review
              login={phase.login}
              email={user?.email ?? null}
              problem={problem}
              submitting={submitting}
              onApprove={() => void decide(phase.login.userCode, true)}
              onDeny={() => void decide(phase.login.userCode, false)}
            />
          )}

          {phase.kind === "approved" && (
            <Notice title="Login approved">
              {phase.email
                ? `The terminal is signed in as ${phase.email}. You can close this page.`
                : "The terminal is signed in. You can close this page."}{" "}
              If that was a mistake, revoke its key under{" "}
              <Link href="/account/api-keys" className="text-primary underline">
                API keys
              </Link>
              .
            </Notice>
          )}

          {phase.kind === "failed" && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">Something went wrong</h1>
              <p className="text-muted-foreground mb-6">{phase.message} The code may still work.</p>
              <Button variant="surface" onClick={() => code && void load(code)}>
                Try again
              </Button>
            </div>
          )}

          {phase.kind === "denied" && (
            <Notice title="Login refused">
              The terminal that asked gets nothing, and its code no longer works. If you did not
              start this login, someone may have sent you the link: you can ignore it.
            </Notice>
          )}

          {phase.kind === "gone" && (
            <Notice title="This code no longer works">
              {phase.message} Run <code className="font-mono">whk auth login</code> again for a new
              one.
            </Notice>
          )}
        </div>
      </main>
    </div>
  );
}

function Loading({ inline = false }: { inline?: boolean }) {
  return (
    <div
      className={`${inline ? "py-16" : "min-h-screen"} flex items-center justify-center text-muted-foreground`}
    >
      <span className="animate-pulse">Loading...</span>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold mb-3">{title}</h1>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}

function EnterCode({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (CODE_PATTERN.test(value)) onSubmit(value);
      }}
    >
      <h1 className="text-2xl font-bold mb-2 text-center">Approve a CLI login</h1>
      <p className="text-muted-foreground mb-6 text-center">
        Enter the code your terminal shows. Newer versions of whk open this page with the code
        already in it.
      </p>
      <label htmlFor="device-code" className="sr-only">
        Code
      </label>
      <Input
        id="device-code"
        value={value}
        onChange={(e) => setValue(formatCode(e.target.value))}
        placeholder="XXXX-XXXX"
        className="h-14 text-center text-2xl tracking-[0.3em] font-mono mb-4"
        maxLength={9}
        autoComplete="off"
        autoFocus
      />
      <Button type="submit" className="w-full h-12 text-base" disabled={!CODE_PATTERN.test(value)}>
        Continue
      </Button>
    </form>
  );
}

function countryName(code: string): string {
  if (code === "T1") return "the Tor network";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function place(login: LoginRequest): string {
  if (!login.country) return "Unknown";
  return countryName(login.country);
}

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Less than a minute ago";
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

function Review(props: {
  login: LoginRequest;
  email: string | null;
  problem: string | null;
  submitting: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { login } = props;
  const notice = networkNotice(login.network, login.remote);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-center">Approve a CLI login</h1>
      <p className="text-muted-foreground mb-6 text-center">
        A terminal asks to sign in to webhooks.cc
        {props.email ? (
          <>
            {" "}
            as <span className="font-mono text-foreground">{props.email}</span>
          </>
        ) : null}
        .
      </p>

      <div className="text-center mb-6">
        <p
          className="font-mono text-4xl sm:text-5xl font-semibold tracking-[0.12em] text-foreground"
          data-testid="device-code"
        >
          {login.userCode}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Is this the code in your terminal? Approve only if it matches.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          If you did not just run <code className="font-mono">whk auth login</code> yourself, choose
          This wasn&apos;t me.
        </p>
      </div>

      <Card className="p-4 mb-4 space-y-2 text-sm" render={<dl />}>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Client</dt>
          <dd className="text-right">
            <span className="break-all">{login.client ?? "Not given"}</span>
            <span className="block text-xs text-muted-foreground">as it describes itself</span>
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">From</dt>
          <dd className="text-right">{place(login)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Asked</dt>
          <dd className="text-right">{ago(login.createdAt)}</dd>
        </div>
      </Card>

      {notice && (
        <div
          className={
            notice.level === "warning"
              ? "text-sm text-destructive-ink bg-destructive/10 border border-destructive/40 rounded-md p-3 mb-4"
              : "text-sm border rounded-md p-3 mb-4"
          }
          role={notice.level === "warning" ? "alert" : "note"}
        >
          {notice.text}
        </div>
      )}

      <p className="text-sm text-muted-foreground mb-6">
        Approving gives that terminal an API key with access to your account for 90 days. You can
        revoke it under API keys in your account.
      </p>

      {props.problem && (
        <div
          className="text-sm text-destructive-ink bg-destructive/10 border border-destructive/40 rounded-md p-3 mb-4"
          role="alert"
        >
          {props.problem}
        </div>
      )}

      <div className="grid gap-3">
        <Button
          className="w-full h-12 text-base"
          disabled={props.submitting}
          onClick={props.onApprove}
        >
          Approve login
        </Button>
        <Button
          variant="surface"
          className="w-full h-11 text-sm"
          disabled={props.submitting}
          onClick={props.onDeny}
        >
          This wasn&apos;t me
        </Button>
      </div>
    </div>
  );
}
