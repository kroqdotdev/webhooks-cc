"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Eye, EyeOff, Globe, Mail, RefreshCw, Send, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import { ResponseRulesEditor } from "./response-rules-editor";
import { AddressPill } from "./endpoint-bar";
import {
  deleteDashboardEndpoint,
  emitDashboardEndpointsChanged,
  fetchForwardSecret,
  fetchRecentDeliveries,
  rotateForwardSecret,
  sendForwardTest,
  updateDashboardEndpoint,
  type DashboardEndpoint,
  type ForwardTestResult,
  type RecentDelivery,
  type ResponseRule,
} from "@/lib/dashboard-api";
import { parseStatusCode } from "@/lib/http";
import { isValidSigningHeaderName } from "@/lib/signing-config";
import { trackEndpointDeleted, trackEndpointSaved } from "@/lib/analytics";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import {
  getWebProviderCredentialLabel,
  getWebProviderInfo,
  getWebProviderLabel,
  WEB_VERIFICATION_PROVIDER_OPTIONS,
} from "@/lib/provider-catalog";

/** Suggested response bodies by status code, offered when the user picks a code. */
const DEFAULT_BODIES: Record<string, string> = {
  "200": '{"status": "ok"}',
  "201": '{"id": "abc-123", "created": true}',
  "202": '{"accepted": true, "message": "Processing"}',
  "204": "",
  "301": "",
  "302": "",
  "304": "",
  "307": "",
  "308": "",
  "400": '{"error": "bad_request", "message": "Invalid input"}',
  "401": '{"error": "unauthorized"}',
  "403": '{"error": "forbidden"}',
  "404": '{"error": "not_found"}',
  "405": '{"error": "method_not_allowed"}',
  "409": '{"error": "conflict", "message": "Resource already exists"}',
  "422": '{"error": "unprocessable_entity", "message": "Validation failed"}',
  "429": '{"error": "too_many_requests", "retry_after": 60}',
  "500": '{"error": "internal_server_error"}',
  "502": '{"error": "bad_gateway"}',
  "503": '{"error": "service_unavailable"}',
  "504": '{"error": "gateway_timeout"}',
};
const DEFAULT_BODY_VALUES = new Set(Object.values(DEFAULT_BODIES));

export type SettingsSection =
  | "receiving"
  | "responses"
  | "forwarding"
  | "notifications"
  | "sharing"
  | "verification"
  | "delete";

interface EndpointSettingsPanelProps {
  endpoint: DashboardEndpoint & {
    mockResponse?: { delay?: number } & DashboardEndpoint["mockResponse"];
  };
  /** How many requests the endpoint holds, for the delete confirmation. */
  requestCount?: number;
  /** Scroll to this section when the panel opens. */
  focusSection?: SettingsSection | null;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  description,
  children,
  footer,
  danger,
}: {
  id: SettingsSection;
  title: string;
  description: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      id={`settings-${id}`}
      aria-labelledby={`settings-${id}-title`}
      data-settings-section={id}
      className={cn(
        "ui-card ui-card-static p-0! scroll-mt-4 overflow-hidden",
        danger && "border-destructive"
      )}
    >
      <div className="p-5 space-y-4">
        <div>
          <h2 id={`settings-${id}-title`} className="text-base font-bold clean:font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-[62ch]">{description}</p>
        </div>
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-t-strong border-line bg-muted/40">
          {footer}
        </div>
      )}
    </section>
  );
}

