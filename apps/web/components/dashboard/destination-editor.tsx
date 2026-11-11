"use client";

import {
  INBOUND_EMAIL_FORMATS,
  INBOUND_EMAIL_FORMAT_NAMES,
  isInboundEmailFormat,
  type InboundEmailFormat,
} from "@webhooks-cc/sdk/email";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Send, Trash2 } from "lucide-react";
import { conditionIssues, type Condition } from "@webhooks-cc/sdk";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createDestination,
  deleteDestination,
  fetchDashboardRequests,
  fetchDestinationSecret,
  previewDestination,
  rotateDestinationSecret,
  sendDestinationTest,
  updateDestination,
  type DashboardDestination,
  type DestinationFormatSetting,
  type DestinationInput,
  type DestinationPreviewResult,
  type ForwardTestResult,
} from "@/lib/dashboard-api";
import { isChatUrl } from "@/lib/forwarding/format";
import { checkSentField } from "@/lib/forwarding/timing";
import { chatServiceName, describeRetryWindow } from "@/lib/forwarding/display";
import { ConditionList } from "./condition-list";
import {
  AlwaysAddedHeaders,
  HeaderRowsEditor,
  SecretField,
  TestResult,
  headerIssueCount,
  headersInput,
  rowsFromHeaders,
  serializeRows,
  type HeaderRow,
} from "./forwarding-parts";
import { PlaceholderMenu, forwardingPlaceholders, insertAtCursor } from "./placeholder-menu";
import { Field, Segmented, Switch, SwitchRow, useConfirmStep } from "./settings-primitives";
import { useReportDirty } from "./dirty-sections";
import { SheetsDestinationEditor } from "./sheets-destination-editor";
import { FileDropDestinationEditor } from "./file-drop-destination-editor";

/**
 * One destination's settings, grouped by the questions they answer: where
 * it goes, what it gets, how it is sent, how it is signed, and the finer
 * points. A preview shows the exact request it would send for a captured
 * request, filter verdict included, as the fields change. Saved on its own,
 * like a separate resource.
 */

type Retry = 0 | 3600 | 86400;

export type DestinationPreset = "server" | "chat" | "template" | "inbound" | "sheets" | "file_drop";

/** "provider" stands for the four inbound shapes, chosen below it. */
type FormatChoice = Exclude<DestinationFormatSetting, InboundEmailFormat> | "provider";

/** The preview choice that means the newest request (Radix items need a value). */
const NEWEST_REQUEST = "__newest__";

const FORMAT_OPTIONS: { value: FormatChoice; label: string }[] = [
  { value: "auto", label: "Pick from the URL" },
  { value: "as_received", label: "As received" },
  { value: "json", label: "Signed JSON" },
  { value: "template", label: "Your JSON" },
  { value: "chat", label: "Chat message" },
];
const PROVIDER_OPTION: { value: FormatChoice; label: string } = {
  value: "provider",
  label: "Mail provider",
};

const PROVIDER_DESCRIPTIONS: Record<InboundEmailFormat, string> = {
  postmark:
    "Postmark's inbound JSON: FromFull, ToFull, TextBody, HtmlBody, StrippedTextReply, MailboxHash (the +tag) and Headers.",
  sendgrid:
    "SendGrid Inbound Parse: a multipart form with headers, text, html, envelope, SPF, dkim and spam_score.",
  mailgun:
    "A Mailgun route's form: body-plain, stripped-text, message-headers, and timestamp, token and signature, signed with your Mailgun key.",
  cloudmailin: "CloudMailin's JSON Normalized: envelope, headers, plain, html and reply_plain.",
};

const RETRY_OPTIONS: { value: `${Retry}`; label: string }[] = [
  { value: "0", label: "Never" },
  { value: "3600", label: "For 1 hour" },
  { value: "86400", label: "For 1 day" },
];

const STARTER_TEMPLATE = `{
  "event": "{{ json.type }}",
  "id": "{{ id }}",
  "receivedAt": "{{ receivedAt }}"
}`;
const STARTER_EMAIL_TEMPLATE = `{
  "subject": "{{ subject }}",
  "from": "{{ from.address }}",
  "code": "{{ codes.0 }}"
}`;

interface Draft {
  name: string;
  url: string;
  enabled: boolean;
  http: boolean;
  email: boolean;
  format: DestinationFormatSetting;
  logic: "and" | "or";
  conditions: Condition[];
  bodyTemplate: string;
  messageTemplate: string;
  rows: HeaderRow[];
  appendPath: boolean;
  retry: Retry;
  keepOrder: boolean;
  sentField: string;
  throttle: string;
  delay: string;
  attachments: "links" | "inline" | "none";
  /** A new Mailgun signing key; empty keeps the saved one. */
  mailgunKey: string;
}

