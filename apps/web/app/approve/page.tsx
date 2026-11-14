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
import { networkNotice } from "@/lib/device-login-notice";
import { startDrivePick } from "@/lib/dashboard-api";
import { DrivePickError, pickFromDrive } from "@/lib/integrations/drive-pick";

// The page an approval is answered on (lib/approvals): an agent or an API key
// asked for something only the account's owner may allow, and sent them here
// with the code in the address. As on /cli/verify, the person compares the
// code with what the asker showed them and sees who asked, from where; a
// click alone is not enough, because a link that approves on one click is
// what a phisher would send.

export default function ApprovePage() {
  return (
    <SupabaseAuthProvider>
      <MfaGate>
        <Suspense fallback={<Loading />}>
          <ApproveContent />
        </Suspense>
      </MfaGate>
    </SupabaseAuthProvider>
  );
}

interface Review {
  code: string;
  action: string;
  summary: string;
  details: { label: string; value: string }[];
  /** What the page needs to answer it (the connection a Drive pick is for). */
  page: Record<string, unknown> | null;
  requester: string;
  client: string | null;
  country: string | null;
  network: "same" | "different" | "unknown";
  createdAt: number;
  expiresAt: number;
}

type Phase =
  | { kind: "enter" }
  | { kind: "loading" }
  | { kind: "review"; review: Review }
  | { kind: "approved"; code: string }
  | { kind: "done"; summary: string }
  | { kind: "withdrawn" }
  | { kind: "collected" }
  | { kind: "denied" }
  | { kind: "gone"; message: string }
  | { kind: "failed"; message: string };

const CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Back from Google with a connection that did not finish: what to say. */
const GOOGLE_PROBLEMS: Record<string, string> = {
  scope:
    "Google did not give access to your spreadsheets: on Google's page, tick the box that allows access to the Drive files you choose. Approve again to retry.",
  cancelled: "Connecting was cancelled at Google. Approve again to retry, or refuse it.",
  expired: "That took too long at Google. Approve again to retry.",
  failed: "Google could not be connected. Approve again in a moment.",
};

/** Connected at Google after the request had ended. */
const GOOGLE_LATE =
  "The Google account was connected, but this request had already ended, so whoever asked did not get it. They can find it among the connected accounts.";

/** What the approve button says while the action runs. */
const WORKING: Record<string, string> = {
  "ai.assist": "Running AI setup, this can take up to a minute...",
  "google.connect": "Opening Google...",
  "google.pick": "Choose a spreadsheet in Google's window...",
};

