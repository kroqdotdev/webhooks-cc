"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Mail, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { ResponsesSection } from "./responses-section";
import { AddressPill } from "./endpoint-bar";
import { DestinationsSection } from "./destinations-section";
import { DeliveriesSection } from "./deliveries-section";
import { EmailFieldsEditor } from "./email-fields-editor";
import { RetentionSection } from "./retention-section";
import { LayoutsSection } from "./layouts-section";
import { AlertsSection } from "./alerts-section";
import { emailFieldIssues, type EmailField } from "@webhooks-cc/sdk/email";
import {
  Field,
  SaveFooter,
  Section,
  SwitchRow,
  scrollToSection,
  useSave,
  type SettingsSection,
} from "./settings-primitives";
import {
  deleteDashboardEndpoint,
  emitDashboardEndpointsChanged,
  type DashboardEndpoint,
} from "@/lib/dashboard-api";
import { isValidSigningHeaderName } from "@/lib/signing-config";
import { trackEndpointDeleted } from "@/lib/analytics";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import {
  getWebProviderCredentialLabel,
  getWebProviderInfo,
  getWebProviderLabel,
  WEB_VERIFICATION_PROVIDER_OPTIONS,
} from "@/lib/provider-catalog";

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
  const initialFieldsKey = JSON.stringify(endpoint.emailFields ?? []);
  const [name, setName] = useState(initialName);
  const [extracts, setExtracts] = useState(initialExtracts);
  const [fields, setFields] = useState<EmailField[]>(() => endpoint.emailFields ?? []);
  const [triedSave, setTriedSave] = useState(false);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  const url = `${WEBHOOK_BASE_URL}/w/${endpoint.slug}`;

  useEffect(() => {
    setName(initialName);
    setExtracts(initialExtracts);
    setFields(JSON.parse(initialFieldsKey) as EmailField[]);
  }, [initialName, initialExtracts, initialFieldsKey]);

  const fieldsChanged = JSON.stringify(fields) !== initialFieldsKey;
  const emailChanged = extracts !== initialExtracts || fieldsChanged;
  const dirty = name !== initialName || emailChanged;
  const hint =
    name !== initialName && emailChanged
      ? "Name and email settings changed."
      : name !== initialName
        ? "Name changed."
        : "Email settings changed.";

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
            setFields(JSON.parse(initialFieldsKey) as EmailField[]);
            setTriedSave(false);
            setError(null);
            setSaved(false);
          }}
          onSave={() => {
            setTriedSave(true);
            void save(
              {
                // An emptied name is saved as "" (the dashboard then shows the slug).
                ...(name !== initialName ? { name: name.trim() } : {}),
                ...(extracts !== initialExtracts ? { showEmailExtracts: extracts } : {}),
                ...(fieldsChanged ? { emailFields: fields } : {}),
              },
              () => {
                const [problem] = emailFieldIssues(fields);
                if (problem) throw new Error(`Check the fields: ${problem}.`);
              }
            );
          }}
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
          <div className="pt-4 border-t border-line/20 space-y-4">
            <h3 className="text-sm font-semibold">Picked out of emails</h3>
            <SwitchRow
              id="settings-extracts"
              label="Codes and links"
              help={
                <>
                  Verification codes and links found in each email, shown above it with copy buttons
                  and sent along when it is forwarded. Turn this off for endpoints that receive mail
                  you would rather not have scanned.
                  {!isOwner &&
                    " Only the endpoint's owner can change these, because they also decide what forwarding sends."}
                </>
              }
              checked={extracts}
              onChange={setExtracts}
              disabled={!isOwner}
            />
            <div>
              <p className="text-sm font-semibold">Your fields</p>
              <p className="text-xs text-muted-foreground mt-1 mb-3 max-w-[62ch]">
                Name a value and say where it is: a regular expression (RE2) whose first group is
                the value. It shows with the email, appears as <code>fields</code> in its JSON, and
                forwarding templates and filters read it as{" "}
                <code className="font-mono">{"{{ fields.invoice }}"}</code>.
              </p>
              <EmailFieldsEditor
                slug={endpoint.slug}
                fields={fields}
                onChange={setFields}
                disabled={!isOwner}
                showRequired={triedSave}
                emailAddress={endpoint.emailAddress}
              />
            </div>
          </div>
        </>
      )}
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
  // The log exists once a destination was added (its rows stay after it goes).
  const hasLog =
    isOwner && ((endpoint.destinationCount ?? 0) > 0 || endpoint.hasForwardSecret === true);
  const hasEmail = isOwner && !!endpoint.emailAddress;
  const sections = useMemo(
    () =>
      [
        // In the order a request meets them: it arrives, its signature is
        // checked, it is answered, and it is sent on.
        { id: "receiving", label: "Receiving" },
        ...(hasEmail ? [{ id: "layouts", label: "Layouts" }] : []),
        ...(isOwner ? [{ id: "retention", label: "Retention" }] : []),
        ...(isOwner ? [{ id: "verification", label: "Signature verification" }] : []),
        { id: "responses", label: "Responses" },
        ...(isOwner
          ? [
              { id: "forwarding", label: "Forwarding" },
              ...(hasLog ? [{ id: "deliveries", label: "Deliveries", nested: true }] : []),
              { id: "alerts", label: "Alerts" },
              { id: "sharing", label: "Team sharing" },
              { id: "delete", label: "Delete endpoint" },
            ]
          : []),
      ] as { id: SettingsSection; label: string; nested?: boolean }[],
    [isOwner, hasLog, hasEmail]
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
          {hasEmail && <LayoutsSection endpoint={endpoint} />}
          {isOwner && <RetentionSection endpoint={endpoint} />}
          {isOwner && <VerificationSection endpoint={endpoint} />}
          <ResponsesSection endpoint={endpoint} />
          {isOwner && (
            <DestinationsSection endpoint={endpoint} onSeeDeliveries={() => jump("deliveries")} />
          )}
          {hasLog && (
            <DeliveriesSection
              endpoint={endpoint}
              onOpenRequest={(requestId) => onOpenRequestDeliveries?.(requestId)}
            />
          )}
          {isOwner && <AlertsSection endpoint={endpoint} />}
          {isOwner && <SharingSection endpointId={endpoint.id} />}
          {isOwner && <DeleteSection endpoint={endpoint} requestCount={requestCount} />}
        </div>
      </div>
    </div>
  );
}
