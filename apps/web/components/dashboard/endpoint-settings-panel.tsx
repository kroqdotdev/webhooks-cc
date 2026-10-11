"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Mail, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import { ResponseRulesEditor } from "./response-rules-editor";
import { AddressPill } from "./endpoint-bar";
import { ForwardingSection } from "./forwarding-section";
import { DeliveriesSection } from "./deliveries-section";
import {
  Field,
  SaveFooter,
  Section,
  Switch,
  scrollToSection,
  useSave,
  type SettingsSection,
} from "./settings-primitives";
import {
  deleteDashboardEndpoint,
  emitDashboardEndpointsChanged,
  type DashboardEndpoint,
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

export type { SettingsSection } from "./settings-primitives";

interface EndpointSettingsPanelProps {
  endpoint: DashboardEndpoint & {
    mockResponse?: { delay?: number } & DashboardEndpoint["mockResponse"];
  };
  /** How many requests the endpoint holds, for the delete confirmation. */
  requestCount?: number;
  /** Scroll to this section when the panel opens. */
  focusSection?: SettingsSection | null;
  /** Opens a request from the delivery log, with its Deliveries tab active. */
  onOpenRequestDeliveries?: (requestId: string) => void;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function ReceivingSection({
  endpoint,
  isOwner,
}: {
  endpoint: EndpointSettingsPanelProps["endpoint"];
  isOwner: boolean;
}) {
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
                {!isOwner &&
                  " Only the endpoint's owner can change this, because it also decides what forwarding sends."}
              </p>
            </div>
            <Switch
              id="settings-extracts"
              checked={extracts}
              onChange={setExtracts}
              label="Show codes and links found in emails"
              disabled={!isOwner}
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

function NotificationsSection({ endpoint }: { endpoint: EndpointSettingsPanelProps["endpoint"] }) {
  const initial = endpoint.notificationUrl || "";
  const [url, setUrl] = useState(initial);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  useEffect(() => setUrl(initial), [initial]);
  const duplicate = !!url.trim() && url.trim() === (endpoint.forwardUrl ?? "").trim();
  return (
    <Section
      id="notifications"
      title="Notifications"
      description="A heads-up when something arrives: at most one message per second, sent at once, not retried and not logged."
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
        help={
          duplicate ? (
            <p className="text-destructive">
              This is also the forwarding URL, so the channel gets each request twice. Keep one of
              the two.
            </p>
          ) : (
            <p>
              Slack and Discord show the message as it is; any other server gets the JSON summary.
              Need every request, retried and logged? That is{" "}
              <a
                href="#settings-forwarding"
                className="underline underline-offset-2 text-foreground"
              >
                Forwarding
              </a>
              , above.
            </p>
          )
        }
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
  onOpenRequestDeliveries,
}: EndpointSettingsPanelProps) {
  // Owners see everything; members of a team the endpoint is shared with can
  // rename it and change its responses, but not change its email setting or
  // delete it (the API enforces the same split).
  const isOwner = endpoint.notificationUrl !== undefined;
  // The log exists once a forwarding URL was saved (its secret stays after the URL goes).
  const hasLog = isOwner && (!!endpoint.forwardUrl || endpoint.hasForwardSecret === true);
  const sections = useMemo(
    () =>
      [
        { id: "receiving", label: "Receiving" },
        { id: "responses", label: "HTTP responses" },
        ...(isOwner
          ? [
              { id: "forwarding", label: "Forwarding" },
              ...(hasLog ? [{ id: "deliveries", label: "Deliveries", nested: true }] : []),
              { id: "notifications", label: "Notifications" },
              { id: "sharing", label: "Team sharing" },
              { id: "verification", label: "Signature verification" },
              { id: "delete", label: "Delete endpoint" },
            ]
          : []),
      ] as { id: SettingsSection; label: string; nested?: boolean }[],
    [isOwner, hasLog]
  );
  const [active, setActive] = useState<SettingsSection>(focusSection ?? "receiving");
  const scroller = useRef<HTMLDivElement>(null);

  const jump = useCallback((id: SettingsSection) => {
    setActive(id);
    scrollToSection(id);
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
              section.nested && "md:pl-6",
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
          <ReceivingSection endpoint={endpoint} isOwner={isOwner} />
          <ResponsesSection endpoint={endpoint} />
          {isOwner && (
            <ForwardingSection endpoint={endpoint} onSeeDeliveries={() => jump("deliveries")} />
          )}
          {hasLog && (
            <DeliveriesSection
              endpoint={endpoint}
              onOpenRequest={(requestId) => onOpenRequestDeliveries?.(requestId)}
            />
          )}
          {isOwner && <NotificationsSection endpoint={endpoint} />}
          {isOwner && <SharingSection endpointId={endpoint.id} />}
          {isOwner && <VerificationSection endpoint={endpoint} />}
          {isOwner && <DeleteSection endpoint={endpoint} requestCount={requestCount} />}
        </div>
      </div>
    </div>
  );
}
