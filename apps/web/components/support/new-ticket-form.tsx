"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/support/client";
import { isDocsSearchUrl, normalizePagefindUrl } from "@/lib/docs-search";
import { BODY_MAX, SUBJECT_MAX, SUPPORT_CATEGORIES } from "@/lib/support/shared";
import type { SupportCategory } from "@/lib/supabase/database";
import { cn } from "@/lib/utils";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { CheckRow, ImagePicker, supportBody } from "./thread";
import { Card } from "@/components/ui/card";

interface Endpoint {
  id: string;
  slug: string;
  name: string | null;
}

const DRAFT_KEY = "whk-support-draft";

/** The endpoint choice that means none (every Select item needs a value). */
const NO_ENDPOINT = "__none__";

/** Up to three docs pages for what the subject says, from the site's Pagefind index. */
function useDocSuggestions(query: string): { url: string; title: string }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pagefind = useRef<any>(null);
  const [results, setResults] = useState<{ url: string; title: string }[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 4) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        if (!pagefind.current) {
          // @ts-expect-error -- Pagefind is generated at build time, not a real module
          const pf = await import(/* webpackIgnore: true */ "/_pagefind/pagefind.js");
          await pf.init();
          pagefind.current = pf;
        }
        const search = await pagefind.current.search(q);
        const found: { url: string; title: string }[] = [];
        for (const result of search.results.slice(0, 8)) {
          if (found.length === 3) break;
          const data = await result.data();
          const url = normalizePagefindUrl(data.url);
          if (!isDocsSearchUrl(url)) continue;
          found.push({ url, title: data.meta?.title ?? url });
        }
        if (!cancelled) setResults(found);
      } catch {
        // No index (dev without a build): no suggestions.
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return results;
}