function draftFrom(destination: DashboardDestination | null, preset: DestinationPreset): Draft {
  if (destination) {
    return {
      name: destination.name ?? "",
      url: destination.url,
      enabled: destination.enabled,
      http: destination.http,
      email: destination.email,
      format: destination.format,
      logic: destination.filter?.logic ?? "and",
      conditions: destination.filter?.conditions ?? [],
      bodyTemplate:
        destination.bodyTemplate === null || destination.bodyTemplate === undefined
          ? ""
          : JSON.stringify(destination.bodyTemplate, null, 2),
      messageTemplate: destination.messageTemplate ?? "",
      rows: rowsFromHeaders(destination.headers),
      appendPath: destination.appendPath,
      retry: destination.retrySeconds as Retry,
      keepOrder: destination.keepOrder,
      sentField: destination.sentField ?? "",
      throttle: destination.throttleSeconds ? String(destination.throttleSeconds) : "",
      delay: destination.delaySeconds ? String(destination.delaySeconds) : "",
      attachments: destination.attachments ?? "links",
      mailgunKey: "",
    };
  }
  return {
    name: "",
    url: "",
    enabled: true,
    // An inbound handler takes emails only, in Postmark's shape to start with.
    http: preset !== "inbound",
    email: true,
    format:
      preset === "chat"
        ? "chat"
        : preset === "template"
          ? "template"
          : preset === "inbound"
            ? "postmark"
            : "auto",
    logic: "and",
    conditions: [],
    bodyTemplate: preset === "template" ? STARTER_TEMPLATE : "",
    messageTemplate: "",
    rows: [],
    appendPath: true,
    retry: preset === "chat" ? 3600 : 86400,
    keepOrder: false,
    sentField: "",
    throttle: "",
    delay: "",
    attachments: "links",
    mailgunKey: "",
  };
}

/** What the draft would send to the API (header rows only when they changed). */
function inputOf(draft: Draft, headersChanged: boolean): DestinationInput | { error: string } {
  let bodyTemplate: unknown = null;
  if (draft.format === "template") {
    try {
      bodyTemplate = JSON.parse(draft.bodyTemplate);
    } catch {
      return { error: "The template is not valid JSON yet." };
    }
  }
  const seconds = (text: string) => (text.trim() === "" ? 0 : Number(text));
  return {
    name: draft.name.trim() || null,
    url: draft.url.trim(),
    enabled: draft.enabled,
    http: draft.http,
    email: draft.email,
    format: draft.format,
    filter:
      draft.conditions.length > 0 ? { logic: draft.logic, conditions: draft.conditions } : null,
    bodyTemplate: draft.format === "template" ? bodyTemplate : null,
    messageTemplate:
      draft.format === "chat" && draft.messageTemplate.trim() ? draft.messageTemplate : null,
    appendPath: draft.appendPath,
    retrySeconds: draft.retry,
    keepOrder: draft.keepOrder,
    sentField: draft.sentField.trim() || null,
    throttleSeconds: seconds(draft.throttle),
    delaySeconds: seconds(draft.delay),
    attachments: draft.attachments,
    ...(headersChanged ? { headers: headersInput(draft.rows) } : {}),
    ...(draft.format === "mailgun" && draft.mailgunKey.trim()
      ? { mailgunSigningKey: draft.mailgunKey.trim() }
      : {}),
  };
}

