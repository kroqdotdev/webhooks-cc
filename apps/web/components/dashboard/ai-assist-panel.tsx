"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { Condition } from "@webhooks-cc/sdk";
import type { EmailField } from "@webhooks-cc/sdk/email";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  askAiAssist,
  fetchAiAssists,
  type AiAssistInfo,
  type AiAssistResult,
} from "@/lib/dashboard-api";

/** At most this many emails go to the model in one ask. */
const MAX_SAMPLES = 5;

export type AiAssistMode =
  { kind: "field" } | { kind: "layout" } | { kind: "repair"; field: EmailField };

/**
 * AI setup and repair: pick a few of the endpoint's emails, say what you
 * want, agree to send them to the AI service, and get patterns that were
 * tested on every one of them. Nothing is saved here: a proposal is handed
 * to the editor it belongs to, and saved with it.
 */
export function AiAssistPanel({
  slug,
  samples,
  mode,
  onAddField,
  onUseLayout,
  onClose,
}: {
  slug: string;
  /** The endpoint's recent emails, newest first. */
  samples: { id: string; subject: string }[];
  mode: AiAssistMode;
  /** May save (a repair does): the field shows as added only once it resolves. */
  onAddField?: (field: EmailField) => void | Promise<void>;
  onUseLayout?: (layout: {
    name: string | null;
    match: Condition | null;
    fields: EmailField[];
  }) => void;
  onClose: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [info, setInfo] = useState<AiAssistInfo | null>(null);
  const [picked, setPicked] = useState<string[]>(() =>
    samples.slice(0, 3).map((sample) => sample.id)
  );
  // The emails may still be loading when the panel opens: the first three
  // are picked when they arrive, unless the person picked already.
  const touched = useRef(false);
  const sampleKey = samples.map((sample) => sample.id).join(",");
  useEffect(() => {
    if (touched.current) return;
    setPicked(sampleKey ? sampleKey.split(",").slice(0, 3) : []);
  }, [sampleKey]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiAssistResult | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    fetchAiAssists(accessToken, slug)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [accessToken, slug]);

  const left = info ? Math.max(info.allowed - info.used, 0) : 0;
  const toggle = (id: string) => {
    touched.current = true;
    setPicked((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length >= MAX_SAMPLES
          ? current
          : [...current, id]
    );
  };

  const ask = async () => {
    if (!accessToken) return;
    setError(null);
    setResult(null);
    setAdded(new Set());
    if (mode.kind === "field" && !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) {
      return setError("Name the field: letters, digits and _, starting with a letter.");
    }
    if (mode.kind === "field" && !description.trim()) {
      return setError("Say what the field is, such as the order number.");
    }
    setBusy(true);
    try {
      const answer = await askAiAssist(accessToken, slug, {
        ask:
          mode.kind === "field"
            ? { kind: "field", name, description }
            : mode.kind === "layout"
              ? { kind: "layout", description }
              : { kind: "repair", field: mode.field },
        requestIds: picked,
        consent: true,
      });
      setResult(answer);
      setInfo({ offered: true, allowed: answer.allowed, used: answer.used });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The AI service could not be asked.");
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode.kind === "field"
      ? "Find a field with AI"
      : mode.kind === "layout"
        ? "Draft a layout with AI"
        : `Fix ${mode.field.name} with AI`;

  return (
    <div
      className="border-strong border-line rounded-md p-3 space-y-3 bg-card"
      role="region"
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Sparkles className="h-4 w-4" /> {title}
        </h4>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground">
          Close
        </button>
      </div>

      {info && !info.offered ? (
        <p className="text-sm text-muted-foreground">AI setup is not available on this server.</p>
      ) : samples.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This endpoint has no emails yet. Send it a few of the emails you want read first.
        </p>
      ) : (
        <>
          {mode.kind === "field" && (
            <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <input
                aria-label="Field name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="order"
                className="ui-input text-sm py-1.5! font-mono"
              />
              <input
                aria-label="What it is"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="The order number, after Order #"
                maxLength={500}
                className="ui-input text-sm py-1.5!"
              />
            </div>
          )}
          {mode.kind === "layout" && (
            <input
              aria-label="What to read"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional: what you need from them, such as order, total and tracking number"
              maxLength={500}
              className="ui-input w-full text-sm py-1.5!"
            />
          )}

          <fieldset className="space-y-1">
            <legend className="text-xs text-muted-foreground">
              Emails to learn from ({picked.length} of at most {MAX_SAMPLES}): pick a few that look
              alike.
            </legend>
            <ul className="max-h-36 overflow-auto space-y-0.5">
              {samples.map((sample) => (
                <li key={sample.id}>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={picked.includes(sample.id)}
                      onChange={() => toggle(sample.id)}
                    />
                    <span className="truncate">{sample.subject}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Send {picked.length === 1 ? "this email" : `these ${picked.length} emails`} (subject,
              sender, recipients, text and headers, never attachments) to Anthropic, our AI
              provider, to propose patterns. We do not keep what is sent, and Anthropic handles it
              under its commercial terms; see our{" "}
              <a href="/subprocessors" target="_blank" className="underline">
                subprocessors
              </a>
              .
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || adding !== null || !consent || picked.length === 0 || left === 0}
              onClick={() => void ask()}
              className="ui-btn-primary py-1.5! px-3! text-xs"
            >
              {busy ? "Asking..." : "Propose"}
            </button>
            {info && (
              <span className="text-xs text-muted-foreground">
                {left} of {info.allowed} AI assists left this 30 days.
              </span>
            )}
          </div>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className="space-y-2" aria-live="polite">
          {result.fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pattern found the value in every email. Try other emails, or describe it
              differently.
            </p>
          ) : (
            <>
              {mode.kind === "layout" && (
                <p className="text-sm">
                  <span className="font-medium">{result.layoutName ?? "New layout"}</span>
                  {result.match ? (
                    <span className="text-muted-foreground">
                      {" "}
                      for emails whose {result.match.name} contains &quot;{result.match.value}
                      &quot;
                    </span>
                  ) : null}
                </p>
              )}
              {mode.kind === "layout" && !result.match && (
                <p className="text-xs text-muted-foreground">
                  No text that all these emails share tells them apart, so this is not a layout of
                  its own: it would read every email. Pick emails from one sender, or add these
                  fields to a layout you have.
                </p>
              )}
              <ul className="space-y-2">
                {result.fields.map(({ field, values }) => (
                  <li key={field.name} className="text-sm space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium font-mono">{field.name}</span>
                      <span className="text-xs text-muted-foreground">
                        from {field.from === "header" ? `header ${field.header}` : field.from}
                      </span>
                      <code className="ui-code text-xs px-1.5 py-0.5 shadow-none! break-all">
                        {field.pattern}
                      </code>
                      {mode.kind !== "layout" && onAddField && (
                        <button
                          type="button"
                          disabled={added.has(field.name) || adding === field.name}
                          onClick={async () => {
                            setAdding(field.name);
                            try {
                              await onAddField(field);
                              setAdded((current) => new Set([...current, field.name]));
                            } catch {
                              // Not saved: the parent says why, and the button stays to try again.
                            } finally {
                              setAdding(null);
                            }
                          }}
                          className="ui-btn-outline py-0.5! px-2! text-xs ml-auto"
                        >
                          {added.has(field.name)
                            ? "Added"
                            : mode.kind === "repair"
                              ? "Use this pattern"
                              : "Add field"}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Found{" "}
                      {values.map((value, i) => (
                        <span key={i}>
                          {i > 0 ? ", " : ""}
                          <span className="font-mono text-foreground">{value}</span>
                        </span>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
              {mode.kind === "layout" && onUseLayout && result.match && (
                <button
                  type="button"
                  onClick={() => {
                    onUseLayout({
                      name: result.layoutName,
                      match: result.match,
                      fields: result.fields.map((item) => item.field),
                    });
                    onClose();
                  }}
                  className="ui-btn-outline py-1! px-2.5! text-xs"
                >
                  Add this layout
                </button>
              )}
            </>
          )}
          {result.dropped > 0 && (
            <p className="text-xs text-muted-foreground">
              {result.dropped} other proposal{result.dropped === 1 ? "" : "s"} missed an email or
              did not compile, and {result.dropped === 1 ? "is" : "are"} not shown.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
