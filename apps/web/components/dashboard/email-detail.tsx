"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, FileDown, ImageOff, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { formatBytes } from "@/types/request";
import type { EmailAddress, EmailAuth, EmailCapture, EmailSmtp } from "@/lib/email-capture";
import { extractFromEmail, type ExtractedLink } from "@/lib/email-extract";
import { buildPreviewDocument, countRemoteImages } from "@/lib/email-preview";
import { TEST_EMAIL_HEADER } from "@/lib/test-email-header";
import { NoteBar, type DisplayableRequest } from "./request-detail";

type EmailTab = "preview" | "text" | "headers" | "attachments" | "authentication" | "raw";
type Verdict = "pass" | "fail" | "none";

interface EmailDetailProps {
  request: DisplayableRequest;
  /** The endpoint's "Show codes and links found in emails" setting. */
  showExtracts: boolean;
  note?: string | null;
  onNoteChange?: (note: string) => void;
}

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

function formatReceived(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

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

function Verdicts({
  email,
  isTest,
  onOpen,
}: {
  email: EmailCapture;
  isTest: boolean;
  onOpen: () => void;
}) {
  if (isTest) {
    return (
      <p className="text-xs text-muted-foreground">
        Test email from the dashboard: sender checks do not apply.
      </p>
    );
  }
  const auth = email.auth;
  if (!auth || auth.error) {
    return (
      <p className="text-xs text-muted-foreground">Sender checks could not run for this email.</p>
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
    </button>
  );
}

/** "label | value | buttons", the same idiom as the endpoint's address pills. */
function Pick({
  label,
  children,
  actions,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-stretch h-8 min-w-0 max-w-full border-strong border-line rounded-md bg-card shadow-raised-sm overflow-hidden",
        wide && "md:max-w-[460px]"
      )}
    >
      <span
        className="flex items-center px-2.5 bg-muted text-muted-foreground text-[11px] font-semibold caps border-r-strong border-line shrink-0 max-w-[140px]"
        title={label}
      >
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-center px-2.5 min-w-0">{children}</span>
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

function FoundInEmail({
  code,
  link,
  copied,
  onCopy,
}: {
  code: string | null;
  link: ExtractedLink | null;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  if (!code && !link) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-line/20 text-sm">
      <span className="text-muted-foreground mr-1">Found in this email</span>
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
          <span className="font-mono text-[13px] truncate">
            {link.url.replace(/^https?:\/\//, "")}
          </span>
        </Pick>
      )}
    </div>
  );
}

/** The email on a white sheet, sandboxed (see lib/email-preview.ts). */
function EmailPreview({ html, width }: { html: string; width: "desktop" | "mobile" }) {
  const remoteImages = useMemo(() => countRemoteImages(html), [html]);
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

function AuthenticationPane({ email, ip }: { email: EmailCapture; ip: string }) {
  const auth = email.auth;
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
        {!auth || auth.error ? (
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
            {auth.authenticationResults && (
              <pre className="ui-code text-xs! whitespace-pre-wrap break-all mt-3 shadow-none!">
                Authentication-Results: {auth.authenticationResults}
              </pre>
            )}
          </>
        )}
      </section>
      <section className="ui-card ui-card-static p-4!">
        <h3 className="text-sm font-bold caps mb-1">Delivery</h3>
        <dl className="grid grid-cols-[minmax(120px,200px)_1fr] text-sm">
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
                    "py-2 pr-3 text-muted-foreground",
                    index > 0 && "border-t border-line/15"
                  )}
                >
                  {label}
                </dt>
                <dd
                  className={cn(
                    "py-2 break-all",
                    index > 0 && "border-t border-line/15",
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

export function EmailDetail({ request, showExtracts, note, onNoteChange }: EmailDetailProps) {
  const email = request.email ?? null;
  const [tab, setTab] = useState<EmailTab>(email?.html ? "preview" : "text");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const { copied, copy } = useCopy();
  const raw = useMemo(() => rawMessage(request), [request]);
  const isTest = Object.keys(request.headers).some(
    (name) => name.toLowerCase() === TEST_EMAIL_HEADER.toLowerCase()
  );
  const extracts = useMemo(
    () => (email && showExtracts ? extractFromEmail(email) : { codes: [], links: [] }),
    [email, showExtracts]
  );

  const downloadEml = useCallback(() => {
    if (!raw) return;
    const blob = new Blob([raw.bytes], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const requestId = "id" in request ? request.id : request._id;
    anchor.download = `email-${requestId.slice(0, 8)}.eml`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [raw, request]);

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
  const tabs: { id: EmailTab; label: string; count?: number }[] = [
    ...(email.html ? [{ id: "preview" as const, label: "Preview" }] : []),
    { id: "text", label: "Text" },
    { id: "headers", label: "Headers", count: headerCount },
    ...(attachments.length > 0
      ? [{ id: "attachments" as const, label: "Attachments", count: attachments.length }]
      : []),
    { id: "authentication", label: "Authentication" },
    { id: "raw", label: "Raw" },
  ];
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0].id;
  const rawAvailable = !!raw && !email.truncated.raw;

  return (
    <div className="flex flex-col h-full">
      {/* Envelope */}
      <div className="border-b-strong border-line px-4 md:px-5 pt-4 pb-3.5 shrink-0 bg-card">
        <div className="flex items-start gap-3">
          <h1
            className={cn(
              "flex-1 min-w-0 text-lg md:text-[21px] font-bold clean:font-semibold leading-tight break-words",
              !email.subject && "text-muted-foreground"
            )}
          >
            {email.subject || "(no subject)"}
          </h1>
          {rawAvailable && (
            <button
              type="button"
              onClick={downloadEml}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5 shrink-0"
            >
              <FileDown className="h-3 w-3" />
              Download .eml
            </button>
          )}
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="min-w-0">
            <AddressLine addresses={email.from.length > 0 ? email.from : email.sender} />
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
          <dt className="text-muted-foreground">Received</dt>
          <dd>
            {formatReceived(request.receivedAt)}
            <span className="text-muted-foreground">
              , {formatBytes(email.smtp?.size ?? request.size)}
            </span>
          </dd>
        </dl>
        <div className="mt-3">
          <Verdicts email={email} isTest={isTest} onOpen={() => setTab("authentication")} />
        </div>
        {showExtracts && (
          <FoundInEmail
            code={extracts.codes[0] ?? null}
            link={extracts.links[0] ?? null}
            copied={copied}
            onCopy={copy}
          />
        )}
      </div>

      {onNoteChange && <NoteBar note={note ?? null} onChange={onNoteChange} />}

      {/* Tabs: the same bar as the HTTP view */}
      <div className="border-b-strong border-line flex shrink-0 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "px-4 py-2 text-xs font-bold caps clean:capitalize border-r-strong border-line cursor-pointer transition-colors whitespace-nowrap",
              activeTab === entry.id
                ? "bg-selected text-selected-foreground"
                : "bg-background hover:bg-muted"
            )}
          >
            {entry.label}
            {entry.count !== undefined && (
              <span className="ml-1.5 font-mono opacity-70">{entry.count}</span>
            )}
          </button>
        ))}
        {activeTab === "preview" && (
          <div className="hidden md:flex ml-auto items-center pr-3 pl-3">
            <div className="flex overflow-hidden rounded-sm border-strong border-line">
              {(["desktop", "mobile"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setWidth(mode)}
                  className={cn(
                    "px-2.5 py-0.5 text-[11px] font-bold caps cursor-pointer transition-colors capitalize",
                    mode === "mobile" && "border-l-strong border-line",
                    width === mode
                      ? "bg-selected text-selected-foreground"
                      : "bg-background hover:bg-muted"
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 md:p-5">
        {activeTab === "preview" && email.html && (
          <>
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
          <div className="max-w-[760px]">
            {email.textFromHtml && (
              <p className="text-xs text-muted-foreground mb-3">
                This email has no text part; the text below was taken from its HTML.
              </p>
            )}
            {email.text ? (
              <div className="relative ui-code font-sans! text-sm leading-relaxed whitespace-pre-wrap break-words">
                <button
                  type="button"
                  onClick={() => copy(email.text ?? "", "text")}
                  className="absolute top-2 right-2 p-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
                  aria-label="Copy text"
                >
                  {copied === "text" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
                {email.text}
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
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground mt-3">
              Attachments are listed with their name, type and size. Their contents are not kept.
              {email.truncated.attachments && " This email had more attachments than are listed."}
            </p>
          </div>
        )}

        {activeTab === "authentication" && <AuthenticationPane email={email} ip={request.ip} />}

        {activeTab === "raw" &&
          (rawAvailable ? (
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