function prettyBody(body: string | null, contentType: string | undefined): string {
  if (body === null) return "(binary body)";
  if (!body) return "(empty body)";
  if (contentType?.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

function DeliveryPreview({
  slug,
  destinationId,
  input,
  blocked,
  kinds,
}: {
  slug: string;
  destinationId: string | null;
  input: DestinationInput | null;
  blocked: string | null;
  kinds: { http: boolean; email: boolean };
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [requests, setRequests] = useState<
    { id: string; label: string; kind: "http" | "email" }[] | null
  >(null);
  const [requestId, setRequestId] = useState("");
  const [result, setResult] = useState<DestinationPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchDashboardRequests(accessToken, slug, 20)
      .then((rows) => {
        if (cancelled) return;
        setRequests(
          rows.map((row) => {
            const kind = (row.kind ?? "http") as "http" | "email";
            const time = new Date(row.receivedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            });
            return {
              id: row._id,
              kind,
              label:
                kind === "email"
                  ? `Email: ${row.email?.subject || "(no subject)"} at ${time}`
                  : `${row.method} ${row.path} at ${time}`,
            };
          })
        );
      })
      .catch(() => !cancelled && setRequests([]));
    return () => {
      cancelled = true;
    };
  }, [accessToken, slug]);

  const inputJson = JSON.stringify(input);
  useEffect(() => {
    if (!accessToken || blocked || !input) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewDestination(
        accessToken,
        slug,
        {
          ...(destinationId ? { destinationId } : {}),
          destination: JSON.parse(inputJson) as DestinationInput,
          requestId: requestId || null,
        },
        controller.signal
      )
        .then((next) => {
          setResult(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "The preview could not be loaded.");
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // input is compared through inputJson.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, slug, destinationId, inputJson, requestId, blocked]);

  const options = (requests ?? []).filter((row) =>
    row.kind === "email" ? kinds.email : kinds.http
  );
  let verdict: React.ReactNode = null;
  if (result) {
    if (!result.takesKind) {
      verdict = (
        <p className="text-muted-foreground">
          Not sent: this destination does not take{" "}
          {result.request.kind === "email" ? "emails" : "HTTP requests"}.
        </p>
      );
    } else if (!result.filterPasses) {
      verdict = (
        <p className="text-muted-foreground">
          Filtered out: this request does not match the conditions above, so nothing is sent.
        </p>
      );
    } else if (result.error) {
      verdict = <p className="text-destructive-ink">Not sent: {result.error}</p>;
    } else {
      verdict = (
        <p>
          <span className="font-semibold">This is what goes out</span>
          {result.request.sample ? " (for a sample, as nothing has arrived yet)" : ""}.
        </p>
      );
    }
  }
  const delivery = result?.takesKind && result.filterPasses ? result.delivery : null;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`preview-${destinationId ?? "new"}`} className="text-sm font-semibold">
          Preview with
        </label>
        {/* Radix items cannot carry an empty value, so the newest has its own. */}
        <Select
          value={requestId || NEWEST_REQUEST}
          onValueChange={(value) => setRequestId(value === NEWEST_REQUEST ? "" : value)}
        >
          <SelectTrigger
            id={`preview-${destinationId ?? "new"}`}
            className="ui-input h-auto text-[13px] font-mono py-1.5! px-2! min-w-0 flex-1 max-w-[30rem]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={NEWEST_REQUEST} className="text-[13px] font-mono">
              {options.length === 0 && requests !== null
                ? "A sample (nothing captured yet)"
                : "The newest it would get"}
            </SelectItem>
            {options.map((row) => (
              <SelectItem key={row.id} value={row.id} className="text-[13px] font-mono">
                {row.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div role="status" aria-live="polite" className="space-y-2 text-sm">
        {blocked ? (
          <p className="text-muted-foreground">{blocked}</p>
        ) : error ? (
          <p className="text-destructive-ink">{error}</p>
        ) : result ? (
          <>
            {verdict}
            {delivery && (
              <pre className="ui-code text-xs! leading-[18px] p-3! whitespace-pre-wrap break-all max-h-80 overflow-auto">
                <span className="font-bold">
                  {delivery.method} {delivery.url}
                </span>
                {Object.entries(delivery.headers).map(([name, value]) => (
                  <span key={name}>
                    {"\n"}
                    <span className="syntax-property">{name}</span>
                    <span className="text-muted-foreground">: {value}</span>
                  </span>
                ))}
                {"\n\n"}
                {prettyBody(delivery.body, delivery.headers["content-type"])}
              </pre>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">Loading the preview...</p>
        )}
      </div>
    </div>
  );
}

type EditorProps = Parameters<typeof GenericDestinationEditor>[0];

const FULL_URL_MESSAGE = "Enter a full URL, such as https://api.example.com/hooks.";
/** Why a local or private target cannot work, and what reaches one instead. */
function publicHostMessage(slug: string): string {
  return `Forwarding runs on our servers, so it cannot reach localhost, private networks or IP addresses. To send captures to your machine, run whk tunnel ${slug || "<slug>"} or use Replay on a request.`;
}

/**
 * The host a typed URL names, also when it was typed without a scheme
 * ("localhost:4000/hook" parses with "localhost:" as its scheme).
 */
function typedHost(url: string): string | null {
  for (const candidate of [url, `http://${url}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.hostname;
    } catch {
      // Try the next reading.
    }
  }
  return null;
}

/**
 * Whether a host is localhost or an IP address, which production refuses
 * (lib/forwarding/target.ts). Development can allow them, so this only blocks
 * in a production build and the server has the last word everywhere else.
 */
function isLocalOrIpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether a host is this machine or a private network: what someone types to
 * reach a server on their own computer. Checked in every build, so outside
 * production (which may allow such targets) it still says how to reach one.
 */
function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    return true;
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * The server's reasons for refusing a destination URL (checkForwardUrl), so
 * one is shown under the field it is about rather than only in the footer.
 */
function urlFieldMessage(serverMessage: string, slug: string): string | null {
  if (serverMessage.startsWith("Use a public host name")) return publicHostMessage(slug);
  if (serverMessage.startsWith("Enter a full URL")) return FULL_URL_MESSAGE;
  const urlReasons = [
    "Enter the URL to send to",
    "Put credentials in",
    "The URL must use https",
    "Port ",
    "That is a webhooks.cc capture URL",
  ];
  return urlReasons.some((reason) => serverMessage.startsWith(reason)) ? serverMessage : null;
}

/** The editor for a destination: Google Sheets and file drops have their own, every other kind shares one. */
export function DestinationEditor(props: EditorProps) {
  if (props.preset === "sheets" || props.destination?.format === "sheets") {
    return <SheetsDestinationEditor {...props} />;
  }
  if (props.preset === "file_drop" || props.destination?.format === "file_drop") {
    return <FileDropDestinationEditor {...props} />;
  }
  return <GenericDestinationEditor {...props} />;
}

function GenericDestinationEditor({
  slug,
  destination,
  preset = "server",
  signingConfigured,
  emailFieldNames = [],
  onSaved,
  onDeleted,
  onCancel,
}: {
  slug: string;
  /** null for a new destination. */
  destination: DashboardDestination | null;
  preset?: DestinationPreset;
  /** Whether the endpoint checks signatures (a filter can then use the result). */
  signingConfigured: boolean;
  /** The endpoint's named email fields, for templates and filters. */
  emailFieldNames?: string[];
  onSaved: (saved: DashboardDestination) => void;
  onDeleted?: () => void;
  /** Closes a new destination without saving it. */
  onCancel?: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  // The saved values, replaced only when they change or after a save here. The
  // list is read again every few seconds, which hands this editor a new
  // destination object with the same values; resetting on that would throw
  // away what is being typed.
  const fresh = useMemo(() => draftFrom(destination, preset), [destination, preset]);
  const [savedCount, setSavedCount] = useState(0);
  const freshKey = `${savedCount}:${JSON.stringify({ ...fresh, rows: serializeRows(fresh.rows) })}`;
  const [initialState, setInitialState] = useState({ key: freshKey, draft: fresh });
  if (initialState.key !== freshKey) setInitialState({ key: freshKey, draft: fresh });
  const initial = initialState.draft;
  const [draft, setDraft] = useState<Draft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A URL the server refused, with its reason, shown under the field until the URL changes.
  const [refusedUrl, setRefusedUrl] = useState<{ url: string; message: string } | null>(null);
  const {
    armed: confirmArmed,
    arm: armConfirm,
    cancel: cancelConfirm,
    settled: confirmSettled,
    cancelRef: keepRef,
  } = useConfirmStep();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<
    (ForwardTestResult & { filterPasses: boolean }) | { error: string } | null
  >(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  // The URL field can sit far above the save button: focusing it scrolls it into view.
  const focusUrl = () => requestAnimationFrame(() => urlRef.current?.focus());
  const idPrefix = `destination-${destination?.id ?? "new"}`;

  useEffect(() => {
    setDraft(initial);
    setSubmitted(false);
  }, [initial]);

  const set = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };

  // What the URL and format mean together.
  const url = draft.url.trim();
  const chatUrl = isChatUrl(url);
  const service = chatServiceName(url);
  const autoFormat = chatUrl ? "chat" : draft.http ? "as_received" : "json";
  const effective = draft.format === "auto" ? autoFormat : draft.format;
  const provider = isInboundEmailFormat(draft.format) ? draft.format : null;
  const formatChoice: FormatChoice = provider ? "provider" : (draft.format as FormatChoice);
  const formatOptions = draft.email ? [...FORMAT_OPTIONS, PROVIDER_OPTION] : FORMAT_OPTIONS;
  const chat = effective === "chat";
  const headersChanged = serializeRows(draft.rows) !== serializeRows(initial.rows);
  const dirty =
    JSON.stringify({ ...draft, rows: null }) !== JSON.stringify({ ...initial, rows: null }) ||
    headersChanged;

  // Problems that keep it from saving.
  // A server on this machine or a private network: production refuses it, and
  // everywhere the field says what reaches one instead.
  const host = url ? typedHost(url) : null;
  const localTarget = host !== null && isLocalNetworkHost(host);
  const production = process.env.NODE_ENV === "production";
  const urlError = (() => {
    if (!url) return "Enter the URL to send to.";
    if (production && host !== null && (localTarget || isLocalOrIpHost(host))) {
      return publicHostMessage(slug);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return FULL_URL_MESSAGE;
    }
    // "localhost:3000" parses with "localhost:" as its scheme: not a full URL either.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return FULL_URL_MESSAGE;
    if (refusedUrl && refusedUrl.url === draft.url) return refusedUrl.message;
    return null;
  })();
  const kindsError = !draft.http && !draft.email ? "Pick at least one." : null;
  const filterIssue = draft.conditions
    .flatMap((condition) => conditionIssues(condition, { use: "filter" }))
    .find((issue) => submitted || !issue.includes("is required"));
  const templateError = (() => {
    if (draft.format !== "template") return null;
    if (!draft.bodyTemplate.trim()) return "Write the JSON to send.";
    try {
      JSON.parse(draft.bodyTemplate);
      return null;
    } catch (err) {
      return `Not valid JSON yet: ${err instanceof Error ? err.message : "check the brackets and quotes"}.`;
    }
  })();
  const sentFieldError = draft.sentField.trim() ? checkSentField(draft.sentField.trim()) : null;
  const secondsError = (text: string, label: string) =>
    text.trim() && !(/^\d+$/.test(text.trim()) && Number(text) <= 3600)
      ? `${label} is a whole number of seconds up to 3,600.`
      : null;
  const throttleError = secondsError(draft.throttle, "The gap");
  const delayError = secondsError(draft.delay, "The wait");
  const problems = [
    urlError,
    kindsError,
    filterIssue ?? null,
    templateError,
    sentFieldError,
    throttleError,
    delayError,
  ].filter(Boolean) as string[];
  const problemCount = problems.length + headerIssueCount(draft.rows);

  const input = useMemo(() => {
    const value = inputOf(draft, headersChanged);
    return "error" in value ? null : value;
  }, [draft, headersChanged]);
  const previewBlocked =
    urlError || kindsError || templateError
      ? "The preview runs once the URL, what it gets and the template are filled in."
      : null;

  // Resolves true once it saved, for a save started from outside the editor.
  const runSave = async (): Promise<boolean> => {
    setSubmitted(true);
    if (!accessToken) return false;
    if (problemCount > 0) {
      setError(
        problemCount === 1
          ? "Fix the field marked above."
          : `Fix the ${problemCount} fields marked above.`
      );
      if (urlError) focusUrl();
      return false;
    }
    const value = inputOf(draft, headersChanged);
    if ("error" in value) {
      setError(value.error);
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const result = destination
        ? await updateDestination(accessToken, slug, destination.id, value)
        : await createDestination(accessToken, slug, { ...value, url: value.url! });
      setSaved(true);
      setSubmitted(false);
      // The draft starts over from what was saved, even when nothing the
      // list returns differs (a new signing key is never sent back).
      setSavedCount((count) => count + 1);
      onSaved(result);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "The destination could not be saved.";
      const fieldMessage = urlFieldMessage(message, slug);
      if (fieldMessage) {
        // The reason shows under Send to; the footer only points there.
        setRefusedUrl({ url: draft.url, message: fieldMessage });
        setSubmitted(true);
        setError("Fix the field marked above.");
        focusUrl();
      } else {
        setError(message);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  // A save asked for while one runs (Save and leave right after Save) is the
  // same save, not a second request that would add the destination twice.
  const savingRef = useRef<Promise<boolean> | null>(null);
  const save = (): Promise<boolean> => {
    savingRef.current ??= runSave().finally(() => {
      savingRef.current = null;
    });
    return savingRef.current;
  };

  // An edited destination counts as unsaved settings, like a section's own form.
  useReportDirty(dirty, save);

  const remove = async () => {
    if (!accessToken || !destination) return;
    try {
      await deleteDestination(accessToken, slug, destination.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The destination could not be removed.");
    }
  };

  const sendTest = async () => {
    if (!accessToken || !destination || testing) return;
    setTesting(true);
    try {
      setTest(await sendDestinationTest(accessToken, slug, destination.id));
    } catch (err) {
      setTest({ error: err instanceof Error ? err.message : "The test delivery failed." });
    } finally {
      setTesting(false);
    }
  };

  const insertInto = (
    ref: React.RefObject<HTMLTextAreaElement | null>,
    key: "bodyTemplate" | "messageTemplate",
    text: string
  ) => {
    const { value, cursor } = insertAtCursor(ref.current, draft[key], text);
    set({ [key]: value } as Partial<Draft>);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(cursor, cursor);
    });
  };

  const formatDescription = provider
    ? `${PROVIDER_DESCRIPTIONS[provider]} For testing the inbound handler you wrote for that provider against real mail. Attachment contents are never kept, so none are attached.${draft.http ? " HTTP requests go as received." : ""}`
    : effective === "as_received"
      ? `Relayed as it arrived: same method, headers and body bytes, so the sender's own signature (Stripe, GitHub, ...) still verifies on your server.${draft.email ? " Emails have no request to relay and go as signed JSON." : ""}`
      : effective === "json"
        ? "A JSON envelope with the request or email inside, signed with Standard Webhooks headers. One handler for both kinds."
        : effective === "template"
          ? "The JSON you write below, with fields of each request filled in, signed with Standard Webhooks headers. A value that is only a placeholder keeps its type, so amounts stay numbers."
          : "A message for a chat channel: the standard one (endpoint, method and path, when it arrived, and the start of the body), or your own text below.";
  const formatWarning =
    provider && !draft.email
      ? "A mail provider's shape is for emails, and this destination takes none: pick another format or tick Emails."
      : chatUrl && !chat
        ? `${service} expects a chat message; this format will be rejected by that URL.`
        : null;

  const summaryParts = [
    ...(chat || effective !== "as_received"
      ? []
      : [draft.appendPath ? "path appended" : "path not appended"]),
    describeRetryWindow(draft.retry),
    draft.keepOrder ? "one at a time" : "up to two at a time",
    ...(draft.throttle && Number(draft.throttle) > 0
      ? [`at most one every ${draft.throttle} s`]
      : []),
    ...(draft.delay && Number(draft.delay) > 0 ? [`sent ${draft.delay} s after it arrives`] : []),
    ...(draft.sentField.trim() ? [`sent time from ${draft.sentField.trim()}`] : []),
  ];
  const placeholders = forwardingPlaceholders(draft.http, draft.email, emailFieldNames);
  const showUrlError = submitted || !!draft.url;

  return (
    <div className="space-y-5">
      {/* Where */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field
          id={`${idPrefix}-url`}
          label="Send to"
          help={
            // Outside production a local target may save, so the reach note is a hint.
            localTarget && urlError !== publicHostMessage(slug)
              ? publicHostMessage(slug)
              : "An https URL on a public host, or a Slack or Discord incoming webhook."
          }
          error={showUrlError ? urlError : null}
          errorId={`${idPrefix}-url-error`}
        >
          <input
            ref={urlRef}
            id={`${idPrefix}-url`}
            type="url"
            value={draft.url}
            aria-invalid={showUrlError && urlError ? true : undefined}
            aria-describedby={showUrlError && urlError ? `${idPrefix}-url-error` : undefined}
            onChange={(e) => {
              set({ url: e.target.value });
              // The footer's pointer to a refused URL goes with the URL it was about.
              if (refusedUrl) {
                setRefusedUrl(null);
                setError(null);
              }
            }}
            placeholder="https://api.example.com/hooks/inbound"
            spellCheck={false}
            className="ui-input w-full text-sm font-mono py-2!"
          />
        </Field>
        <Field id={`${idPrefix}-name`} label="Name" help="Optional, for the list and the log.">
          <input
            id={`${idPrefix}-name`}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={chatUrl ? `${service} channel` : "Staging API"}
            maxLength={100}
            className="ui-input w-full text-sm py-2!"
          />
        </Field>
      </div>

      {/* What it gets */}
      <div className="pt-4 border-t border-border/20 space-y-3">
        <h3 className="text-sm font-semibold">What it gets</h3>
        <div
          role="group"
          aria-label="Kinds"
          className="flex flex-wrap items-center gap-x-5 gap-y-2"
        >
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={draft.http}
              onChange={(e) => set({ http: e.target.checked })}
              className="accent-foreground"
            />
            HTTP requests
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={draft.email}
              onChange={(e) => set({ email: e.target.checked })}
              className="accent-foreground"
            />
            Emails
          </label>
          {kindsError && <span className="text-xs text-destructive-ink">{kindsError}</span>}
        </div>
        <ConditionList
          conditions={draft.conditions}
          logic={draft.logic}
          use="filter"
          idPrefix={idPrefix}
          showRequired={submitted}
          emptyLabel="Everything it takes is sent. Add a condition to send only some of it."
          emailFieldNames={emailFieldNames}
          onChange={({ conditions, logic }) => set({ conditions, logic })}
        />
        {draft.conditions.some((condition) => condition.field === "signature") &&
          !signingConfigured && (
            <p className="text-xs text-muted-foreground max-w-[62ch]">
              The signature is only checked once Signature verification is set up for this endpoint;
              until then every request reads as missing.
            </p>
          )}
      </div>

      {/* How it is sent */}
      <div className="pt-4 border-t border-border/20 space-y-3">
        <h3 className="text-sm font-semibold">How it is sent</h3>
        <div className="space-y-1.5">
          <Segmented
            name="How it is sent"
            value={formatChoice}
            onChange={(choice) => {
              const format: DestinationFormatSetting =
                choice === "provider" ? (provider ?? "postmark") : choice;
              set({
                format,
                ...(format === "template" && !draft.bodyTemplate.trim()
                  ? { bodyTemplate: draft.http ? STARTER_TEMPLATE : STARTER_EMAIL_TEMPLATE }
                  : {}),
              });
            }}
            options={formatOptions}
          />
          {provider && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <label htmlFor={`${idPrefix}-provider`} className="text-xs text-muted-foreground">
                Shaped like
              </label>
              <Select
                value={provider}
                onValueChange={(value) => set({ format: value as InboundEmailFormat })}
              >
                <SelectTrigger
                  id={`${idPrefix}-provider`}
                  className="ui-input h-auto text-[13px] py-1.5! px-2! w-56"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INBOUND_EMAIL_FORMATS.map((format) => (
                    <SelectItem key={format} value={format} className="text-[13px]">
                      {INBOUND_EMAIL_FORMAT_NAMES[format]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="max-w-[62ch]">
              {draft.format === "auto"
                ? `From the URL: ${FORMAT_OPTIONS.find((o) => o.value === autoFormat)?.label.toLowerCase()}. `
                : ""}
              {formatDescription}
            </p>
            {formatWarning && <p className="text-destructive-ink">{formatWarning}</p>}
          </div>
        </div>

        {provider === "mailgun" && (
          <Field
            id={`${idPrefix}-mailgun-key`}
            label="Mailgun signing key"
            help="Your HTTP webhook signing key (Mailgun, Settings, API Security), so the signature field verifies in your handler. Stored encrypted, never shown again."
          >
            <input
              id={`${idPrefix}-mailgun-key`}
              type="password"
              autoComplete="off"
              value={draft.mailgunKey}
              onChange={(e) => set({ mailgunKey: e.target.value })}
              placeholder={
                destination?.hasMailgunSigningKey
                  ? "Saved. Type a new one to replace it."
                  : "Optional: without it, the signature field is empty"
              }
              className="ui-input w-full text-sm font-mono py-2!"
            />
          </Field>
        )}

        {draft.format === "template" && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label htmlFor={`${idPrefix}-template`} className="block text-xs font-bold">
                JSON to send
              </label>
              <PlaceholderMenu
                groups={placeholders}
                onInsert={(text) => insertInto(templateRef, "bodyTemplate", text)}
              />
            </div>
            <Textarea
              id={`${idPrefix}-template`}
              ref={templateRef}
              value={draft.bodyTemplate}
              onChange={(e) => set({ bodyTemplate: e.target.value })}
              rows={8}
              spellCheck={false}
              className="border border-border text-[13px] font-mono"
            />
            {templateError ? (
              <p className="text-xs text-destructive-ink">{templateError}</p>
            ) : (
              <p className="text-xs text-muted-foreground max-w-[62ch]">
                {
                  "Write the body you want, and put fields of each request in {{ }}. A missing field comes out as null."
                }
              </p>
            )}
          </div>
        )}

        {chat && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label htmlFor={`${idPrefix}-message`} className="block text-xs font-bold">
                Message
              </label>
              <PlaceholderMenu
                groups={placeholders}
                onInsert={(text) => insertInto(messageRef, "messageTemplate", text)}
              />
            </div>
            <Textarea
              id={`${idPrefix}-message`}
              ref={messageRef}
              value={draft.messageTemplate}
              onChange={(e) => set({ messageTemplate: e.target.value })}
              rows={3}
              placeholder="Leave empty for the standard message, or write your own: Invoice {{ json.data.object.id }} paid"
              className="border border-border text-[13px]"
            />
          </div>
        )}
      </div>

      {/* Signing and headers */}
      {!chat && (
        <div className="pt-4 border-t border-border/20 space-y-4">
          <h3 className="text-sm font-semibold">Signing and headers</h3>
          <Field label="Signing secret">
            {destination ? (
              <SecretField
                relay={effective === "as_received"}
                email={draft.email}
                load={() => fetchDestinationSecret(accessToken ?? "", slug, destination.id)}
                rotate={() => rotateDestinationSecret(accessToken ?? "", slug, destination.id)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Made when you save. Your server checks each delivery with it.
              </p>
            )}
          </Field>
          <Field
            label="Headers"
            help="Sent with every delivery, for example a token your server expects. Values are stored encrypted and hidden after saving."
          >
            <HeaderRowsEditor
              rows={draft.rows}
              onChange={(rows) => set({ rows })}
              idPrefix={idPrefix}
              showIssues={submitted}
            />
          </Field>
          <Field label="Always added">
            <AlwaysAddedHeaders relay={effective === "as_received"} slug={slug} />
          </Field>
        </div>
      )}

      {/* Advanced */}
      <details className="pt-4 border-t border-border/20 group">
        <summary className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-1 text-xs font-bold">
            <ChevronRight className="h-3 w-3 transition-transform motion-reduce:transition-none group-open:rotate-90" />
            Advanced
          </span>
          <span className="text-xs text-muted-foreground">
            {summaryParts.join(", ").replace(/^./, (c) => c.toUpperCase())}.
          </span>
        </summary>
        <div className="pt-4 space-y-4">
          {effective === "as_received" && (
            <SwitchRow
              id={`${idPrefix}-append-path`}
              label="Append the request path"
              checked={draft.appendPath}
              onChange={(appendPath) => set({ appendPath })}
              help={
                draft.appendPath
                  ? "The path after the slug is added to the URL: /stripe/events reaches https://your.server/hooks/stripe/events. Emails are not affected."
                  : "Off: every request goes to the URL exactly as written."
              }
            />
          )}
          <Field
            label="Retry failed deliveries"
            help={
              draft.retry === 0
                ? "One try per delivery. A failure shows in the log and can be redelivered by hand."
                : draft.retry === 3600
                  ? "After a failed try: 30 s, 2 min, 10 min and 30 min later, then marked failed."
                  : "After a failed try: 30 s, 2 min, 10 min, 30 min and 1 h later, then 3 h, 6 h and 12 h, then marked failed."
            }
          >
            <Segmented
              name="Retry failed deliveries"
              value={`${draft.retry}` as `${Retry}`}
              onChange={(next) => set({ retry: Number(next) as Retry })}
              options={RETRY_OPTIONS}
            />
          </Field>
          {draft.email && draft.format !== "chat" && (
            <Field
              label="Email attachments"
              help={
                draft.attachments === "inline"
                  ? "Contents as base64 in each delivery, up to 1 MB in all; larger ones as links. Postmark and CloudMailin shapes carry them too; SendGrid and Mailgun forms do not."
                  : draft.attachments === "links"
                    ? "A signed link per attachment (url), which downloads it while the email is kept."
                    : "Only each attachment's name, type and size."
              }
            >
              <Segmented<"links" | "inline" | "none">
                name="Email attachments"
                value={draft.attachments}
                onChange={(attachments) => set({ attachments })}
                options={[
                  { value: "links", label: "Links" },
                  { value: "inline", label: "Inline" },
                  { value: "none", label: "Names only" },
                ]}
              />
            </Field>
          )}
          <SwitchRow
            id={`${idPrefix}-keep-order`}
            label="Keep order"
            checked={draft.keepOrder}
            onChange={(keepOrder) => set({ keepOrder })}
            help={
              draft.keepOrder
                ? "One delivery at a time, in the order captured. A slow answer holds the rest back."
                : "Off: up to two at a time, so a slow answer does not hold the rest back, but two may overtake each other."
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={`${idPrefix}-throttle`}
              label="At most one every"
              help="Seconds between deliveries; the rest are not sent. 1 makes it a heads-up channel. Empty sends every request."
              error={throttleError}
            >
              <div className="flex items-center gap-1.5">
                <input
                  id={`${idPrefix}-throttle`}
                  inputMode="numeric"
                  value={draft.throttle}
                  onChange={(e) =>
                    set({ throttle: e.target.value.replace(/[^\d]/g, "").slice(0, 4) })
                  }
                  placeholder="0"
                  className="ui-input w-full text-sm font-mono py-2!"
                />
                <span className="text-xs text-muted-foreground">s</span>
              </div>
            </Field>
            <Field
              id={`${idPrefix}-delay`}
              label="Wait before sending"
              help="Seconds after the request arrives, like a service calling back later. Up to an hour."
              error={delayError}
            >
              <div className="flex items-center gap-1.5">
                <input
                  id={`${idPrefix}-delay`}
                  inputMode="numeric"
                  value={draft.delay}
                  onChange={(e) => set({ delay: e.target.value.replace(/[^\d]/g, "").slice(0, 4) })}
                  placeholder="0"
                  className="ui-input w-full text-sm font-mono py-2!"
                />
                <span className="text-xs text-muted-foreground">s</span>
              </div>
            </Field>
          </div>
          <Field
            id={`${idPrefix}-sent-field`}
            label="Sent time field"
            help="A field in the JSON body that holds when the sender sent the request, such as data.publishedAt. The log then shows how long each request took to reach webhooks.cc. Without one, standard timestamp headers are read where a sender has them."
            error={sentFieldError}
          >
            <input
              id={`${idPrefix}-sent-field`}
              value={draft.sentField}
              onChange={(e) => set({ sentField: e.target.value })}
              placeholder="publishedAt"
              className="ui-input w-full text-sm font-mono py-2!"
            />
          </Field>
        </div>
      </details>

      {/* Preview */}
      <div className="pt-4 border-t border-border/20">
        <DeliveryPreview
          slug={slug}
          destinationId={destination?.id ?? null}
          input={input}
          blocked={previewBlocked}
          kinds={{ http: draft.http, email: draft.email }}
        />
      </div>

      {/* Test */}
      {destination && (
        <div className="pt-4 border-t border-border/20 space-y-2">
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
                ? "Save first: the test uses the saved settings."
                : "Sends the newest request it would get (or a sample) now, once, whatever the filter says."}
            </span>
          </div>
          <div role="status" aria-live="polite" className="text-sm space-y-2">
            {test && "delivered" in test ? (
              <>
                <TestResult test={test} />
                {!test.filterPasses && (
                  <p className="text-xs text-muted-foreground">
                    The filter would have kept this one from going out; a test sends it anyway.
                  </p>
                )}
              </>
            ) : test ? (
              <p className="text-destructive-ink">{test.error}</p>
            ) : null}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-border/20">
        <div className="flex items-center gap-2">
          <Switch
            id={`${idPrefix}-enabled`}
            checked={draft.enabled}
            onChange={(enabled) => set({ enabled })}
            label="Destination on"
          />
          <label htmlFor={`${idPrefix}-enabled`} className="text-sm">
            {draft.enabled ? "On" : "Off"}
          </label>
        </div>
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "text-xs flex-1 min-w-[160px]",
            error ? "text-destructive-ink" : "text-muted-foreground"
          )}
        >
          {error ?? (saved && !dirty ? "Saved." : dirty ? "Not saved yet." : "")}
        </p>
        {/* Armed, "Keep it" takes Remove's place (and focus) and the
            confirmation is a new button before it, so a second press where
            the first one landed keeps the destination. */}
        {destination &&
          (confirmArmed ? (
            <>
              <button
                key="confirm"
                type="button"
                onClick={() => {
                  if (confirmSettled()) void remove();
                }}
                className="ui-btn-outline py-1.5! px-3! text-xs text-destructive-ink"
              >
                Remove destination
              </button>
              <button
                key="cancel"
                ref={keepRef}
                type="button"
                onClick={cancelConfirm}
                className="ui-btn-outline py-1.5! px-3! text-xs min-w-24"
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              key="arm"
              type="button"
              onClick={armConfirm}
              className="ui-btn-outline py-1.5! px-3! text-xs inline-flex items-center gap-1.5"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          ))}
        {(dirty || !destination) && (
          <button
            type="button"
            onClick={() => {
              if (!destination) onCancel?.();
              else {
                setDraft(initial);
                setSubmitted(false);
                setError(null);
              }
            }}
            className="ui-btn-outline py-1.5! px-3! text-xs"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={(!dirty && !!destination) || saving}
          className={cn(
            "ui-btn-primary py-1.5! px-3! text-xs",
            ((!dirty && !!destination) || saving) && "opacity-50 cursor-not-allowed"
          )}
        >
          {saving ? "Saving..." : destination ? "Save destination" : "Add destination"}
        </button>
      </div>
      {confirmArmed && (
        <p className="text-xs text-muted-foreground -mt-2">
          Deliveries still waiting for it are marked failed; its log stays.
        </p>
      )}
    </div>
  );
}
