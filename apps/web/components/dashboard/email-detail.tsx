"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FileDown,
  ImageOff,
  Info,
  Loader2,
  Paperclip,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { formatBytes, formatFullTimestamp } from "@/types/request";
import { useSite } from "@/components/providers/site-provider";
import type { EmailAddress, EmailAuth, EmailCapture, EmailSmtp } from "@/lib/email-capture";
import {
  buildEmailJson,
  extractFromEmail,
  replyText as findReplyText,
  type ExtractedLink,
  type ParsedEmail,
} from "@webhooks-cc/sdk/email";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  fetchAttachment,
  fetchEmailDetails,
  fetchRawEmail,
  replayRequest,
} from "@/lib/dashboard-api";
import { buildPreviewDocument, countImageReferences } from "@/lib/email-preview";
import { highlightBody } from "@/lib/highlight";
import {
  deliverabilityReport,
  type DeliverabilityReport,
  type Finding,
  type FindingGroup,
  type FindingStatus,
} from "@/lib/deliverability";
import { JsonTree } from "./json-tree";
import { NoteBar, useMoreToRight, type DisplayableRequest } from "./request-detail";
import { DeliveriesPane, type DeliveryEndpoint } from "./delivery-pane";
import { ParsedResult } from "./layouts-section";

type EmailTab =
  | "parsed"
  | "json"
  | "preview"
  | "text"
  | "headers"
  | "attachments"
  | "authentication"
  | "raw"
  | "deliveries";
type Verdict = "pass" | "fail" | "none";

interface EmailDetailProps {
  request: DisplayableRequest;
  /** The endpoint's "Show codes and links found in emails" setting. */
  showExtracts: boolean;
  /** For the JSON (it names the endpoint), the forwarding line above it and the Deliveries tab. */
  endpoint: DeliveryEndpoint & {
    name?: string | null;
    emailFields?: unknown[];
    layouts?: unknown[];
    destinationCount?: number;
  };
  /**
   * The owner can redeliver, read the email again (replay) and is pointed at
   * the Forwarding settings.
   */
  canManageForwarding: boolean;
  onOpenForwarding?: () => void;
  /** Opens Settings at Layouts (the owner's). */
  onOpenLayouts?: () => void;
  note?: string | null;
  onNoteChange?: (note: string) => void;
  /** The tab to open with, for a delivery opened from the log. */
  initialTab?: EmailTab;
  /** A parse finished while the email was open (the list only has what it loaded). */
  onParsed?: (requestId: string, parsed: ParsedEmail) => void;
}

/**
 * No event says a parse finished, so an open email the layouts are still
 * reading is asked for again: one that arrived in the last two minutes (or was
 * just read again), every two seconds for up to a minute.
 */
const PARSE_FRESH_MS = 2 * 60 * 1000;
const PARSE_POLL_MS = 2000;
const PARSE_WATCH_MS = 60 * 1000;

type ParseWatch =
  | { id: string; state: "reading"; mode: "new" | "again"; until: number }
  /** `layout`: the name of the layout that read it, null when none did (or no answer came). */
  | { id: string; state: "done"; mode: "new" | "again"; layout: string | null };

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback(async (text: string, key: string) => {
    if (!(await copyToClipboard(text))) return;
    setCopied(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  }, []);
  return { copied, copy };
}

/** The Raw tab shows at most this much of a stored message; the download has all of it. */
const RAW_DISPLAY_BYTES = 1024 * 1024;

/** The raw message as stored: bytes when it was not valid UTF-8, text otherwise. */
function rawMessage(
  request: DisplayableRequest
): { text: string; bytes: Uint8Array<ArrayBuffer> } | null {
  if (request.bodyRaw) {
    const binary = atob(request.bodyRaw);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), bytes };
  }
  if (request.body) return { text: request.body, bytes: new TextEncoder().encode(request.body) };
  return null;
}

/** The address with its +tag picked out, as people read it. */
function TaggedAddress({ address }: { address: string }) {
  const at = address.lastIndexOf("@");
  const local = at >= 0 ? address.slice(0, at) : address;
  const domain = at >= 0 ? address.slice(at) : "";
  const plus = local.indexOf("+");
  if (plus < 0) return <span className="font-mono text-[13px]">{address}</span>;
  return (
    <span className="font-mono text-[13px]">
      {local.slice(0, plus)}
      <span className="font-semibold text-kind-email-ink">{local.slice(plus)}</span>
      {domain}
    </span>
  );
}