function formatCode(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length <= 4 ? cleaned : `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

function ApproveContent() {
  const { isAuthenticated, isLoading, user, session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const codeInUrl = formatCode(searchParams.get("code") ?? "");
  const code = CODE_PATTERN.test(codeInUrl) ? codeInUrl : null;
  // Back from Google's consent page (a Google connection an agent asked for).
  const googleBack = searchParams.get("google");

  const [phase, setPhase] = useState<Phase>(code ? { kind: "loading" } : { kind: "enter" });
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const here = code ? `/approve?code=${encodeURIComponent(code)}` : "/approve";
      router.push(`/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router, code]);

  const load = useCallback(async (userCode: string, problemAfter: string | null = null) => {
    setPhase({ kind: "loading" });
    setProblem(problemAfter);
    try {
      const response = await fetch(`/api/approvals/review?code=${encodeURIComponent(userCode)}`);
      const result = (await response.json()) as Review & { error?: string };
      if (response.status === 404 || response.status === 403) {
        setPhase({ kind: "gone", message: result.error ?? "This code no longer works." });
      } else if (!response.ok) {
        setPhase({ kind: "failed", message: result.error ?? "This request could not be loaded." });
      } else {
        setPhase({ kind: "review", review: result });
      }
    } catch {
      setPhase({ kind: "failed", message: "This request could not be loaded." });
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (code && googleBack) {
      // The address keeps the code only, so a reload asks again.
      router.replace(`/approve?code=${encodeURIComponent(code)}`);
      if (googleBack === "connected") {
        setPhase({
          kind: "done",
          summary: "A Google account was connected for Google Sheets destinations.",
        });
      } else if (googleBack === "late") {
        setPhase({ kind: "gone", message: GOOGLE_LATE });
      } else {
        void load(code, GOOGLE_PROBLEMS[googleBack] ?? GOOGLE_PROBLEMS.failed);
      }
      return;
    }
    if (code) void load(code);
    else setPhase({ kind: "enter" });
    // googleBack is read once, on the way back from Google.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, code, load]);

  const decide = async (
    userCode: string,
    approve: boolean,
    summary: string,
    input?: Record<string, unknown>
  ) => {
    setSubmitting(true);
    setProblem(null);
    try {
      const response = await fetch("/api/approvals/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: userCode,
          decision: approve ? "approve" : "deny",
          ...(input ? { input } : {}),
        }),
      });
      const result = (await response.json()) as { status?: string; error?: string; url?: string };
      if (!response.ok) throw new Error(result.error || "That did not work. Try again.");
      // A Google connection: on to Google, which comes back to this page.
      if (result.status === "redirect" && result.url) {
        window.location.assign(result.url);
        return;
      }
      if (!approve) setPhase({ kind: "denied" });
      // "done": it ran on approval (a share link, a domain removed); else the
      // asker collects it (a new key) and it can still be withdrawn.
      else if (result.status === "done") setPhase({ kind: "done", summary });
      else setPhase({ kind: "approved", code: userCode });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // A Drive pick: the person chooses in Google's window first, then the
  // approval runs with the chosen file. Opened from the click itself.
  const approvePick = (review: Review) => {
    const connectionId = review.page?.connectionId;
    const accessToken = session?.access_token;
    if (typeof connectionId !== "string" || !accessToken) return;
    setProblem(null);
    setSubmitting(true);
    pickFromDrive((nonce) => startDrivePick(accessToken, connectionId, nonce))
      .then((file) => {
        if (file) return decide(review.code, true, review.summary, { file });
        setSubmitting(false);
      })
      .catch((err: unknown) => {
        setSubmitting(false);
        setProblem(
          err instanceof DrivePickError || err instanceof Error
            ? err.message
            : "The picker could not open."
        );
      });
  };

  const withdraw = async (userCode: string) => {
    setSubmitting(true);
    setProblem(null);
    try {
      const response = await fetch("/api/approvals/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: userCode, decision: "withdraw" }),
      });
      const result = (await response.json()) as { status?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "That did not work. Try again.");
      setPhase({ kind: result.status === "collected" ? "collected" : "withdrawn" });
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
        <div className="w-full max-w-md" data-testid="approve">
          {phase.kind === "loading" && <Loading inline />}

          {phase.kind === "enter" && (
            <EnterCode
              onSubmit={(entered) => router.replace(`/approve?code=${encodeURIComponent(entered)}`)}
            />
          )}

          {phase.kind === "review" && (
            <ReviewPanel
              review={phase.review}
              email={user?.email ?? null}
              problem={problem}
              submitting={submitting}
              onApprove={() =>
                phase.review.action === "google.pick"
                  ? approvePick(phase.review)
                  : void decide(phase.review.code, true, phase.review.summary)
              }
              onDeny={() => void decide(phase.review.code, false, phase.review.summary)}
            />
          )}

          {phase.kind === "approved" && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">Approved</h1>
              <p className="text-muted-foreground mb-6">
                Whoever asked can now collect it, within 15 minutes. Approved by mistake? Withdraw
                it now, before it is collected.
              </p>
              {problem && (
                <p className="text-sm text-destructive-ink mb-4" role="alert">
                  {problem}
                </p>
              )}
              <Button
                variant="surface"
                disabled={submitting}
                onClick={() => void withdraw(phase.code)}
              >
                Withdraw
              </Button>
            </div>
          )}

          {phase.kind === "done" && (
            <Notice title="Done">
              You approved this, and it is done: {phase.summary} Whoever asked can see the result
              now. You can close this page.
            </Notice>
          )}

          {phase.kind === "withdrawn" && (
            <Notice title="Withdrawn">
              Whoever asked gets nothing, and the code no longer works.
            </Notice>
          )}

          {phase.kind === "collected" && (
            <Notice title="Already collected">
              The key was already handed over, so there is nothing left to withdraw. Revoke it under{" "}
              <Link href="/account/api-keys" className="text-primary underline">
                API keys
              </Link>
              ; anything using it stops working at once.
            </Notice>
          )}

          {phase.kind === "denied" && (
            <Notice title="Refused">
              Whoever asked gets nothing, and the code no longer works. If you did not expect this
              request, someone may have sent you the link: you can ignore it.
            </Notice>
          )}

          {phase.kind === "gone" && (
            <Notice title="This code no longer works">{phase.message}</Notice>
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
      <h1 className="text-2xl font-bold mb-2 text-center">Answer a request</h1>
      <p className="text-muted-foreground mb-6 text-center">
        Enter the code the agent or tool showed you.
      </p>
      <label htmlFor="approval-code" className="sr-only">
        Code
      </label>
      <Input
        id="approval-code"
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

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Less than a minute ago";
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

function ReviewPanel(props: {
  review: Review;
  email: string | null;
  problem: string | null;
  submitting: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { review } = props;
  const notice = networkNotice(review.network, false, "request");

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-center">Approve a request</h1>
      <p className="text-muted-foreground mb-6 text-center">
        {review.requester.charAt(0).toUpperCase() + review.requester.slice(1)} asks for this on your
        account
        {props.email ? (
          <>
            {" "}
            <span className="font-mono text-foreground">{props.email}</span>
          </>
        ) : null}
        .
      </p>

      <div className="text-center mb-6">
        <p
          className="font-mono text-4xl sm:text-5xl font-semibold tracking-[0.12em] text-foreground"
          data-testid="approval-code"
        >
          {review.code}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Is this the code the agent or tool showed you? Approve only if it matches.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          If you did not just ask an agent or tool for this, choose This wasn&apos;t me.
        </p>
      </div>

      {/* What it is about can be captured content (email subjects, senders): never recorded. */}
      <p className="font-medium mb-4 ph-no-capture">{review.summary}</p>

      <Card className="p-4 mb-4 space-y-2 text-sm ph-no-capture" render={<dl />}>
        {review.details.map((detail) => (
          <div key={detail.label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{detail.label}</dt>
            <dd className="text-right break-words">{detail.value}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Asked from</dt>
          <dd className="text-right">
            {review.country ? countryName(review.country) : "Unknown"}
            {review.client && (
              <span className="block text-xs text-muted-foreground break-all">
                {review.client}, as it describes itself
              </span>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Asked</dt>
          <dd className="text-right">{ago(review.createdAt)}</dd>
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
          {props.submitting && WORKING[review.action]
            ? WORKING[review.action]
            : review.action === "google.connect"
              ? "Approve and continue to Google"
              : review.action === "google.pick"
                ? "Approve and choose the spreadsheet"
                : "Approve"}
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