function Field({
  id,
  label,
  help,
  children,
}: {
  id?: string;
  label: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-bold caps">
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

/** One save per section: disabled until something in it changes. */
function SaveFooter({
  dirty,
  saving,
  error,
  saved,
  hint,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
  hint: string;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-xs flex-1 min-w-[180px]",
          error ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {error ?? (dirty ? hint : saved ? "Saved." : "")}
      </p>
      {dirty && (
        <button type="button" onClick={onReset} className="ui-btn-outline py-1.5! px-3! text-xs">
          Cancel
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || saving}
        className={cn(
          "ui-btn-primary py-1.5! px-3! text-xs",
          (!dirty || saving) && "opacity-50 cursor-not-allowed"
        )}
      >
        {saving ? "Saving..." : "Save changes"}
      </button>
    </>
  );
}

function Switch({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center border-strong border-line rounded-lg cursor-pointer transition-colors",
        "clean:rounded-full",
        checked ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 bg-card border-strong border-line rounded-sm clean:rounded-full transition-transform",
          checked ? "translate-x-5.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

function useSave(slug: string) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useCallback(
    async (updates: Record<string, unknown>, validate?: () => void) => {
      setError(null);
      setSaved(false);
      try {
        validate?.();
        if (!accessToken) throw new Error("Sign in again to save changes.");
        setSaving(true);
        await updateDashboardEndpoint(accessToken, slug, updates);
        emitDashboardEndpointsChanged();
        setSaved(true);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "The changes were not saved.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [accessToken, slug]
  );
  return { save, saving, error, saved, setError, setSaved };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function ReceivingSection({ endpoint }: { endpoint: EndpointSettingsPanelProps["endpoint"] }) {
  const initialName = endpoint.name ?? "";
  const initialExtracts = endpoint.showEmailExtracts !== false;
  const [name, setName] = useState(initialName);
  const [extracts, setExtracts] = useState(initialExtracts);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  const url = `${WEBHOOK_BASE_URL}/w/${endpoint.slug}`;

  useEffect(() => {
    setName(initialName);
    setExtracts(initialExtracts);
  }, [initialName, initialExtracts]);

  const dirty = name !== initialName || extracts !== initialExtracts;
  const hint =
    name !== initialName && extracts !== initialExtracts
      ? "Name and email setting changed."
      : name !== initialName
        ? "Name changed."
        : "Email setting changed.";

  return (
    <Section
      id="receiving"
      title="Receiving"
      description="Anything sent to either address lands in Requests and counts toward your monthly limit."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint={hint}
          onReset={() => {
            setName(initialName);
            setExtracts(initialExtracts);
            setError(null);
            setSaved(false);
          }}
          onSave={() =>
            void save({
              // An emptied name is saved as "" (the dashboard then shows the slug).
              ...(name !== initialName ? { name: name.trim() } : {}),
              ...(extracts !== initialExtracts ? { showEmailExtracts: extracts } : {}),
            })
          }
        />
      }
    >
      <Field id="settings-name" label="Name">
        <input
          id="settings-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={endpoint.slug}
          maxLength={100}
          className="ui-input w-full text-sm py-2!"
        />
      </Field>
      <Field label="HTTP URL">
        <AddressPill label="HTTP" icon={Globe} value={url} className="w-full" />
      </Field>
      {endpoint.emailAddress && (
        <>
          <Field
            label="Email address"
            help={`Add a tag to tell flows apart: ${endpoint.emailAddress.replace("@", "+invite@")} lands here too, marked +invite.`}
          >
            <AddressPill
              label="Email"
              icon={Mail}
              value={endpoint.emailAddress}
              className="w-full"
            />
          </Field>
          <div className="flex items-start justify-between gap-6 pt-4 border-t border-line/20">
            <div>
              <label htmlFor="settings-extracts" className="text-sm font-semibold">
                Show codes and links found in emails
              </label>
              <p className="text-xs text-muted-foreground mt-1 max-w-[62ch]">
                Verification codes and links are picked out of each email and shown above the
                preview, with copy buttons. Turn this off for endpoints that receive mail you would
                rather not have scanned.
              </p>
            </div>
            <Switch
              id="settings-extracts"
              checked={extracts}
              onChange={setExtracts}
              label="Show codes and links found in emails"
            />
          </div>
        </>
      )}
    </Section>
  );
}

function ResponsesSection({ endpoint }: { endpoint: EndpointSettingsPanelProps["endpoint"] }) {
  const mock = endpoint.mockResponse;
  // Keyed on values, not object identity: every endpoints refetch (another
  // section saving) hands back new objects, which must not discard edits here.
  const initialStatus = mock?.status?.toString() || "200";
  const initialBody = mock?.body || "";
  const initialDelay = mock?.delay?.toString() || "";
  const initialRules = JSON.stringify(endpoint.responseRules ?? []);
  const initial = useMemo(
    () => ({
      status: initialStatus,
      body: initialBody,
      delay: initialDelay,
      rules: JSON.parse(initialRules) as ResponseRule[],
    }),
    [initialStatus, initialBody, initialDelay, initialRules]
  );
  const [status, setStatus] = useState(initial.status);
  const [body, setBody] = useState(initial.body);
  const [delayEnabled, setDelayEnabled] = useState(!!initial.delay);
  const [delay, setDelay] = useState(initial.delay);
  const [rules, setRules] = useState<ResponseRule[]>(initial.rules);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);

  const reset = useCallback(() => {
    setStatus(initial.status);
    setBody(initial.body);
    setDelayEnabled(!!initial.delay);
    setDelay(initial.delay);
    setRules(initial.rules);
  }, [initial]);
  useEffect(reset, [reset]);

  const effectiveDelay = delayEnabled ? delay : "";
  const dirty =
    status !== initial.status ||
    body !== initial.body ||
    effectiveDelay !== initial.delay ||
    JSON.stringify(rules) !== JSON.stringify(initial.rules);

  const onSave = async () => {
    const delayMs = delayEnabled && delay ? parseInt(delay, 10) : undefined;
    const hasCustomMock = body || status !== "200" || (delayMs && delayMs > 0);
    const ok = await save({
      mockResponse: hasCustomMock
        ? {
            status: parseStatusCode(status, 200),
            body,
            headers: mock?.headers || {},
            ...(delayMs && delayMs > 0 ? { delay: delayMs } : {}),
          }
        : null,
      responseRules: rules.length > 0 ? rules : null,
    });
    if (ok) {
      trackEndpointSaved(
        { name: endpoint.name ?? "", mockStatus: initial.status, mockBody: initial.body },
        { name: endpoint.name ?? "", mockStatus: status, mockBody: body }
      );
    }
  };

  return (
    <Section
      id="responses"
      title="HTTP responses"
      description="What senders get back from this endpoint. Emails are always accepted with a standard reply."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint="Response changed."
          onReset={() => {
            reset();
            setError(null);
            setSaved(false);
          }}
          onSave={() => void onSave()}
        />
      }
    >
      <StatusCodePicker
        id="settings-status"
        value={status}
        onChange={(code) => {
          setStatus(code);
          if (!body || DEFAULT_BODY_VALUES.has(body)) setBody(DEFAULT_BODIES[code] ?? "");
        }}
      />
      <Field id="settings-body" label="Response body">
        <Textarea
          id="settings-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='{"status": "ok"}'
          rows={3}
          className="border-strong border-line text-sm font-mono"
        />
      </Field>
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={delayEnabled}
            onChange={(e) => {
              setDelayEnabled(e.target.checked);
              if (!e.target.checked) setDelay("");
            }}
            className="accent-foreground"
          />
          <span className="text-xs font-bold caps">Response delay</span>
        </label>
        {delayEnabled && (
          <>
            <input
              id="settings-delay"
              type="number"
              min="0"
              max="30000"
              step="100"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              onBlur={() => {
                if (!delay) return;
                const n = parseInt(delay, 10);
                if (isNaN(n) || n < 0) setDelay("");
                else if (n > 30000) setDelay("30000");
              }}
              placeholder="0-30000 ms"
              className="ui-input w-full text-sm py-2!"
            />
            <p className="text-xs text-muted-foreground">
              Wait this long before answering (at most 30 s), to test timeouts.
            </p>
          </>
        )}
      </div>
      <div className="pt-4 border-t border-line/20">
        <ResponseRulesEditor rules={rules} onChange={setRules} />
        <p className="text-xs text-muted-foreground mt-2">
          The first matching rule wins. Without a match, the status code and body above are sent.
        </p>
      </div>
    </Section>
  );
}

const DELIVERY_LABEL: Record<RecentDelivery["status"], string> = {
  succeeded: "Delivered",
  pending: "Retrying",
  failed: "Failed",
};

function ForwardingSection({ endpoint }: { endpoint: EndpointSettingsPanelProps["endpoint"] }) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const initialEnabled = endpoint.forwardEnabled === true;
  const initialUrl = endpoint.forwardUrl ?? "";
  const [enabled, setEnabled] = useState(initialEnabled);
  const [url, setUrl] = useState(initialUrl);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  useEffect(() => {
    setEnabled(initialEnabled);
    setUrl(initialUrl);
  }, [initialEnabled, initialUrl]);
  const dirty = enabled !== initialEnabled || url !== initialUrl;

  // The secret: hidden until asked for, and never kept after the section unmounts.
  const [secret, setSecret] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const reveal = async () => {
    if (!accessToken) return;
    try {
      setSecret(await fetchForwardSecret(accessToken, endpoint.slug));
      setSecretError(null);
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : "The secret could not be loaded.");
    }
  };
  const rotate = async () => {
    if (!accessToken) return;
    try {
      setSecret(await rotateForwardSecret(accessToken, endpoint.slug));
      setSecretError(null);
      setConfirmRotate(false);
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : "The secret could not be replaced.");
    }
  };
  const copySecret = async () => {
    const value =
      secret ?? (accessToken ? await fetchForwardSecret(accessToken, endpoint.slug) : null);
    if (value && (await copyToClipboard(value))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ForwardTestResult | { error: string } | null>(null);
  const sendTest = async () => {
    if (!accessToken || testing) return;
    setTesting(true);
    try {
      setTest(await sendForwardTest(accessToken, endpoint.slug));
    } catch (err) {
      setTest({ error: err instanceof Error ? err.message : "The test delivery failed." });
    } finally {
      setTesting(false);
    }
  };

  const [recent, setRecent] = useState<RecentDelivery[] | null>(null);
  useEffect(() => {
    if (!accessToken || !initialEnabled) return;
    let cancelled = false;
    fetchRecentDeliveries(accessToken, endpoint.slug)
      .then((rows) => !cancelled && setRecent(rows))
      .catch(() => !cancelled && setRecent([]));
    return () => {
      cancelled = true;
    };
  }, [accessToken, endpoint.slug, initialEnabled]);

  return (
    <Section
      id="forwarding"
      title="Forwarding"
      description="POST every email this endpoint receives to your server, as the JSON shown on each email's JSON tab, signed so you can check it came from here."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint={
            enabled !== initialEnabled
              ? enabled
                ? "Forwarding turned on."
                : "Forwarding turned off."
              : "URL changed."
          }
          onReset={() => {
            setEnabled(initialEnabled);
            setUrl(initialUrl);
            setError(null);
            setSaved(false);
          }}
          onSave={() =>
            void save({ forwardEnabled: enabled, forwardUrl: url.trim() || null }, () => {
              if (enabled && !url.trim())
                throw new Error("Add a URL before turning forwarding on.");
            })
          }
        />
      }
    >
      <div className="flex items-start justify-between gap-6">
        <div>
          <label htmlFor="settings-forward-enabled" className="text-sm font-semibold">
            Forward emails as JSON
          </label>
          <p className="text-xs text-muted-foreground mt-1 max-w-[62ch]">
            Failed deliveries are tried again for about a day. HTTP requests are not forwarded.
          </p>
        </div>
        <Switch
          id="settings-forward-enabled"
          checked={enabled}
          onChange={setEnabled}
          label="Forward emails as JSON"
        />
      </div>
      <Field
        id="settings-forward-url"
        label="URL"
        help="Each email arrives as a POST with Content-Type: application/json. Answer with any 2xx to accept it."
      >
        <input
          id="settings-forward-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/hooks/email"
          className="ui-input w-full text-sm font-mono py-2!"
        />
      </Field>

      {endpoint.hasForwardSecret && (
        <Field
          label="Signing secret"
          help={
            <>
              Check the <code className="font-mono">webhook-signature</code> header with it
              (Standard Webhooks).{" "}
              <Link href="/docs/forwarding#verify" className="underline underline-offset-2">
                How to verify
              </Link>
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <code className="ui-input flex-1 min-w-[220px] text-sm font-mono py-2! truncate">
              {secret ?? "whsec_" + "•".repeat(24)}
            </code>
            <button
              type="button"
              onClick={() => (secret ? setSecret(null) : void reveal())}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              {secret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {secret ? "Hide" : "Reveal"}
            </button>
            <button
              type="button"
              onClick={() => void copySecret()}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
            {confirmRotate ? (
              <>
                <button
                  type="button"
                  onClick={() => void rotate()}
                  className="ui-btn-outline py-1.5! px-3! text-xs text-destructive"
                >
                  Replace secret
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRotate(false)}
                  className="ui-btn-outline py-1.5! px-3! text-xs"
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRotate(true)}
                className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
              >
                <RefreshCw className="h-3 w-3" />
                Rotate
              </button>
            )}
          </div>
          {confirmRotate && (
            <p className="text-xs text-muted-foreground">
              Deliveries are signed with the new secret at once, so your server needs it before it
              can verify them again.
            </p>
          )}
          {secretError && <p className="text-xs text-destructive">{secretError}</p>}
        </Field>
      )}

      {initialUrl && (
        <div className="space-y-2 pt-4 border-t border-line/20">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={testing || dirty}
              className={cn(
                "ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5",
                (testing || dirty) && "opacity-50 cursor-not-allowed"
              )}
            >
              <Send className="h-3 w-3" />
              {testing ? "Sending..." : "Send test delivery"}
            </button>
            <span className="text-xs text-muted-foreground">
              {dirty
                ? "Save first: the test goes to the saved URL."
                : "Sends the newest email (or a sample) now, once."}
            </span>
          </div>
          {test && "delivered" in test ? (
            <div className="text-sm space-y-1">
              <p className={test.delivered ? "text-foreground" : "text-destructive"}>
                {test.delivered ? "Delivered" : "Not delivered"}
                {test.status !== null ? `: ${test.status}` : ""} in {test.durationMs} ms
                {test.error ? `. ${test.error}` : ""}
                {test.sample ? " (a sample email, as none has arrived yet)" : ""}
              </p>
              {test.excerpt && (
                <code className="ui-code block text-xs font-mono break-all whitespace-pre-wrap">
                  {test.excerpt}
                </code>
              )}
            </div>
          ) : test ? (
            <p className="text-sm text-destructive">{test.error}</p>
          ) : null}
        </div>
      )}

      {initialEnabled && recent && recent.length > 0 && (
        <div className="pt-4 border-t border-line/20">
          <p className="text-xs font-bold caps mb-2">Latest deliveries</p>
          <ul className="divide-y divide-line/20 text-sm">
            {recent.map((delivery) => (
              <li key={delivery.id} className="flex items-center gap-3 py-2">
                <span
                  className={cn(
                    "text-xs font-semibold w-[70px] shrink-0",
                    delivery.status === "succeeded" && "text-primary",
                    delivery.status === "failed" && "text-destructive",
                    delivery.status === "pending" && "text-muted-foreground"
                  )}
                >
                  {DELIVERY_LABEL[delivery.status]}
                </span>
                <span className="truncate flex-1 min-w-0">
                  {delivery.subject || "(no subject)"}
                </span>
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {delivery.lastStatus ?? (delivery.status === "pending" ? "..." : "-")}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(delivery.createdAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function NotificationsSection({ endpoint }: { endpoint: EndpointSettingsPanelProps["endpoint"] }) {
  const initial = endpoint.notificationUrl || "";
  const [url, setUrl] = useState(initial);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  useEffect(() => setUrl(initial), [initial]);
  return (
    <Section
      id="notifications"
      title="Notifications"
      description="Get a message when something arrives here."
      footer={
        <SaveFooter
          dirty={url !== initial}
          saving={saving}
          error={error}
          saved={saved}
          hint="Notification URL changed."
          onReset={() => {
            setUrl(initial);
            setError(null);
            setSaved(false);
          }}
          onSave={() => void save({ notificationUrl: url || null })}
        />
      }
    >
      <Field
        id="settings-notification-url"
        label="Notification URL"
        help="A JSON summary of each request is posted to this URL. Works with Slack, Discord, or your own server."
      >
        <input
          id="settings-notification-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.slack.com/services/..."
          className="ui-input w-full text-sm py-2!"
        />
      </Field>
    </Section>
  );
}

/** Team share and unshare failures answer `{ error }`: show the server's reason. */
async function readShareError(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" ? data.error : fallback;
}

function SharingSection({ endpointId }: { endpointId: string }) {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [teams, setTeams] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [shared, setShared] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const load = async () => {
      setError(null);
      try {
        const [teamsRes, endpointsRes] = await Promise.all([
          fetch("/api/teams", { headers: { Authorization: `Bearer ${accessToken}` } }),
          fetch("/api/endpoints", { headers: { Authorization: `Bearer ${accessToken}` } }),
        ]);
        if (teamsRes.ok)
          setTeams((await teamsRes.json()) as Array<{ id: string; name: string; role: string }>);
        if (endpointsRes.ok) {
          const data = (await endpointsRes.json()) as {
            owned: Array<{ id: string; sharedWith?: Array<{ teamId: string }> }>;
          };
          const own = data.owned.find((e) => e.id === endpointId);
          if (own?.sharedWith) setShared(new Set(own.sharedWith.map((s) => s.teamId)));
        }
      } catch {
        setError("Teams could not be loaded.");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [accessToken, endpointId]);

  const toggle = async (teamId: string, isShared: boolean) => {
    if (!accessToken) return;
    setToggling(teamId);
    setError(null);
    try {
      const res = isShared
        ? await fetch(`/api/teams/${teamId}/endpoints/${endpointId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accessToken}` },
          })
        : await fetch(`/api/teams/${teamId}/endpoints`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ endpointId }),
          });
      if (!res.ok) {
        setError(
          await readShareError(
            res,
            isShared ? "Sharing could not be stopped." : "The endpoint could not be shared."
          )
        );
        return;
      }
      setShared((prev) => {
        const next = new Set(prev);
        if (isShared) next.delete(teamId);
        else next.add(teamId);
        return next;
      });
    } catch {
      setError("Sharing could not be changed.");
    } finally {
      setToggling(null);
    }
  };

  if (loading || (teams.length === 0 && !error)) return null;

  return (
    <Section
      id="sharing"
      title="Team sharing"
      description="Share this endpoint with your teams. Changes apply at once."
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y divide-line/20">
        {teams.map((team) => {
          const isShared = shared.has(team.id);
          return (
            <li key={team.id} className="flex items-center justify-between py-2">
              <span className="text-sm">{team.name}</span>
              <button
                type="button"
                onClick={() => void toggle(team.id, isShared)}
                disabled={toggling === team.id}
                className={cn(
                  "text-xs px-2.5 py-1 border-strong border-line rounded-md transition-colors cursor-pointer",
                  isShared ? "bg-selected text-selected-foreground" : "hover:bg-muted"
                )}
              >
                {toggling === team.id ? "..." : isShared ? "Shared" : "Share"}
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function VerificationSection({ endpoint }: { endpoint: EndpointSettingsPanelProps["endpoint"] }) {
  const initialProvider = endpoint.signingProvider || "";
  const initialHeader = endpoint.signingHeader || "";
  const initialHasSecret = !!endpoint.hasSigningSecret;
  const [provider, setProvider] = useState(initialProvider);
  const [secret, setSecret] = useState("");
  const [header, setHeader] = useState(initialHeader);
  const [hasSecret, setHasSecret] = useState(initialHasSecret);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  const info = getWebProviderInfo(provider);

  const reset = useCallback(() => {
    setProvider(initialProvider);
    setSecret("");
    setHeader(initialHeader);
    setHasSecret(initialHasSecret);
  }, [initialProvider, initialHeader, initialHasSecret]);
  useEffect(reset, [reset]);

  const dirty =
    provider !== initialProvider ||
    secret !== "" ||
    header !== initialHeader ||
    hasSecret !== initialHasSecret;

  const onSave = () => {
    const updates: Record<string, unknown> = {};
    const validate = () => {
      const providerChanged = provider !== initialProvider;
      const hasConfiguredSecret = !providerChanged && hasSecret && !secret;
      if (provider && !secret && !hasConfiguredSecret) {
        throw new Error(
          `Enter a ${getWebProviderCredentialLabel(provider).toLowerCase()} before turning on verification.`
        );
      }
      if (provider === "generic-hmac" && !isValidSigningHeaderName(header)) {
        throw new Error(
          "Enter a signature header name using only letters, numbers, underscores, or hyphens."
        );
      }
      if (!provider && initialProvider) {
        updates.signingProvider = null;
        updates.signingSecret = null;
        updates.signingHeader = null;
        return;
      }
      if (providerChanged) {
        updates.signingProvider = provider || null;
        if (provider !== "generic-hmac") updates.signingHeader = null;
      }
      if (secret) updates.signingSecret = secret;
      if (provider === "generic-hmac" && header !== initialHeader)
        updates.signingHeader = header || null;
    };
    void save(updates, validate).then((ok) => ok && setSecret(""));
  };

  return (
    <Section
      id="verification"
      title="Signature verification"
      description="Check the signature on every HTTP request from a provider. Email is checked for SPF, DKIM and DMARC on its own."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint="Verification changed."
          onReset={() => {
            reset();
            setError(null);
            setSaved(false);
          }}
          onSave={onSave}
        />
      }
    >
      <Field
        id="settings-signing-provider"
        label="Provider"
        help="SendGrid uses IP allowlisting. Plaid verification needs Plaid API credentials, so it is template-only for now."
      >
        <select
          id="settings-signing-provider"
          value={provider}
          onChange={(e) => {
            const next = e.target.value;
            setProvider(next);
            setSecret("");
            setHasSecret(next === initialProvider && initialHasSecret);
            setHeader(
              next === "generic-hmac" && initialProvider === "generic-hmac" ? initialHeader : ""
            );
          }}
          className="ui-input w-full text-sm py-2!"
        >
          <option value="">None</option>
          {WEB_VERIFICATION_PROVIDER_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {provider && (
        <Field
          id="settings-signing-secret"
          label={getWebProviderCredentialLabel(provider)}
          help={
            hasSecret
              ? "Stored encrypted. Enter a new value to replace it."
              : "Stored encrypted and never shown again."
          }
        >
          <div className="flex gap-2">
            <input
              id="settings-signing-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                hasSecret
                  ? "Enter a new secret to replace it"
                  : (info?.secretPlaceholder ?? "Paste the secret here")
              }
              className="ui-input flex-1 text-sm font-mono py-2!"
            />
            {hasSecret && (
              <button
                type="button"
                onClick={() => {
                  setProvider("");
                  setSecret("");
                  setHasSecret(false);
                }}
                className="ui-btn-outline py-1.5! px-3! text-xs shrink-0"
              >
                Clear
              </button>
            )}
          </div>
        </Field>
      )}
      {provider === "generic-hmac" && (
        <Field id="settings-signing-header" label="Signature header">
          <input
            id="settings-signing-header"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
            placeholder="x-my-signature"
            className="ui-input w-full text-sm font-mono py-2!"
          />
        </Field>
      )}
      {hasSecret && provider && (
        <p className="flex items-center gap-1.5 text-xs text-primary font-semibold">
          <ShieldCheck className="h-3.5 w-3.5" />
          Verifying {getWebProviderLabel(provider) ?? provider} signatures
        </p>
      )}
    </Section>
  );
}

function DeleteSection({
  endpoint,
  requestCount,
}: {
  endpoint: EndpointSettingsPanelProps["endpoint"];
  requestCount?: number;
}) {
  const { session } = useAuth();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = endpoint.name || endpoint.slug;
  const what =
    requestCount === undefined
      ? "its requests"
      : `its ${requestCount} request${requestCount === 1 ? "" : "s"}`;

  const onDelete = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      if (!session?.access_token) throw new Error("Sign in again to delete this endpoint.");
      await deleteDashboardEndpoint(session.access_token, endpoint.slug);
      trackEndpointDeleted();
      emitDashboardEndpointsChanged();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The endpoint was not deleted.");
      setDeleting(false);
    }
  };

  return (
    <Section
      id="delete"
      danger
      title="Delete endpoint"
      description={`Removes ${name}, ${what} and ${endpoint.emailAddress ? "both addresses. Mail sent to the address afterwards bounces." : "its URL."}`}
      footer={
        <>
          <p
            role="status"
            aria-live="polite"
            className="text-xs flex-1 min-w-[180px] text-destructive"
          >
            {error ?? (confirm ? "This cannot be undone." : "")}
          </p>
          {confirm && (
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className="ui-btn-outline py-1.5! px-3! text-xs"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={deleting}
            className={cn(
              "ui-btn-outline py-1.5! px-3! text-xs",
              confirm
                ? "bg-destructive! text-destructive-foreground! border-destructive!"
                : "text-destructive"
            )}
          >
            {deleting ? "Deleting..." : confirm ? "Delete for good" : "Delete endpoint"}
          </button>
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function EndpointSettingsPanel({
  endpoint,
  requestCount,
  focusSection,
}: EndpointSettingsPanelProps) {
  // Owners see everything; members of a team the endpoint is shared with can
  // rename it and change its responses, but not delete it (the API enforces
  // the same split).
  const isOwner = endpoint.notificationUrl !== undefined;
  const sections = useMemo(
    () =>
      [
        { id: "receiving", label: "Receiving" },
        { id: "responses", label: "HTTP responses" },
        ...(isOwner
          ? [
              { id: "forwarding", label: "Forwarding" },
              { id: "notifications", label: "Notifications" },
              { id: "sharing", label: "Team sharing" },
              { id: "verification", label: "Signature verification" },
              { id: "delete", label: "Delete endpoint" },
            ]
          : []),
      ] as { id: SettingsSection; label: string }[],
    [isOwner]
  );
  const [active, setActive] = useState<SettingsSection>(focusSection ?? "receiving");
  const scroller = useRef<HTMLDivElement>(null);

  const jump = useCallback((id: SettingsSection) => {
    setActive(id);
    document
      .getElementById(`settings-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (focusSection)
      document.getElementById(`settings-${focusSection}`)?.scrollIntoView({ block: "start" });
  }, [focusSection]);

  // Scroll spy: the topmost section in view is the active one.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute(
          "data-settings-section"
        ) as SettingsSection | null;
        if (id) setActive(id);
      },
      { root, rootMargin: "0px 0px -60% 0px", threshold: 0 }
    );
    root.querySelectorAll("[data-settings-section]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0">
      <nav
        aria-label="Settings sections"
        className="shrink-0 md:w-56 md:border-r-strong md:border-line border-b-strong border-line md:border-b-0 flex md:flex-col gap-1 p-2 md:p-3 overflow-x-auto [scrollbar-width:none]"
      >
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => jump(section.id)}
            className={cn(
              "text-left whitespace-nowrap px-3 py-2 text-sm rounded-md cursor-pointer transition-colors",
              section.id === "delete" && "md:mt-3",
              active === section.id
                ? "bg-selected text-selected-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="max-w-[780px] p-4 md:p-6 space-y-6">
          <ReceivingSection endpoint={endpoint} />
          <ResponsesSection endpoint={endpoint} />
          {isOwner && <ForwardingSection endpoint={endpoint} />}
          {isOwner && <NotificationsSection endpoint={endpoint} />}
          {isOwner && <SharingSection endpointId={endpoint.id} />}
          {isOwner && <VerificationSection endpoint={endpoint} />}
          {isOwner && <DeleteSection endpoint={endpoint} requestCount={requestCount} />}
        </div>
      </div>
    </div>
  );
}