function AddressLine({ addresses }: { addresses: EmailAddress[] }) {
  if (addresses.length === 0) return <span className="text-muted-foreground">Unknown</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {addresses.map((entry, index) => (
        <span key={`${entry.address}-${index}`} className="min-w-0">
          {entry.name && <span className="mr-1.5">{entry.name}</span>}
          {entry.address && (
            <span className={cn(entry.name && "text-muted-foreground")}>
              <TaggedAddress address={entry.address} />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** Pass and fail look like the method badges of each style; "none" is plain text. */
function VerdictBadge({ verdict, label }: { verdict: Verdict; label: string }) {
  if (verdict === "none") {
    return <span className="font-mono text-[11.5px] caps text-muted-foreground">{label}</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 h-6 px-2 font-mono text-[11.5px] font-bold caps rounded-sm border-strong border-line",
        "clean:border-transparent clean:font-medium",
        verdict === "pass"
          ? "bg-primary text-primary-foreground clean:bg-method-get/15 clean:text-method-get"
          : "bg-destructive text-destructive-foreground clean:bg-method-delete/15 clean:text-method-delete"
      )}
    >
      {verdict === "pass" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {label}
    </span>
  );
}

function verdictOf(result: string | null | undefined): Verdict {
  if (result === "pass") return "pass";
  if (result === "fail" || result === "softfail" || result === "permerror") return "fail";
  return "none";
}

function dkimVerdict(auth: EmailAuth): Verdict {
  if (auth.dkim.some((signature) => signature.result === "pass")) return "pass";
  if (auth.dkim.some((signature) => signature.result === "fail")) return "fail";
  return "none";
}

function tlsLabel(smtp: EmailSmtp | null): string | null {
  const version = smtp?.tls?.version;
  if (!version) return null;
  return version.replace(/^TLSv1_(\d)$/, "TLS 1.$1").replace(/^TLSv1$/, "TLS 1.0");
}

/** Sender check verdicts; a test email from the dashboard shows a Test badge instead. */
function Verdicts({
  email,
  report,
  onOpen,
}: {
  email: EmailCapture;
  report: DeliverabilityReport | null;
  onOpen: () => void;
}) {
  const auth = email.auth;
  const spam = spamChip(email);
  const issues = report ? issuesChip(report) : null;
  if (!auth || auth.error) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-xs text-muted-foreground">Sender checks could not run for this email.</p>
        {spam && (
          <button
            type="button"
            onClick={onOpen}
            className="cursor-pointer"
            title="Show the spam score"
          >
            <VerdictBadge verdict={spam.verdict} label={spam.label} />
          </button>
        )}
        {issues && (
          <button
            type="button"
            onClick={onOpen}
            className="cursor-pointer"
            title="Show the deliverability report"
          >
            <VerdictBadge verdict={issues.verdict} label={issues.label} />
          </button>
        )}
      </div>
    );
  }
  const spf = verdictOf(auth.spf?.result);
  const dkim = dkimVerdict(auth);
  const dmarc = verdictOf(auth.dmarc?.result);
  const tls = tlsLabel(email.smtp);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 cursor-pointer text-left"
      title="Show the authentication details"
    >
      <VerdictBadge
        verdict={spf}
        label={spf === "pass" ? "SPF" : spf === "fail" ? "SPF failed" : "No SPF"}
      />
      <VerdictBadge
        verdict={dkim}
        label={dkim === "pass" ? "DKIM" : dkim === "fail" ? "DKIM failed" : "No DKIM"}
      />
      <VerdictBadge
        verdict={dmarc}
        label={dmarc === "pass" ? "DMARC" : dmarc === "fail" ? "DMARC failed" : "No DMARC"}
      />
      <VerdictBadge verdict={tls ? "pass" : "none"} label={tls ?? "No TLS"} />
      {spam && <VerdictBadge verdict={spam.verdict} label={spam.label} />}
      {issues && <VerdictBadge verdict={issues.verdict} label={issues.label} />}
    </button>
  );
}

/** rspamd's actions, from least to most severe, in words. Never applied. */
const SPAM_ACTIONS: Record<string, string> = {
  "no action": "nothing",
  greylist: "a delay (greylisting)",
  "add header": "marking it as spam",
  "rewrite subject": "marking it as spam in the subject",
  "soft reject": "a temporary rejection",
  reject: "rejecting it",
};

/** The chip for a scored email; null when it was not scored. */
function spamChip(email: EmailCapture): { verdict: Verdict; label: string } | null {
  const spam = email.spam;
  if (!spam || spam.score === null || spam.action === null) return null;
  const score = spam.score.toFixed(1);
  if (spam.action === "no action" || spam.action === "greylist") {
    return { verdict: "pass", label: `Not spam ${score}` };
  }
  if (spam.action === "reject" || spam.action === "soft reject") {
    return { verdict: "fail", label: `Spam ${score}` };
  }
  return { verdict: "none", label: `Looks spammy ${score}` };
}

/** The chip that sums up the deliverability report: what is left to fix. */
function issuesChip(report: DeliverabilityReport): { verdict: Verdict; label: string } | null {
  const fails = report.findings.filter((finding) => finding.status === "fail").length;
  const warnings = report.findings.filter((finding) => finding.status === "warn").length;
  if (fails > 0) return { verdict: "fail", label: `${fails} to fix` };
  if (warnings > 0) return { verdict: "none", label: `${warnings} to improve` };
  return report.findings.length > 0 ? { verdict: "pass", label: "Deliverability" } : null;
}

const FINDING_GROUPS: { group: FindingGroup; title: string }[] = [
  { group: "authentication", title: "Domain setup" },
  { group: "server", title: "Sending server" },
  { group: "message", title: "Message" },
];

const STATUS_ORDER: Record<FindingStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

function FindingIcon({ status }: { status: FindingStatus }) {
  const Icon =
    status === "pass" ? Check : status === "fail" ? X : status === "warn" ? AlertTriangle : Info;
  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm",
        status === "pass" && "bg-method-get/15 text-method-get",
        status === "fail" && "bg-method-delete/15 text-method-delete",
        status === "warn" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        status === "info" && "bg-muted text-muted-foreground"
      )}
      aria-label={status}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

/** What a mailbox provider would hold against the email, as a checklist. */
function DeliverabilitySection({ report }: { report: DeliverabilityReport }) {
  const count = (status: FindingStatus) =>
    report.findings.filter((finding) => finding.status === status).length;
  const fails = count("fail");
  const warnings = count("warn");
  return (
    <section className="ui-card ui-card-static p-4!">
      <h3 className="text-sm font-bold caps mb-1">Deliverability</h3>
      <p className="text-sm py-2">
        {fails + warnings === 0
          ? "Nothing to fix: this email is set up the way Gmail, Yahoo and Outlook expect."
          : [fails > 0 && `${fails} to fix`, warnings > 0 && `${warnings} to improve`]
              .filter(Boolean)
              .join(", ") + ", from what mailbox providers look at."}{" "}
        <span className="text-muted-foreground">
          {report.setupRecorded
            ? "Records are as they were when the email arrived."
            : "The sender's DNS records were not recorded for this email, so only what the message shows is checked."}
        </span>
      </p>
      {FINDING_GROUPS.map(({ group, title }) => {
        const findings = report.findings
          .filter((finding) => finding.group === group)
          .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
        if (findings.length === 0) return null;
        return (
          <div key={group} className="mt-3">
            <h4 className="text-[11px] font-bold caps text-muted-foreground mb-1">{title}</h4>
            <ul>
              {findings.map((finding: Finding) => (
                <li
                  key={finding.id}
                  className="flex gap-2.5 py-2 border-t border-line/15 first:border-t-0 text-sm"
                >
                  <FindingIcon status={finding.status} />
                  <span className="min-w-0">
                    <span className="font-semibold">{finding.title}</span>
                    <span className="block text-muted-foreground clean:text-foreground/80 [overflow-wrap:anywhere]">
                      {finding.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** "label | value | buttons", the same idiom as the endpoint's address pills. */
function Pick({
  label,
  children,
  actions,
  wide,
  exactLabel,
}: {
  label: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  wide?: boolean;
  /** Show the label as written (a field's name, as templates read it). */
  exactLabel?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-stretch h-8 min-w-0 max-w-full border-strong border-line rounded-md bg-card shadow-raised-sm overflow-hidden",
        wide && "md:max-w-[460px]"
      )}
    >
      <span
        className={cn(
          "flex items-center px-2.5 bg-muted text-muted-foreground text-[11px] font-semibold border-r-strong border-line shrink-0 max-w-[220px] max-sm:max-w-[120px] max-sm:px-2",
          exactLabel ? "font-mono" : "caps"
        )}
        title={label}
      >
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-center px-2.5 max-sm:px-2 min-w-0">{children}</span>
      {actions}
    </span>
  );
}

function PickButton({
  label,
  onClick,
  href,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const className =
    "flex items-center justify-center w-8 shrink-0 border-l-strong border-line text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={className}
        aria-label={label}
        title={label}
      >
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className} aria-label={label} title={label}>
      {children}
    </button>
  );
}

/** Keeps both ends of a long piece of a link: "abcdefgh...uvwxyz". */
function middle(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = Math.ceil((keep - 3) / 2);
  return `${text.slice(0, head)}...${text.slice(text.length - (keep - 3 - head))}`;
}

/**
 * A link as a chip shows it: its host and its last path segment, cut in the
 * middle ("acme.example/.../confirm"), since what sits between is rarely read.
 * The chip's title, copy and open keep the whole URL.
 */
function shortLink(url: string): string {
  let host: string;
  let segments: string[];
  let search: string;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    segments = parsed.pathname.split("/").filter(Boolean);
    search = parsed.search;
  } catch {
    return middle(url.replace(/^https?:\/\//, ""), 48);
  }
  const query = search ? "?..." : "";
  if (segments.length === 0) return `${host}${query}`;
  const last = middle(segments[segments.length - 1], 24);
  return segments.length === 1 ? `${host}/${last}${query}` : `${host}/.../${last}${query}`;
}

function FoundInEmail({
  code,
  link,
  fields,
  copied,
  onCopy,
}: {
  code: string | null;
  link: ExtractedLink | null;
  /** The endpoint's named fields that found something, in their order. */
  fields: [name: string, value: string][];
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  if (!code && !link && fields.length === 0) return null;
  return (
    // At phone width: the label in one column, the chips stacked in the other.
    <div className="mt-2 text-sm max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)] max-sm:gap-x-3 max-sm:items-start sm:flex sm:flex-wrap sm:items-center sm:gap-2">
      <span className="text-muted-foreground mr-1 max-sm:mr-0 max-sm:w-16 max-sm:text-xs max-sm:leading-snug max-sm:pt-1">
        Found in this email
      </span>
      <div className="flex flex-col items-start gap-2 min-w-0 sm:contents">
        {fields.map(([name, value]) => (
          <Pick
            key={name}
            label={name}
            exactLabel
            actions={
              <PickButton label={`Copy ${name}`} onClick={() => onCopy(value, `field:${name}`)}>
                {copied === `field:${name}` ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </PickButton>
            }
          >
            <span className="font-mono text-[13px] truncate max-w-[260px]" title={value}>
              {value}
            </span>
          </Pick>
        ))}
        {code && (
          <Pick
            label="Code"
            actions={
              <PickButton label="Copy code" onClick={() => onCopy(code, "code")}>
                {copied === "code" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </PickButton>
            }
          >
            <span className="font-mono text-base font-semibold tracking-[0.12em]">{code}</span>
          </Pick>
        )}
        {link && (
          <Pick
            wide
            label={link.label ?? "Link"}
            actions={
              <>
                <PickButton label="Copy link" onClick={() => onCopy(link.url, "link")}>
                  {copied === "link" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </PickButton>
                <PickButton label="Open link in a new tab" href={link.url}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </PickButton>
              </>
            }
          >
            <span className="font-mono text-[13px] truncate" title={link.url}>
              {shortLink(link.url)}
            </span>
          </Pick>
        )}
      </div>
    </div>
  );
}

/** The email on a white sheet, sandboxed (see lib/email-preview.ts). */
function EmailPreview({ html, width }: { html: string; width: "desktop" | "mobile" }) {
  const { remote: remoteImages, inline: inlineImages } = useMemo(
    () => countImageReferences(html),
    [html]
  );
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [height, setHeight] = useState(480);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(
    () => buildPreviewDocument(html, { allowRemoteImages: imagesLoaded }),
    [html, imagesLoaded]
  );

  // Same-origin (but script-free) frame: the body's height is the email's
  // height, and it changes as images arrive, so follow it.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const measure = useCallback(() => {
    const body = frameRef.current?.contentDocument?.body;
    if (!body) return;
    const fit = () => setHeight(Math.min(Math.max(Math.ceil(body.scrollHeight), 160), 20000));
    fit();
    observer.current?.disconnect();
    observer.current = new ResizeObserver(fit);
    observer.current.observe(body);
  }, []);

  return (
    <div>
      {remoteImages > 0 && !imagesLoaded && (
        <div className="flex flex-wrap items-center gap-3 px-3 py-2 mb-4 text-sm bg-muted border-strong border-line rounded-md">
          <ImageOff className="h-4 w-4 shrink-0" />
          <span className="flex-1 min-w-[200px]">
            {remoteImages === 1 ? "1 remote image is" : `${remoteImages} remote images are`}{" "}
            blocked. Loading them tells the sender you opened this email.
          </span>
          <button
            type="button"
            onClick={() => setImagesLoaded(true)}
            className="ui-btn-outline py-1! px-3! text-xs"
          >
            Load images
          </button>
        </div>
      )}
      {inlineImages > 0 && (
        <p className="flex items-center gap-2 mb-4 text-xs text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5 shrink-0" />
          {inlineImages === 1
            ? "1 image is attached inside the message and shows as broken here; download it from the Attachments tab."
            : `${inlineImages} images are attached inside the message and show as broken here; download them from the Attachments tab.`}
        </p>
      )}
      <div className="grid justify-items-center py-2 classic:py-1 clean:bg-muted/60 clean:rounded-lg clean:py-8 clean:px-4 grid-cols-[minmax(0,1fr)]">
        <div
          className="w-full bg-white border-strong border-line rounded-md shadow-raised-lg overflow-hidden"
          style={{ maxWidth: width === "mobile" ? 390 : 680 }}
        >
          <iframe
            ref={frameRef}
            title="Email preview"
            sandbox="allow-same-origin"
            srcDoc={srcDoc}
            onLoad={measure}
            className="block w-full border-0 bg-white"
            style={{ height }}
          />
        </div>
      </div>
    </div>
  );
}

function CheckRow({
  name,
  verdict,
  label,
  children,
}: {
  name: string;
  verdict: Verdict;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[96px_1fr] md:grid-cols-[120px_120px_1fr] gap-x-3 gap-y-1 items-baseline py-2.5 border-t border-line/15 first:border-t-0 text-sm">
      <span className="font-mono text-xs font-semibold">{name}</span>
      <span>
        <VerdictBadge verdict={verdict} label={label} />
      </span>
      <span className="col-span-2 md:col-span-1 text-muted-foreground clean:text-foreground">
        {children}
      </span>
    </div>
  );
}

/** rspamd's verdict and the rules that weighed most. */
function SpamSection({ spam }: { spam: NonNullable<EmailCapture["spam"]> }) {
  const scored = spam.score !== null && spam.required !== null && spam.action !== null;
  return (
    <section className="ui-card ui-card-static p-4!">
      <h3 className="text-sm font-bold caps mb-1">Spam score</h3>
      {!scored ? (
        <p className="text-sm text-muted-foreground py-2">
          No score for this email{spam.error ? ` (${spam.error})` : ""}. It was captured as usual.
        </p>
      ) : (
        <>
          <p className="text-sm py-2">
            rspamd scored this email{" "}
            <span className="font-mono font-semibold">{spam.score!.toFixed(2)}</span>; it would
            reject from <span className="font-mono">{spam.required!.toFixed(0)}</span>. Its
            suggestion: {SPAM_ACTIONS[spam.action!] ?? spam.action}.{" "}
            <span className="text-muted-foreground">
              Nothing is applied: every email that reaches an address is captured.
            </span>
          </p>
          {spam.symbols.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-bold caps text-muted-foreground">
                  <th className="py-1.5 pr-3 font-bold">Rule</th>
                  <th className="py-1.5 pr-3 font-bold text-right">Score</th>
                  <th className="py-1.5 font-bold">Matched</th>
                </tr>
              </thead>
              <tbody>
                {spam.symbols.map((symbol) => (
                  <tr key={symbol.name} className="border-t border-line/15 align-baseline">
                    <td className="py-1.5 pr-3 font-mono text-xs [overflow-wrap:anywhere]">
                      {symbol.name}
                    </td>
                    <td
                      className={cn(
                        "py-1.5 pr-3 font-mono text-xs text-right whitespace-nowrap",
                        symbol.score > 0 && "text-destructive-ink",
                        symbol.score < 0 && "text-primary-ink"
                      )}
                    >
                      {symbol.score > 0 ? "+" : ""}
                      {symbol.score.toFixed(2)}
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {symbol.options?.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function AuthenticationPane({
  email,
  ip,
  report,
  isTest,
}: {
  email: EmailCapture;
  ip: string;
  report: DeliverabilityReport | null;
  /** A test email sent from the dashboard, which no sender checks apply to. */
  isTest: boolean;
}) {
  const auth = email.auth;
  const arc = auth?.arc;
  const smtp = email.smtp;
  const clientIp = smtp?.clientIp || ip || "the sending server";
  const spf = auth?.spf;
  const dmarc = auth?.dmarc;
  const iprev = auth?.iprev;
  const tls = tlsLabel(smtp);
  const resultLabel = (verdict: Verdict) =>
    verdict === "pass" ? "Passed" : verdict === "fail" ? "Failed" : "None";

  return (
    <div className="grid gap-4 max-w-[860px]">
      <section className="ui-card ui-card-static p-4!">
        <h3 className="text-sm font-bold caps mb-1">Sender checks</h3>
        {isTest ? (
          <p className="text-sm text-muted-foreground py-2">
            This is a test email sent from the dashboard, so SPF, DKIM and DMARC do not apply. Mail
            from a real sender shows its results here.
          </p>
        ) : !auth || auth.error ? (
          <p className="text-sm text-muted-foreground py-2">
            The checks could not run for this email{auth?.error ? ` (${auth.error})` : ""}.
          </p>
        ) : (
          <>
            <CheckRow
              name="SPF"
              verdict={verdictOf(spf?.result)}
              label={resultLabel(verdictOf(spf?.result))}
            >
              {!spf || spf.result === "none"
                ? `${spf?.domain ?? "The sender's domain"} publishes no SPF record that covers ${clientIp}.`
                : spf.result === "pass"
                  ? `${spf.domain} lists ${clientIp} as allowed to send its mail.`
                  : spf.result === "fail"
                    ? `${spf.domain} does not list ${clientIp} as a server allowed to send its mail.`
                    : spf.result === "softfail"
                      ? `${spf.domain} says ${clientIp} is probably not allowed to send its mail.`
                      : `The SPF record of ${spf.domain ?? "the sender's domain"} could not be checked (${spf.result}).`}
            </CheckRow>
            <CheckRow
              name="DKIM"
              verdict={dkimVerdict(auth)}
              label={resultLabel(dkimVerdict(auth))}
            >
              {auth.dkim.length === 0
                ? "The email carries no DKIM signature, so nothing could be checked."
                : auth.dkim
                    .map((signature) =>
                      signature.result === "pass"
                        ? `Signed by ${signature.domain}${signature.selector ? ` (selector ${signature.selector})` : ""} and the signature matches.`
                        : `Signed by ${signature.domain ?? "an unknown domain"}, but the signature does not check out (${signature.result}).`
                    )
                    .join(" ")}
            </CheckRow>
            <CheckRow
              name="DMARC"
              verdict={verdictOf(dmarc?.result)}
              label={resultLabel(verdictOf(dmarc?.result))}
            >
              {!dmarc || dmarc.result === "none"
                ? `${dmarc?.domain ?? "The sender's domain"} publishes no DMARC policy, so nothing was enforced.`
                : dmarc.result === "skipped"
                  ? `Not checked${dmarc.reason ? `: ${dmarc.reason}` : ""}.`
                  : dmarc.result === "permerror"
                    ? `The DMARC record of ${dmarc.domain} could not be read (permerror).`
                    : dmarc.result === "temperror"
                      ? `The DMARC record of ${dmarc.domain} could not be looked up (temperror).`
                      : dmarc.result === "pass"
                        ? `The email passes the DMARC policy of ${dmarc.domain}.`
                        : `The email fails the DMARC policy of ${dmarc.domain}${dmarc.policy ? ` (policy: ${dmarc.policy})` : ""}.`}
            </CheckRow>
            <CheckRow
              name="Reverse DNS"
              verdict={verdictOf(iprev?.result)}
              label={resultLabel(verdictOf(iprev?.result))}
            >
              {iprev?.result === "pass" && iprev.ptr
                ? `${clientIp} resolves to ${iprev.ptr} and back.`
                : `${clientIp} has no reverse DNS name that resolves back to it.`}
            </CheckRow>
            {arc && (arc.sets > 0 || arc.result === "skipped") && (
              <CheckRow
                name="ARC"
                verdict={verdictOf(arc.result)}
                label={resultLabel(verdictOf(arc.result))}
              >
                {arc.result === "pass"
                  ? `Forwarded by ${arc.sealers.join(", ") || `${arc.sets} ${arc.sets === 1 ? "server" : "servers"}`}; every hop sealed what it received.`
                  : arc.result === "skipped"
                    ? `Not checked${arc.reason ? `: ${arc.reason}` : ""}.`
                    : `Forwarded by ${arc.sealers.join(", ") || `${arc.sets} ${arc.sets === 1 ? "server" : "servers"}`}, but the chain does not verify (${arc.result}).`}
              </CheckRow>
            )}
            {auth.authenticationResults && (
              <pre className="ui-code text-xs! whitespace-pre-wrap break-all mt-3 shadow-none!">
                Authentication-Results: {auth.authenticationResults}
              </pre>
            )}
          </>
        )}
      </section>
      {report && <DeliverabilitySection report={report} />}
      {email.spam && <SpamSection spam={email.spam} />}
      <section className="ui-card ui-card-static p-4!">
        <h3 className="text-sm font-bold caps mb-1">Delivery</h3>
        {/* Two columns from sm up; on a phone each value goes under its label. */}
        <dl className="grid grid-cols-1 sm:grid-cols-[minmax(120px,200px)_1fr] text-sm">
          {[
            [
              "Sending server",
              smtp?.clientIp
                ? `${smtp.clientIp}${smtp.clientRdns ? ` (${smtp.clientRdns})` : ""}`
                : null,
              true,
            ],
            ["Introduced itself as", smtp?.helo ? `${smtp.helo} (HELO, not verified)` : null, true],
            [
              "Encryption",
              tls
                ? `${tls}${smtp?.tls?.cipher ? `, ${smtp.tls.cipher}` : ""}`
                : "None. The sender did not start TLS.",
              false,
            ],
            [
              "Envelope sender",
              smtp?.envelopeFrom || "Empty (a bounce or automated message)",
              true,
            ],
            ["Envelope recipient", smtp?.envelopeTo.join(", ") || null, true],
            ["Message-ID", email.messageId, true],
          ]
            .filter(([, value]) => value)
            .map(([label, value, mono], index) => (
              <div key={label as string} className="contents">
                <dt
                  className={cn(
                    "pt-2 sm:py-2 pr-3 text-muted-foreground",
                    index > 0 && "border-t border-line/15"
                  )}
                >
                  {label}
                </dt>
                <dd
                  className={cn(
                    "pb-2 sm:py-2 [overflow-wrap:anywhere]",
                    index > 0 && "sm:border-t sm:border-line/15",
                    mono && "font-mono text-[13px]"
                  )}
                >
                  {value}
                </dd>
              </div>
            ))}
        </dl>
      </section>
    </div>
  );
}

function EmailJsonPane({
  json,
  forwardEnabled,
  forwardUrl,
  canManageForwarding,
  onOpenForwarding,
  onOpenDeliveries,
}: {
  json: unknown;
  forwardEnabled: boolean;
  forwardUrl?: string | null;
  canManageForwarding: boolean;
  onOpenForwarding?: () => void;
  onOpenDeliveries: () => void;
}) {
  const [view, setView] = useState<"formatted" | "tree">("formatted");
  const { copied, copy } = useCopy();
  const text = useMemo(() => JSON.stringify(json, null, 2), [json]);
  const highlighted = useMemo(() => highlightBody(text, "json"), [text]);

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <Send className="h-3.5 w-3.5 shrink-0" />
        {forwardEnabled ? (
          <>
            <span>
              Destinations set to signed JSON get this JSON
              {forwardUrl ? (
                <>
                  , like <span className="font-mono text-foreground break-all">{forwardUrl}</span>
                </>
              ) : null}
              .
            </span>
            <button
              type="button"
              onClick={onOpenDeliveries}
              className="text-foreground underline underline-offset-2 cursor-pointer"
            >
              See deliveries
            </button>
          </>
        ) : (
          <>
            <span>Forwarding can POST this JSON to your server for every email.</span>
            {canManageForwarding && onOpenForwarding && (
              <button
                type="button"
                onClick={onOpenForwarding}
                className="text-foreground underline underline-offset-2 cursor-pointer"
              >
                Set up forwarding
              </button>
            )}
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-sm border-strong border-line">
          {(["formatted", "tree"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={cn(
                "px-2 py-0.5 text-[11px] font-bold caps cursor-pointer transition-colors",
                mode === "tree" && "border-l-strong border-line",
                view === mode
                  ? "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                  : "hover:bg-muted"
              )}
            >
              {mode === "formatted" ? "Formatted" : "Tree"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => copy(text, "json")}
          className="ml-auto ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
        >
          {copied === "json" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied === "json" ? "Copied" : "Copy JSON"}
        </button>
      </div>
      {view === "tree" ? (
        <div className="ui-code overflow-x-auto p-3">
          <JsonTree data={json} />
        </div>
      ) : (
        <pre className="ui-code syntax-highlight overflow-x-auto text-sm whitespace-pre-wrap break-words">
          {/* Safe: Prism.highlight encodes token text for json. */}
          <code className="language-json" dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      )}
    </div>
  );
}

export function EmailDetail({
  request,
  showExtracts,
  endpoint,
  canManageForwarding,
  onOpenForwarding,
  onOpenLayouts,
  note,
  onNoteChange,
  initialTab,
  onParsed,
}: EmailDetailProps) {
  const email = request.email ?? null;
  const requestId = "id" in request ? request.id : request._id;
  // webhooks.cc leads with JSON: it is what forwarding sends and what a handler is
  // written against. mailhooks.cc leads with the email as people read it.
  const mailFirst = useSite().key === "mailhooks";
  // The page can show this view twice (desktop and phone), so ids are per instance.
  const tabIds = useId();
  const [tabStripRef, tabStripMore] = useMoreToRight<HTMLDivElement>();
  const hasLayouts = (endpoint.layouts?.length ?? 0) > 0;
  // A tab the person picked stays: a parse that finishes later does not move them.
  const tabPicked = useRef(initialTab !== undefined);
  const [tab, setTab] = useState<EmailTab>(
    initialTab ??
      // Opens on Parsed when a layout read it; mail no layout reads opens as usual.
      (request.parsed?.status === "matched"
        ? "parsed"
        : mailFirst
          ? email?.html
            ? "preview"
            : "text"
          : "json")
  );
  const pickTab = useCallback((id: EmailTab) => {
    tabPicked.current = true;
    setTab(id);
  }, []);
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const { copied, copy } = useCopy();
  const raw = useMemo(() => rawMessage(request), [request]);
  // From the receiver, not the message: any sender can write a header.
  const isTest = email?.smtp?.test === true;
  // Our own sample is not judged: it says nothing about the user's mail.
  const report = useMemo(
    () =>
      email && !isTest
        ? deliverabilityReport({ email, headers: request.headers, receivedAt: request.receivedAt })
        : null,
    [email, isTest, request.headers, request.receivedAt]
  );
  const extracts = useMemo(
    () => (email && showExtracts ? extractFromEmail(email) : { codes: [], links: [] }),
    [email, showExtracts]
  );
  const reply = useMemo(() => findReplyText(email?.text), [email]);
  const [textView, setTextView] = useState<"whole" | "reply">("whole");
  // The endpoint's named fields run on the server (RE2), so they are fetched.
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [details, setDetails] = useState<{
    id: string;
    values: Record<string, string | null> | null;
    parsed: ParsedEmail | null;
    failed?: boolean;
  } | null>(null);
  // Once per opened email (the list refreshes the request objects on every
  // capture), and not at all when there is nothing to fetch: no fields and
  // no parse summary to complete (lists carry only a summary of the parse).
  const fieldsKnownEmpty = endpoint.emailFields !== undefined && endpoint.emailFields.length === 0;
  const partialParse = request.parsed?.partial === true;
  const isEmail = !!email;
  useEffect(() => {
    if (!accessToken || !isEmail || (fieldsKnownEmpty && !partialParse)) return;
    let cancelled = false;
    fetchEmailDetails(accessToken, requestId)
      .then(
        (found) =>
          !cancelled &&
          setDetails({ id: requestId, values: found.emailFields, parsed: found.parsed })
      )
      .catch(
        () => !cancelled && setDetails({ id: requestId, values: null, parsed: null, failed: true })
      );
    return () => {
      cancelled = true;
    };
  }, [accessToken, isEmail, requestId, fieldsKnownEmpty, partialParse]);
  // A new email the layouts may still be reading.
  const [watch, setWatch] = useState<ParseWatch | null>(() =>
    email && hasLayouts && !request.parsed && Date.now() - request.receivedAt < PARSE_FRESH_MS
      ? { id: requestId, state: "reading", mode: "new", until: Date.now() + PARSE_WATCH_MS }
      : null
  );
  const watchHere = watch?.id === requestId ? watch : null;
  const onParsedRef = useRef(onParsed);
  useEffect(() => {
    onParsedRef.current = onParsed;
  }, [onParsed]);
  useEffect(() => {
    if (watchHere?.state !== "reading" || !accessToken) return;
    const { mode, until } = watchHere;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const found = await fetchEmailDetails(accessToken, requestId);
        if (cancelled) return;
        setDetails({ id: requestId, values: found.emailFields, parsed: found.parsed });
        if (found.parsed) {
          const layout =
            found.parsed.status === "matched" ? (found.parsed.layout?.name ?? "a layout") : null;
          setWatch({ id: requestId, state: "done", mode, layout });
          if (layout && !tabPicked.current) setTab("parsed");
          onParsedRef.current?.(requestId, found.parsed);
          return;
        }
      } catch {
        // Asked again on the next tick.
      }
      if (cancelled) return;
      if (Date.now() >= until) {
        setWatch({ id: requestId, state: "done", mode, layout: null });
        return;
      }
      timer = setTimeout(() => void tick(), PARSE_POLL_MS);
    };
    timer = setTimeout(() => void tick(), PARSE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [watchHere, accessToken, requestId]);
  const readingAgain = watchHere?.mode === "again";
  const fields = details?.id === requestId ? details.values : null;
  const fetchFailed = details?.id === requestId && details.failed === true;
  // The list's summary stands in when the whole result cannot be fetched; once
  // the email is read again, it is the old result and no longer counts.
  const listParsed = readingAgain ? null : (request.parsed ?? null);
  const parsed =
    (details?.id === requestId ? details.parsed : null) ??
    (partialParse && !fetchFailed ? null : listParsed);
  const reading = watchHere?.state === "reading" && (watchHere.mode === "again" || parsed === null);
  // With object storage the exact message is fetched when it is wanted (the
  // Raw tab or a download), whatever its size.
  const stored = email?.stored === true;
  const [storedRaw, setStoredRaw] = useState<
    | { id: string; bytes: Uint8Array<ArrayBuffer>; text: string }
    | { id: string; error: string }
    | null
  >(null);
  const storedRawHere = storedRaw?.id === requestId ? storedRaw : null;
  const loadStoredRaw = useCallback(async () => {
    if (!accessToken) throw new Error("Sign in again to download the message.");
    const bytes = await fetchRawEmail(accessToken, requestId);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, RAW_DISPLAY_BYTES)
    );
    const loaded = { id: requestId, bytes, text };
    setStoredRaw(loaded);
    return loaded;
  }, [accessToken, requestId]);
  const json = useMemo(
    () =>
      email
        ? buildEmailJson(
            {
              id: requestId,
              receivedAt: request.receivedAt,
              path: request.path,
              size: request.size,
              headers: request.headers,
              email,
            },
            { slug: endpoint.slug, name: endpoint.name ?? null },
            { includeExtracts: showExtracts, fields, parsed }
          )
        : null,
    [email, requestId, request, endpoint.slug, endpoint.name, showExtracts, fields, parsed]
  );

  const downloadEml = useCallback(async () => {
    let bytes: Uint8Array<ArrayBuffer> | null = raw?.bytes ?? null;
    if (stored) {
      try {
        bytes =
          storedRawHere && "bytes" in storedRawHere
            ? storedRawHere.bytes
            : (await loadStoredRaw()).bytes;
      } catch (error) {
        setStoredRaw({
          id: requestId,
          error: error instanceof Error ? error.message : "Download failed.",
        });
        return;
      }
    }
    if (!bytes) return;
    const blob = new Blob([bytes], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `email-${requestId.slice(0, 8)}.eml`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [raw, requestId, stored, storedRawHere, loadStoredRaw]);

  // Read again: the email is parsed with the current layouts (when there are
  // any) and sent to its destinations again (lib/replay). Its status shows
  // beside the button that asked for it.
  const hasDestinations = endpoint.forwardEnabled === true || (endpoint.destinationCount ?? 0) > 0;
  const [replay, setReplay] = useState<{
    id: string;
    from: "header" | "parsed";
    state:
      { kind: "sending" } | { kind: "done"; queued: boolean } | { kind: "error"; message: string };
  } | null>(null);
  const replayHere = replay?.id === requestId ? replay : null;
  const readAgain = useCallback(
    async (from: "header" | "parsed") => {
      if (replayHere?.state.kind === "sending") return;
      if (!accessToken) {
        setReplay({
          id: requestId,
          from,
          state: { kind: "error", message: "Sign in again to read it again." },
        });
        return;
      }
      setReplay({ id: requestId, from, state: { kind: "sending" } });
      try {
        const queued = await replayRequest(accessToken, requestId);
        setReplay({ id: requestId, from, state: { kind: "done", queued } });
        if (queued && hasLayouts) {
          // The parse is pending again: the result shown so far is the old one.
          setDetails((current) =>
            current?.id === requestId ? { ...current, parsed: null } : current
          );
          setWatch({
            id: requestId,
            state: "reading",
            mode: "again",
            until: Date.now() + PARSE_WATCH_MS,
          });
        }
      } catch (error) {
        setReplay({
          id: requestId,
          from,
          state: {
            kind: "error",
            message: error instanceof Error ? error.message : "It could not be queued.",
          },
        });
      }
    },
    [accessToken, requestId, replayHere?.state.kind, hasLayouts]
  );
  const replayMessage = (from: "header" | "parsed") => {
    if (replayHere?.from !== from) return null;
    const { state } = replayHere;
    if (state.kind === "sending") return "Queueing...";
    if (state.kind === "error") return state.message;
    if (!state.queued) return "Nothing was queued: no layout or destination takes this email.";
    if (!hasLayouts) return "Queued. It is sent to destinations again.";
    if (watchHere?.mode !== "again" || watchHere.state === "reading") return "Reading again...";
    const sent = hasDestinations ? " It is sent to destinations again." : "";
    return watchHere.layout
      ? `Read by ${watchHere.layout} just now.${sent}`
      : `Still no layout applies.${sent}`;
  };
  const replayFailed = replayHere?.state.kind === "error";
  // Offered when reading it again would do something: a layout or a destination.
  const canReadAgain = canManageForwarding && (hasLayouts || hasDestinations);

  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const downloadAttachment = useCallback(
    async (index: number) => {
      setAttachmentError(null);
      if (!accessToken) return setAttachmentError("Sign in again to download.");
      try {
        const { blob, filename } = await fetchAttachment(accessToken, requestId, index);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : "Download failed.");
      }
    },
    [accessToken, requestId]
  );

  useEffect(() => {
    if (!stored || tab !== "raw" || storedRawHere) return;
    loadStoredRaw().catch((error) =>
      setStoredRaw({
        id: requestId,
        error: error instanceof Error ? error.message : "The message could not be loaded.",
      })
    );
  }, [stored, tab, storedRawHere, loadStoredRaw, requestId]);

  if (!email) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This email could not be read. The raw message is below.
        <pre className="ui-code mt-4 whitespace-pre-wrap break-all text-foreground">
          {request.body || "(empty)"}
        </pre>
      </div>
    );
  }

  const headerCount = Object.keys(request.headers).length;
  const attachments = email.attachments;
  const forwardEnabled = endpoint.forwardEnabled === true;
  const tabs: { id: EmailTab; label: string; count?: number }[] = [
    // Also without a result while the endpoint has layouts, to say why and offer a fix.
    ...(request.parsed || parsed || hasLayouts ? [{ id: "parsed" as const, label: "Parsed" }] : []),
    ...(mailFirst ? [] : [{ id: "json" as const, label: "JSON" }]),
    ...(email.html ? [{ id: "preview" as const, label: "Preview" }] : []),
    { id: "text", label: "Text" },
    ...(mailFirst ? [{ id: "json" as const, label: "JSON" }] : []),
    { id: "headers", label: "Headers", count: headerCount },
    ...(attachments.length > 0
      ? [{ id: "attachments" as const, label: "Attachments", count: attachments.length }]
      : []),
    { id: "authentication", label: "Authentication" },
    { id: "raw", label: "Raw" },
    // Kept after forwarding is turned off, so past deliveries stay readable.
    ...(forwardEnabled || endpoint.hasForwardSecret
      ? [{ id: "deliveries" as const, label: "Deliveries" }]
      : []),
  ];
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0].id;
  const openTab = (id: EmailTab) => {
    // A failed load of the stored message is tried again.
    if (id === "raw" && storedRawHere && "error" in storedRawHere) setStoredRaw(null);
    pickTab(id);
  };
  const rawAvailable = stored || (!!raw && !email.truncated.raw);

  return (
    <div className="ph-no-capture flex flex-col h-full">
      {/* Envelope */}
      <div className="@container border-b-strong border-line px-4 pt-3 pb-3 shrink-0 bg-card">
        {/* In a narrow pane the buttons go under the subject, which keeps the full width. */}
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-start @xl:gap-3">
          <div className="@xl:flex-1 min-w-0 flex items-start gap-2">
            <h2
              className={cn(
                "min-w-0 text-lg font-bold clean:font-semibold leading-tight break-words",
                !email.subject && "text-muted-foreground"
              )}
            >
              {email.subject || "(no subject)"}
            </h2>
            {/* The Authentication tab says why sender checks do not apply. */}
            {isTest && (
              <span
                title="Test email sent from the dashboard"
                className="mt-0.5 shrink-0 px-1.5 py-0.5 text-xs font-bold caps leading-none rounded-sm border-strong border-line bg-muted text-muted-foreground"
              >
                Test
              </span>
            )}
          </div>
          {(canReadAgain || rawAvailable) && (
            <div className="flex flex-wrap gap-2 @xl:justify-end @xl:shrink-0">
              {canReadAgain && (
                <button
                  type="button"
                  onClick={() => void readAgain("header")}
                  disabled={replayHere?.state.kind === "sending"}
                  className="ui-btn-outline py-1! px-3! text-xs flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden />
                  Read again
                </button>
              )}
              {rawAvailable && (
                <button
                  type="button"
                  onClick={downloadEml}
                  className="ui-btn-outline py-1! px-3! text-xs flex items-center gap-1.5"
                >
                  <FileDown className="h-3 w-3" aria-hidden />
                  Download .eml
                </button>
              )}
            </div>
          )}
        </div>
        {canReadAgain && (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-xs empty:hidden mt-1.5",
              replayFailed ? "text-destructive-ink" : "text-muted-foreground"
            )}
          >
            {replayMessage("header")}
          </p>
        )}
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-muted-foreground">From</dt>
          {/* Received and the size share the From row, which keeps the envelope short. */}
          <dd className="min-w-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <AddressLine addresses={email.from.length > 0 ? email.from : email.sender} />
            <span className="text-xs text-muted-foreground">
              <span className="sr-only">Received </span>
              {formatFullTimestamp(request.receivedAt)}
              {", "}
              {formatBytes(email.smtp?.size ?? request.size)}
            </span>
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="min-w-0">
            <AddressLine
              addresses={
                email.to.length > 0
                  ? email.to
                  : (email.smtp?.envelopeTo ?? []).map((address) => ({ name: null, address }))
              }
            />
          </dd>
          {email.cc.length > 0 && (
            <>
              <dt className="text-muted-foreground">Cc</dt>
              <dd className="min-w-0">
                <AddressLine addresses={email.cc} />
              </dd>
            </>
          )}
        </dl>
        {!isTest && (
          <div className="mt-3">
            <Verdicts email={email} report={report} onOpen={() => pickTab("authentication")} />
          </div>
        )}
        {(showExtracts || fields) && (
          <FoundInEmail
            code={showExtracts ? (extracts.codes[0] ?? null) : null}
            link={showExtracts ? (extracts.links[0] ?? null) : null}
            fields={Object.entries(fields ?? {}).filter(
              (entry): entry is [string, string] => entry[1] !== null
            )}
            copied={copied}
            onCopy={copy}
          />
        )}
      </div>

      {onNoteChange && <NoteBar note={note ?? null} onChange={onNoteChange} />}

      {/* Tabs: the same bar as the HTTP view */}
      {/* The strip scrolls when the tabs do not fit; a fade on the right says there is more. */}
      <div
        ref={tabStripRef}
        className={cn(
          "border-b-strong border-line flex shrink-0 overflow-x-auto [scrollbar-width:none]",
          tabStripMore && "[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)]"
        )}
      >
        <div role="tablist" aria-label="Email sections" className="flex shrink-0">
          {tabs.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`${tabIds}-tab-${entry.id}`}
              aria-selected={activeTab === entry.id}
              aria-controls={`${tabIds}-panel`}
              tabIndex={activeTab === entry.id ? 0 : -1}
              onClick={() => openTab(entry.id)}
              onKeyDown={(event) => {
                // Arrow keys move between tabs, as in any tab list.
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = tabs[(index + step + tabs.length) % tabs.length];
                openTab(next.id);
                document.getElementById(`${tabIds}-tab-${next.id}`)?.focus();
              }}
              className={cn(
                "px-4 py-2 text-xs font-bold caps clean:capitalize border-r-strong border-line cursor-pointer transition-colors whitespace-nowrap",
                activeTab === entry.id
                  ? "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                  : "bg-background hover:bg-muted"
              )}
            >
              {entry.label}
              {entry.count !== undefined && (
                <>
                  <span className="sr-only">, </span>
                  <span className="ml-1.5 font-mono opacity-70">{entry.count}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${tabIds}-panel`}
        aria-labelledby={`${tabIds}-tab-${activeTab}`}
        className="flex-1 overflow-auto p-4 md:p-5"
      >
        {activeTab === "parsed" &&
          (reading ? (
            <p
              // Read again from the header: its own status line already says so.
              {...(readingAgain && replayHere?.from === "header"
                ? {}
                : { role: "status", "aria-live": "polite" as const })}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              {readingAgain ? "Reading again..." : "Reading with your layouts..."}
            </p>
          ) : parsed && (parsed.status === "matched" || !hasLayouts) ? (
            <>
              {replayHere?.from === "parsed" && (
                <p role="status" aria-live="polite" className="text-xs text-muted-foreground mb-2">
                  {replayMessage("parsed")}
                </p>
              )}
              {parsed.partial && (
                <p className="text-xs text-muted-foreground mb-2">
                  The line items and attachments could not be loaded; reopen the email to try again.
                </p>
              )}
              <ParsedResult parsed={parsed} layouts={endpoint.layouts} />
            </>
          ) : !parsed && listParsed ? (
            <p className="text-sm text-muted-foreground">Loading the parsed result...</p>
          ) : (
            <section className="ui-card ui-card-static p-4! space-y-3 max-w-[640px]">
              <h3 className="text-sm font-semibold">No layout applied to this email.</h3>
              <p className="text-sm text-muted-foreground">
                {canManageForwarding
                  ? "It arrived before the current layouts, or none of them applies to it. Read it again to try the current layouts, or open Layouts to adjust one."
                  : "It arrived before the current layouts, or none of them applies to it."}
              </p>
              {canManageForwarding && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void readAgain("parsed")}
                    disabled={replayHere?.state.kind === "sending"}
                    className="ui-btn-primary py-1.5! px-3! text-xs flex items-center gap-1.5"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden />
                    Read again
                  </button>
                  {onOpenLayouts && (
                    <button
                      type="button"
                      onClick={onOpenLayouts}
                      className="ui-btn-outline py-1.5! px-3! text-xs"
                    >
                      Open Layouts
                    </button>
                  )}
                </div>
              )}
              {canManageForwarding && (
                <p
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "text-xs empty:hidden",
                    replayFailed ? "text-destructive-ink" : "text-muted-foreground"
                  )}
                >
                  {replayMessage("parsed")}
                </p>
              )}
            </section>
          ))}

        {activeTab === "json" && json && (
          <EmailJsonPane
            json={json}
            forwardEnabled={forwardEnabled}
            forwardUrl={endpoint.forwardUrl}
            canManageForwarding={canManageForwarding}
            onOpenForwarding={onOpenForwarding}
            onOpenDeliveries={() => pickTab("deliveries")}
          />
        )}

        {activeTab === "deliveries" && (
          <DeliveriesPane
            key={requestId}
            request={request}
            endpoint={endpoint}
            canRedeliver={canManageForwarding}
            onOpenForwarding={onOpenForwarding}
          />
        )}

        {activeTab === "preview" && email.html && (
          <>
            {/* The width toggle; a phone shows the mobile width anyway. */}
            <div className="hidden md:flex items-center justify-end gap-2 mb-3">
              <div
                role="group"
                aria-label="Preview width"
                className="flex overflow-hidden rounded-sm border-strong border-line"
              >
                {(["desktop", "mobile"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={width === mode}
                    onClick={() => setWidth(mode)}
                    className={cn(
                      "px-2.5 py-1 text-[11px] font-bold caps cursor-pointer transition-colors capitalize",
                      mode === "mobile" && "border-l-strong border-line",
                      width === mode
                        ? "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                        : "bg-background hover:bg-muted"
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            {email.truncated.html && (
              <p className="text-xs text-muted-foreground mb-3">
                The HTML was too large to keep in full; the end is cut off.
              </p>
            )}
            <EmailPreview
              key={"id" in request ? request.id : request._id}
              html={email.html}
              width={width}
            />
          </>
        )}

        {activeTab === "text" && (
          <div>
            {reply && (
              <div className="flex items-center justify-end gap-2 mb-3">
                <div
                  className="flex overflow-hidden rounded-sm border-strong border-line"
                  role="group"
                  aria-label="Text to show"
                >
                  {(
                    [
                      ["whole", "Whole text"],
                      ["reply", "Reply only"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setTextView(mode)}
                      aria-pressed={textView === mode}
                      className={cn(
                        "px-2.5 py-1 max-md:py-1.5 text-[11px] font-bold caps clean:capitalize cursor-pointer transition-colors whitespace-nowrap",
                        mode === "reply" && "border-l-strong border-line",
                        textView === mode
                          ? "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                          : "bg-background hover:bg-muted"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {email.textFromHtml && (
              <p className="text-xs text-muted-foreground mb-3 max-w-[760px]">
                This email has no text part; the text below was taken from its HTML.
              </p>
            )}
            {reply && textView === "reply" && (
              <p className="text-xs text-muted-foreground mb-3 max-w-[760px]">
                What the sender wrote above the quoted message, without the signature: the{" "}
                <code className="font-mono">replyText</code> field of the JSON.
              </p>
            )}
            {email.text ? (
              <div className="relative ui-code font-sans! text-sm leading-relaxed whitespace-pre-wrap break-words">
                <button
                  type="button"
                  onClick={() =>
                    copy((reply && textView === "reply" ? reply : email.text) ?? "", "text")
                  }
                  className="absolute top-2 right-2 p-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
                  aria-label="Copy text"
                >
                  {copied === "text" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
                <div className="max-w-[760px]">
                  {reply && textView === "reply" ? reply : email.text}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This email has no text.</p>
            )}
            {email.truncated.text && (
              <p className="text-xs text-muted-foreground mt-3">
                The text was too long to keep in full; the end is cut off.
              </p>
            )}
          </div>
        )}

        {activeTab === "headers" && (
          <div className="ui-code overflow-x-auto">
            <table className="text-sm font-mono w-full">
              <tbody>
                {Object.entries(request.headers).map(([key, value]) => (
                  <tr key={key} className="border-b border-foreground/20 last:border-0">
                    <td className="pr-4 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
                      {key}
                    </td>
                    <td className="py-1.5 break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {email.truncated.headers && (
              <p className="text-xs text-muted-foreground mt-3 font-sans">
                Some headers were too large to keep.
              </p>
            )}
          </div>
        )}

        {activeTab === "attachments" && (
          <div className="max-w-[760px]">
            <ul className="ui-card ui-card-static p-0! divide-y divide-line/20">
              {attachments.map((attachment, index) => (
                <li
                  key={`${attachment.filename}-${index}`}
                  className="flex items-center gap-3 px-4 py-3 text-sm"
                >
                  <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium truncate">
                    {attachment.filename ?? "Unnamed attachment"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground truncate">
                    {attachment.contentType}
                  </span>
                  {attachment.inline && (
                    <span className="text-xs text-muted-foreground">inline</span>
                  )}
                  <span className="ml-auto font-mono text-xs text-muted-foreground shrink-0">
                    {formatBytes(attachment.size)}
                  </span>
                  {stored && (
                    <button
                      type="button"
                      onClick={() => void downloadAttachment(index)}
                      className="ui-btn-outline py-1! px-2! text-xs flex items-center gap-1.5 shrink-0"
                      aria-label={`Download ${attachment.filename ?? `attachment ${index + 1}`}`}
                    >
                      <FileDown className="h-3 w-3" />
                      Download
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {attachmentError && (
              <p className="text-xs text-destructive-ink mt-3">{attachmentError}</p>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              {stored
                ? "Attachments are kept with the email and deleted with it."
                : "Attachments are listed with their name, type and size. Their contents are not kept."}
              {email.truncated.attachments && " This email had more attachments than are listed."}
            </p>
          </div>
        )}

        {activeTab === "authentication" && (
          <AuthenticationPane email={email} ip={request.ip} report={report} isTest={isTest} />
        )}

        {activeTab === "raw" &&
          (stored ? (
            storedRawHere === null ? (
              <p className="text-sm text-muted-foreground">Loading the message...</p>
            ) : "error" in storedRawHere ? (
              <p className="text-sm text-destructive-ink">{storedRawHere.error}</p>
            ) : (
              <>
                {storedRawHere.bytes.length > RAW_DISPLAY_BYTES && (
                  <p className="mb-3 text-sm text-muted-foreground">
                    Showing the first {formatBytes(RAW_DISPLAY_BYTES)} of{" "}
                    {formatBytes(storedRawHere.bytes.length)}. Download the .eml for all of it.
                  </p>
                )}
                <pre className="ui-code overflow-x-auto text-xs whitespace-pre-wrap break-all">
                  {storedRawHere.text}
                </pre>
              </>
            )
          ) : rawAvailable ? (
            <pre className="ui-code overflow-x-auto text-xs whitespace-pre-wrap break-all">
              {raw!.text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground max-w-[60ch]">
              This email was larger than 1 MiB, so the full message was not kept. Its headers, text
              and attachment list are in the other tabs.
            </p>
          ))}
      </div>
    </div>
  );
}
