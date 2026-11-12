"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trackToolUsed } from "@/lib/analytics";
import { characterCount, type AnswerExplanation } from "@/lib/tools/answer";
import { toolPath } from "@/lib/tools/catalog";
import { useOwnDocument } from "@/lib/tools/own-document";
import {
  SLACK_TEXT_ADVISED_MAX,
  SLACK_URL_EXAMPLE,
  buildSlackJsonPayload,
  buildSlackTextPayload,
  explainSlackAnswer,
  explainSlackFailure,
  parseSlackWebhookUrl,
  slackCurl,
  slackFormBody,
} from "@/lib/tools/slack";
import {
  CodeSample,
  Count,
  Field,
  ModeTabs,
  NO_MEMORY,
  PRIVATE_INPUT,
  Verdict,
  fieldNote,
} from "./tool-parts";
import { Card } from "@/components/ui/card";

const SLUG = "slack-webhook-tester";

type Mode = "text" | "json";

const MODES = [
  { value: "text", label: "Text" },
  { value: "json", label: "JSON" },
] as const;

const JSON_SAMPLE = `{
  "text": "Deploy finished",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Deploy finished*\\nmain is live." }
    }
  ]
}`;

interface Result {
  explanation: AnswerExplanation;
  /** Null when the browser could not read an answer. */
  status: number | null;
  body: string;
  curl: string;
}

/**
 * Posts a message to a Slack incoming webhook from the browser. The URL is a
 * credential: the only request made goes to hooks.slack.com, and nothing
 * typed here is sent to webhooks.cc or kept. How it is sent, and why not as
 * the JSON request Slack documents, is in lib/tools/slack.ts.
 */
export function SlackWebhookTester() {
  useOwnDocument(toolPath(SLUG));

  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("This is a test message.");
  const [json, setJson] = useState(JSON_SAMPLE);

  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  async function send() {
    const webhook = parseSlackWebhookUrl(url);
    setUrlProblem(webhook.ok ? null : webhook.problem);
    if (!webhook.ok) urlRef.current?.focus();
    const built = mode === "text" ? buildSlackTextPayload(text) : buildSlackJsonPayload(json);
    setProblem(built.ok ? null : built.problem);
    if (!webhook.ok || !built.ok) return;

    const curl = slackCurl(webhook.url, built.payload);
    setBusy(true);
    setResult(null);
    try {
      // A form body needs no preflight, and Slack's answer is readable from
      // any origin. No cookies, no referrer.
      const response = await fetch(webhook.url, {
        method: "POST",
        body: slackFormBody(built.payload),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      const body = await response.text();
      setResult({
        explanation: explainSlackAnswer({ status: response.status, body }),
        status: response.status,
        body,
        curl,
      });
      trackToolUsed(SLUG, "send", String(response.status));
    } catch {
      setResult({ explanation: explainSlackFailure(), status: null, body: "", curl });
      trackToolUsed(SLUG, "send", "unreadable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className="space-y-5"
      render={
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        />
      }
    >
      <Field
        id="slack-url"
        label="Webhook URL"
        error={urlProblem}
        hint="From your Slack app's settings: Incoming Webhooks, Copy."
      >
        <Input
          ref={urlRef}
          id="slack-url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setUrlProblem(null);
          }}
          placeholder={SLACK_URL_EXAMPLE}
          aria-invalid={urlProblem ? true : undefined}
          aria-describedby={fieldNote("slack-url")}
          className={`${PRIVATE_INPUT} font-mono`}
          {...NO_MEMORY}
        />
      </Field>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as Mode);
          setProblem(null);
        }}
        className="space-y-4"
      >
        <ModeTabs label="What to send" modes={MODES} />
        <TabsPanel value="text">
          <Field
            id="slack-text"
            label="Message"
            error={mode === "text" ? problem : null}
            hint="Slack's own formatting works: *bold*, _italic_, `code`, <https://example.com|a link>."
            aside={<Count value={characterCount(text)} max={SLACK_TEXT_ADVISED_MAX} />}
          >
            <Textarea
              id="slack-text"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setProblem(null);
              }}
              rows={4}
              aria-describedby={fieldNote("slack-text")}
              className={PRIVATE_INPUT}
              {...NO_MEMORY}
              spellCheck
            />
          </Field>
        </TabsPanel>
        <TabsPanel value="json">
          <Field
            id="slack-json"
            label="JSON payload"
            error={mode === "json" ? problem : null}
            hint="The whole message as JSON, for Block Kit blocks or attachments."
          >
            <Textarea
              id="slack-json"
              value={json}
              onChange={(event) => {
                setJson(event.target.value);
                setProblem(null);
              }}
              rows={10}
              aria-describedby={fieldNote("slack-json")}
              className={`${PRIVATE_INPUT} font-mono`}
              {...NO_MEMORY}
            />
          </Field>
        </TabsPanel>
      </Tabs>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Sending" : "Send message"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Sent from your browser as a form field, because a web page cannot send Slack the JSON
          request directly.{" "}
          <a href="#browser" className="font-bold text-primary hover:underline">
            Why
          </a>
        </p>
      </div>

      {result && (
        <div className={`${PRIVATE_INPUT} space-y-4 border-t border-border pt-5`}>
          <Verdict explanation={result.explanation} />
          {result.status !== null && (
            <CodeSample
              label="Slack's answer"
              aside={`HTTP ${result.status}`}
              code={result.body || "(no content)"}
              testId="tool-answer"
            />
          )}
          <CodeSample label="The same message with curl" code={result.curl} testId="tool-curl" />
        </div>
      )}
    </Card>
  );
}