export function NewTicketForm() {
  const { session } = useAuth();
  const token = session?.access_token ?? null;
  const router = useRouter();
  const params = useSearchParams();

  const [category, setCategory] = useState<SupportCategory | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [endpointId, setEndpointId] = useState<string>("");
  const [blocking, setBlocking] = useState<boolean | null>(null);
  const [images, setImages] = useState<File[]>([]);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [grantAccess, setGrantAccess] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [attachments, setAttachments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const loadedDraft = useRef(false);
  const suggestions = useDocSuggestions(subject);

  // The draft survives a reload or a detour to the docs.
  useEffect(() => {
    if (loadedDraft.current) return;
    loadedDraft.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as {
        category?: SupportCategory;
        subject?: string;
        body?: string;
      } | null;
      if (saved) {
        if (saved.category) setCategory(saved.category);
        if (saved.subject) setSubject(saved.subject);
        if (saved.body) setBody(saved.body);
      }
    } catch {
      // A broken draft is dropped.
    }
  }, []);

  useEffect(() => {
    if (!loadedDraft.current) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ category, subject, body }));
    } catch {
      // Storage full or off: the draft is not kept.
    }
  }, [category, subject, body]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch("/api/support/tickets", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const data = (await response.json()) as { endpoints: Endpoint[]; attachments: boolean };
      setEndpoints(data.endpoints);
      setAttachments(data.attachments);
      const wanted = params.get("endpoint");
      const match = data.endpoints.find(
        (endpoint) => endpoint.slug === wanted || endpoint.id === wanted
      );
      if (match) setEndpointId(match.id);
    } catch {
      // The picker stays empty.
    }
  }, [token, params]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!category) return setError("Choose what the ticket is about.");
    if (!subject.trim()) return setError("Write a subject.");
    if (!body.trim()) return setError("Describe what happened.");
    if (!token) return setError("You are signed out. Sign in again.");
    setSending(true);
    try {
      const { body: payload, json } = supportBody(
        {
          category,
          subject,
          body,
          endpointId,
          blocking: blocking === true,
          notifyEmail,
          grantAccess,
          from: params.get("from") ?? "",
        },
        images
      );
      const response = await fetch("/api/support/tickets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(json ? { "Content-Type": "application/json" } : {}),
        },
        body: payload,
      });
      const data = (await response.json().catch(() => ({}))) as {
        number?: number;
        error?: string;
        imagesFailed?: number;
      };
      if (!response.ok || !data.number) {
        throw new ApiError(
          data.error ?? "The ticket could not be sent. Try again.",
          response.status
        );
      }
      sessionStorage.removeItem(DRAFT_KEY);
      router.push(`/support/${data.number}${data.imagesFailed ? "?images=failed" : ""}`);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "The ticket could not be sent."
      );
      setSending(false);
    }
  };

  const email = session?.user.email;

  return (
    <main className="mx-auto max-w-3xl px-6 pb-16 pt-10 md:px-10">
      <p className="mb-2 text-xs text-muted-foreground">
        <Link href="/support" className="text-primary hover:underline">
          Support
        </Link>{" "}
        / New ticket
      </p>
      <h1 className="mb-2 text-3xl font-semibold">New ticket</h1>
      <p className="mb-6 max-w-[60ch] text-sm text-muted-foreground">
        Tell us what happened and what you expected. Request ids and endpoint names help.
      </p>

      <Card className="ph-no-capture space-y-6" render={<form onSubmit={submit} noValidate />}>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">What is it about?</legend>
          <RadioGroup
            value={category}
            onValueChange={(next) => setCategory(next as typeof category)}
            className="flex flex-wrap gap-2"
          >
            {SUPPORT_CATEGORIES.map((entry) => (
              <Radio
                key={entry.value}
                value={entry.value}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  category === entry.value
                    ? "border-primary/40 bg-selected font-medium text-selected-foreground"
                    : "border-input hover:bg-muted"
                )}
              >
                {entry.label}
              </Radio>
            ))}
          </RadioGroup>
        </fieldset>

        <div className="space-y-2">
          <label htmlFor="ticket-subject" className="text-sm font-medium">
            Subject
          </label>
          <Input
            id="ticket-subject"
            value={subject}
            maxLength={SUBJECT_MAX}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Stripe signature fails after rotating the secret"
          />
          {suggestions.length > 0 && (
            <div className="border-l pl-3 text-sm" aria-live="polite">
              <p className="text-muted-foreground">These docs might answer it:</p>
              <ul className="mt-1 space-y-0.5">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.url}>
                    <a
                      href={suggestion.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {suggestion.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="ticket-body" className="text-sm font-medium">
            Details
          </label>
          <Textarea
            id="ticket-body"
            value={body}
            maxLength={BODY_MAX}
            rows={7}
            onChange={(event) => setBody(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Markdown works. Leave out passwords, API keys and signing secrets.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="ticket-endpoint" className="text-sm font-medium">
              Endpoint
            </label>
            <Select
              value={endpointId || NO_ENDPOINT}
              onValueChange={(value) => setEndpointId(value === NO_ENDPOINT ? "" : value)}
            >
              <SelectTrigger id="ticket-endpoint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                <SelectItem value={NO_ENDPOINT}>None</SelectItem>
                {endpoints.map((endpoint) => (
                  <SelectItem key={endpoint.id} value={endpoint.id}>
                    {endpoint.name ? `${endpoint.name} (${endpoint.slug})` : endpoint.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Optional, if it is about one endpoint.</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Is this blocking you right now?</legend>
            <RadioGroup
              value={blocking}
              onValueChange={(next) => setBlocking(next as boolean)}
              className="flex gap-2"
            >
              {[
                { value: true, label: "Yes, it is" },
                { value: false, label: "No" },
              ].map((option) => (
                <Radio
                  key={option.label}
                  value={option.value}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    blocking === option.value
                      ? "border-primary/40 bg-selected font-medium text-selected-foreground"
                      : "border-input hover:bg-muted"
                  )}
                >
                  {option.label}
                </Radio>
              ))}
            </RadioGroup>
          </fieldset>
        </div>

        {attachments && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Screenshots</p>
            <ImagePicker files={images} onChange={setImages} disabled={sending} />
          </div>
        )}

        <div className="space-y-4 border-t pt-5">
          <CheckRow
            id="ticket-notify"
            checked={notifyEmail}
            onChange={setNotifyEmail}
            title="Email me when support replies or closes this ticket"
          >
            {email ? `Sent to ${email}. ` : ""}You can change this on the ticket later.
          </CheckRow>
          <CheckRow
            id="ticket-access"
            checked={grantAccess}
            onChange={setGrantAccess}
            title="Let support view my account while this ticket is open"
          >
            Support can read your endpoints, captured requests and emails, read-only, until 7 days
            after the ticket closes. Each view is listed under Account, Support access. You can
            withdraw it at any time.
          </CheckRow>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push("/support")}>
            Cancel
          </Button>
          <Button type="submit" disabled={sending}>
            {sending ? "Sending..." : "Send ticket"}
          </Button>
        </div>
      </Card>
    </main>
  );
}
