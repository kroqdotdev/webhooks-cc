"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REPORT_KINDS } from "@/lib/tunnels/report-kinds";
import { Turnstile } from "./turnstile";

interface Values {
  url: string;
  kind: string;
  details: string;
  name: string;
  email: string;
  agree: boolean;
}

/** The public report form (/report). Each try gets a fresh Turnstile widget, since a token works once. */
export function ReportForm({ url, siteKey }: { url: string; siteKey: string | null }) {
  const [values, setValues] = useState<Values>({
    url,
    kind: "",
    details: "",
    name: "",
    email: "",
    agree: false,
  });
  const [round, setRound] = useState(0);
  const [token, setToken] = useState<{ round: number; value: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ receiptTo: string | null } | null>(null);

  const csam = values.kind === "csam";
  const current = token?.round === round ? token.value : null;
  const waiting = siteKey !== null && current === null;
  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  if (done) {
    return (
      <p role="status" className="ui-card ui-card-static mt-8 text-sm">
        {done.receiptTo
          ? `Thanks, the report is in. We sent a receipt to ${done.receiptTo} and will write again when we have decided what to do.`
          : "Thanks, the report is in. Someone at webhooks.cc will look at it."}
      </p>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, turnstile: current ?? undefined }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        receiptTo?: string | null;
        error?: string;
      };
      if (response.ok && data.ok) setDone({ receiptTo: data.receiptTo ?? null });
      else setError(data.error ?? "The report could not be sent. Try again.");
    } catch {
      setError("The report could not be sent. Check your connection and try again.");
    } finally {
      setPending(false);
      setRound((r) => r + 1);
    }
  };

  const optional = csam ? " (optional)" : "";
  return (
    <form onSubmit={submit} className="mt-8 space-y-6">
      <div className="space-y-2">
        <Label htmlFor="report-url">The preview&rsquo;s address</Label>
        <Input
          id="report-url"
          required
          value={values.url}
          onChange={(e) => set("url", e.target.value)}
          placeholder="https://name.sharehooks.cc/page"
          autoComplete="off"
          className="font-mono"
          maxLength={2000}
        />
        <p className="text-xs text-muted-foreground">The exact page, if you can.</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What&rsquo;s wrong with it</legend>
        <div className="space-y-2 pt-1">
          {Object.entries(REPORT_KINDS).map(([value, kind]) => (
            <label key={value} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="kind"
                value={value}
                checked={values.kind === value}
                onChange={() => set("kind", value)}
                required
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              {kind.ask}
            </label>
          ))}
        </div>
      </fieldset>
      {csam && (
        <p className="ui-card ui-card-static text-sm">
          Don&rsquo;t save, copy or describe the material: the address is enough. Your name and
          email are optional for this report. You can also report it to your local police, or in
          Denmark anonymously to{" "}
          <a
            href="https://redbarnet.dk/anmelddet/anmeld/"
            target="_blank"
            rel="noreferrer"
            className="text-primary-ink underline"
          >
            Red Barnet
          </a>
          .
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor="report-details">What did you see{optional}</Label>
        <Textarea
          id="report-details"
          rows={4}
          maxLength={2000}
          required={!csam}
          value={values.details}
          onChange={(e) => set("details", e.target.value)}
        />
        {!csam && (
          <p className="text-xs text-muted-foreground">
            Say what is on the page and why it&rsquo;s wrong. For illegal content, say which law you
            think it breaks.
          </p>
        )}
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="report-name">Your name{optional}</Label>
          <Input
            id="report-name"
            maxLength={200}
            required={!csam}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            autoComplete="name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="report-email">Your email{optional}</Label>
          <Input
            id="report-email"
            type="email"
            maxLength={320}
            required={!csam}
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            autoComplete="email"
          />
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        {csam ? "If you leave your email, we" : "We"} send a receipt and tell you what we decide.
        The person who shared the preview does not see who reported it. We delete your name and
        email 90 days after we close the report, and the report a year after it was made.
      </p>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          required
          checked={values.agree}
          onChange={(e) => set("agree", e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        I believe in good faith that this report is accurate and complete.
      </label>
      <Turnstile
        key={round}
        siteKey={siteKey}
        onToken={(value) => setToken(value ? { round, value } : null)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive-ink">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending || waiting}>
        Send report
      </Button>
    </form>
  );
}
