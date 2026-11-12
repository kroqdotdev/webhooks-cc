"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trackToolUsed } from "@/lib/analytics";
import { characterCount, type AnswerExplanation } from "@/lib/tools/answer";
import { toolPath } from "@/lib/tools/catalog";
import {
  DISCORD_CONTENT_MAX,
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_TITLE_MAX,
  DISCORD_URL_EXAMPLE,
  buildDiscordPayload,
  discordCurl,
  discordExecuteUrl,
  displayDiscordBody,
  explainDiscordAnswer,
  explainDiscordFailure,
  parseDiscordWebhookUrl,
} from "@/lib/tools/discord";
import { useOwnDocument } from "@/lib/tools/own-document";
import {
  CodeSample,
  Count,
  Field,
  NO_MEMORY,
  PRIVATE_INPUT,
  Verdict,
  fieldNote,
} from "./tool-parts";

const SLUG = "discord-webhook-tester";

interface Result {
  explanation: AnswerExplanation;
  /** Null when no answer could be read. */
  status: number | null;
  body: string;
  /** The same request for a terminal; absent for a check of the URL. */
  curl: string | null;
}

/**
 * Posts a message to a Discord webhook from the browser, or reads the webhook
 * without posting. The URL is a credential: the only request made goes to
 * discord.com, and nothing typed here is sent to webhooks.cc or kept.
 */
export function DiscordWebhookTester() {
  useOwnDocument(toolPath(SLUG));

  const [url, setUrl] = useState("");
  const [content, setContent] = useState("This is a test message.");
  const [username, setUsername] = useState("");
  const [withEmbed, setWithEmbed] = useState(false);
  const [embedTitle, setEmbedTitle] = useState("");
  const [embedDescription, setEmbedDescription] = useState("");
  const [embedUrl, setEmbedUrl] = useState("");
  const [embedColor, setEmbedColor] = useState("");
  const [allowMentions, setAllowMentions] = useState(false);

  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState<"send" | "check" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  function readUrl() {
    const webhook = parseDiscordWebhookUrl(url);
    if (!webhook.ok) {
      setUrlProblem(webhook.problem);
      urlRef.current?.focus();
      return null;
    }
    setUrlProblem(null);
    return webhook;
  }

  async function request(
    action: "send" | "check",
    target: string,
    init: RequestInit,
    curl: string | null
  ) {
    setBusy(action);
    setResult(null);
    try {
      // No cookies, no referrer: Discord learns nothing but the request itself.
      const response = await fetch(target, {
        ...init,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      const body = await response.text();
      setResult({
        explanation: explainDiscordAnswer({ status: response.status, body }, action),
        status: response.status,
        body: displayDiscordBody(body),
        curl,
      });
      trackToolUsed(SLUG, action, String(response.status));
    } catch {
      setResult({ explanation: explainDiscordFailure(), status: null, body: "", curl });
      trackToolUsed(SLUG, action, "unreadable");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    const webhook = readUrl();
    const built = buildDiscordPayload({
      content,
      username,
      embed: withEmbed
        ? { title: embedTitle, description: embedDescription, url: embedUrl, color: embedColor }
        : null,
      allowMentions,
    });
    setProblems(built.ok ? [] : built.problems);
    if (!webhook || !built.ok) return;
    await request(
      "send",
      discordExecuteUrl(webhook),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.payload),
      },
      discordCurl(webhook, built.payload)
    );
  }

  async function check() {
    const webhook = readUrl();
    setProblems([]);
    if (!webhook) return;
    await request("check", webhook.url, { method: "GET" }, null);
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="ui-card ui-card-static space-y-5"
    >
      <Field
        id="discord-url"
        label="Webhook URL"
        error={urlProblem}
        hint="From the channel's settings: Integrations, Webhooks, Copy Webhook URL."
      >
        <Input
          ref={urlRef}
          id="discord-url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setUrlProblem(null);
          }}
          placeholder={DISCORD_URL_EXAMPLE}
          aria-invalid={urlProblem ? true : undefined}
          aria-describedby={fieldNote("discord-url")}
          className={`${PRIVATE_INPUT} font-mono`}
          {...NO_MEMORY}
        />
      </Field>

      <Field
        id="discord-content"
        label="Message"
        aside={<Count value={characterCount(content)} max={DISCORD_CONTENT_MAX} />}
      >
        <Textarea
          id="discord-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={4}
          className={PRIVATE_INPUT}
          {...NO_MEMORY}
          spellCheck
        />
      </Field>

      <Field
        id="discord-username"
        label="Name"
        aside="optional"
        hint="Shown as the sender of this one message. Empty keeps the webhook's own name."
      >
        <Input
          id="discord-username"
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-describedby={fieldNote("discord-username")}
          className={PRIVATE_INPUT}
          {...NO_MEMORY}
        />
      </Field>

      <div className="space-y-3">
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            checked={withEmbed}
            onChange={(event) => setWithEmbed(event.target.checked)}
            className="size-4 shrink-0 accent-primary"
          />
          Add an embed
        </label>
        {withEmbed && (
          <div className="grid gap-4 border-l-2 border-border pl-4 sm:grid-cols-2">
            <Field
              id="discord-embed-title"
              label="Embed title"
              className="sm:col-span-2"
              aside={<Count value={characterCount(embedTitle)} max={DISCORD_EMBED_TITLE_MAX} />}
            >
              <Input
                id="discord-embed-title"
                type="text"
                value={embedTitle}
                onChange={(event) => setEmbedTitle(event.target.value)}
                className={PRIVATE_INPUT}
                {...NO_MEMORY}
              />
            </Field>
            <Field
              id="discord-embed-description"
              label="Embed description"
              className="sm:col-span-2"
              aside={
                <Count
                  value={characterCount(embedDescription)}
                  max={DISCORD_EMBED_DESCRIPTION_MAX}
                />
              }
            >
              <Textarea
                id="discord-embed-description"
                value={embedDescription}
                onChange={(event) => setEmbedDescription(event.target.value)}
                rows={3}
                className={PRIVATE_INPUT}
                {...NO_MEMORY}
                spellCheck
              />
            </Field>
            <Field id="discord-embed-url" label="Embed link" aside="optional">
              <Input
                id="discord-embed-url"
                type="text"
                inputMode="url"
                value={embedUrl}
                onChange={(event) => setEmbedUrl(event.target.value)}
                placeholder="https://example.com"
                className={PRIVATE_INPUT}
                {...NO_MEMORY}
              />
            </Field>
            <Field id="discord-embed-color" label="Embed colour" aside="optional">
              <Input
                id="discord-embed-color"
                type="text"
                value={embedColor}
                onChange={(event) => setEmbedColor(event.target.value)}
                placeholder="#5865F2"
                className={`${PRIVATE_INPUT} font-mono`}
                {...NO_MEMORY}
              />
            </Field>
          </div>
        )}
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={allowMentions}
            onChange={(event) => setAllowMentions(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span>
            Let mentions notify people
            <span className="block text-muted-foreground">
              Off, an @everyone, role or user mention in the message is shown but pings no one.
            </span>
          </span>
        </label>
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-destructive-ink">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy !== null}>
          {busy === "send" ? "Sending" : "Send message"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void check()}
        >
          {busy === "check" ? "Checking" : "Check URL"}
        </Button>
        <p className="text-sm text-muted-foreground">Check URL posts nothing to the channel.</p>
      </div>

      {result && (
        <div className={`${PRIVATE_INPUT} space-y-4 border-t border-border pt-5`}>
          <Verdict explanation={result.explanation} />
          {result.status !== null && (
            <CodeSample
              label="Discord's answer"
              aside={`HTTP ${result.status}`}
              code={result.body || "(no content)"}
              testId="tool-answer"
            />
          )}
          {result.curl && (
            <CodeSample label="The same request with curl" code={result.curl} testId="tool-curl" />
          )}
        </div>
      )}
    </form>
  );
}
