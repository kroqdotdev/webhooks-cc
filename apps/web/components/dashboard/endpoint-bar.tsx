"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSite } from "@/components/providers/site-provider";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  Ellipsis,
  Globe,
  HelpCircle,
  LifeBuoy,
  ListChecks,
  Lock,
  Mail,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { sendTestEmail } from "@/lib/dashboard-api";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SendWebhookDialog } from "./send-webhook-dialog";
import { DashboardGuideDialog } from "./dashboard-guide-dialog";
import { Segmented } from "./settings-primitives";
import { useGettingStarted, type SetupState } from "./getting-started";
import type { SettingsSection } from "./settings-primitives";
import { Button } from "@/components/ui/button";

export type EndpointTab = "requests" | "settings";

interface EndpointBarProps {
  /** What the endpoint has, for the Setup checklist. */
  setupState?: SetupState;
  /** Opens Settings at a section, for checklist steps done there. */
  onOpenSettings?: (section: SettingsSection) => void;
  /**
   * A request is open full screen on a phone: only the name and the tabs
   * stay, so the request gets the room.
   */
  detailOpen?: boolean;
  name: string;
  slug: string;
  /** null for endpoints that cannot receive email (no owner). */
  emailAddress?: string | null;
  tab: EndpointTab;
  onTabChange: (tab: EndpointTab) => void;
  hasRequests: boolean;
  /** The Export menu, when there is something to export. */
  exportMenu?: React.ReactNode;
  /**
   * The exports themselves, so a phone's Actions menu can list them; without
   * it the Export menu sits beside Actions there.
   */
  onExport?: (format: "json" | "csv") => void;
}

/** "label | value | copy", the idiom the email view's picks share. */
export function AddressPill({
  label,
  icon: Icon,
  value,
  copyValue,
  className,
  hideLabelBelowXl = false,
}: {
  label: string;
  icon: React.ElementType;
  value: string;
  copyValue?: string;
  className?: string;
  /**
   * Drop the label below xl, where one pill shows at a time and the HTTP/Email
   * toggle next to it already names it.
   */
  hideLabelBelowXl?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    if (!(await copyToClipboard(copyValue ?? value))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <span
      className={cn(
        // On a phone the value wraps rather than losing its end to an ellipsis.
        "inline-flex items-stretch h-9 max-sm:h-auto max-sm:min-h-9 min-w-0 border rounded-md bg-background shadow-surface overflow-hidden",
        className
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 px-2.5 bg-muted text-muted-foreground text-[11px] font-semibold border-r shrink-0",
          hideLabelBelowXl && "max-xl:hidden"
        )}
      >
        <Icon className="h-3 w-3 hidden sm:block" />
        {label}
      </span>
      <button
        type="button"
        onClick={copy}
        className="flex flex-1 items-center px-2.5 max-sm:py-1.5 min-w-0 font-mono text-[13px] text-left cursor-pointer hover:bg-muted/50"
        title="Copy"
      >
        <span className="truncate max-sm:whitespace-normal max-sm:break-all">{value}</span>
      </button>
      <button
        type="button"
        onClick={copy}
        className="flex items-center justify-center w-9 shrink-0 border-l text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
        aria-label={`Copy ${label === "HTTP" ? "webhook URL" : "email address"}`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

type Setup = ReturnType<typeof useGettingStarted>;

/** The Setup checklist's items, the guide and support: shared by Setup and the phone's Actions. */
function SetupItems({
  setup,
  slug,
  onOpenGuide,
  onOpenSettings,
}: {
  setup: Setup;
  slug: string;
  onOpenGuide: () => void;
  onOpenSettings?: (section: SettingsSection) => void;
}) {
  return (
    <>
      {setup.open &&
        setup.items.map((item) => {
          const done = setup.isDone(item.id);
          const Icon = done ? Check : item.icon;
          const body = (
            <span
              className={cn(
                "flex items-center gap-2",
                done && "text-muted-foreground line-through"
              )}
            >
              <Icon className={cn("h-3.5 w-3.5", done && "text-primary")} />
              {item.label}
            </span>
          );
          const section = item.section;
          return item.href ? (
            <DropdownMenuItem
              key={item.id}
              onClick={() => setup.markVisited(item.id)}
              render={<Link href={item.href} />}
            >
              {body}
            </DropdownMenuItem>
          ) : section && onOpenSettings && !done ? (
            // Done in Settings: the item opens the section that does it.
            <DropdownMenuItem key={item.id} onClick={() => onOpenSettings(section)}>
              {body}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={item.id} disabled={done}>
              {body}
            </DropdownMenuItem>
          );
        })}
      {setup.open && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={onOpenGuide}>
        <HelpCircle className="h-3.5 w-3.5" />
        Dashboard guide
      </DropdownMenuItem>
      <DropdownMenuItem
        render={
          <Link
            href={`/support/new?endpoint=${encodeURIComponent(slug)}&from=${encodeURIComponent("/dashboard")}`}
          />
        }
      >
        <LifeBuoy className="h-3.5 w-3.5" />
        Get support
      </DropdownMenuItem>
      {setup.open && (
        <DropdownMenuItem onClick={setup.dismiss} className="text-muted-foreground">
          Hide the setup list
        </DropdownMenuItem>
      )}
    </>
  );
}

/** One stable name; the progress rides along while the checklist is open. */
function setupLabel(setup: Setup) {
  return setup.open ? `Setup ${setup.progress}/${setup.total}` : "Setup";
}

function SetupMenu({
  setup,
  slug,
  onOpenGuide,
  onOpenSettings,
  className,
}: {
  setup: Setup;
  slug: string;
  onOpenGuide: () => void;
  onOpenSettings?: (section: SettingsSection) => void;
  className?: string;
}) {
  const label = setupLabel(setup);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outlined"
            className={cn("py-1.5! px-3! text-xs flex items-center gap-1.5", className)}
            type="button"
            aria-label={label}
          />
        }
      >
        {setup.open ? (
          <ListChecks className="h-3.5 w-3.5" />
        ) : (
          <HelpCircle className="h-3.5 w-3.5" />
        )}
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border shadow-float">
        <SetupItems
          setup={setup}
          slug={slug}
          onOpenGuide={onOpenGuide}
          onOpenSettings={onOpenSettings}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The test sends: the request dialog's open state and the test email with its result. */
function useSendActions(slug: string) {
  const { session } = useAuth();
  const [requestOpen, setRequestOpen] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const show = useCallback((next: { kind: "ok" | "error"; text: string }) => {
    setStatus(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 6000);
  }, []);

  const sendEmail = async () => {
    if (!session?.access_token || sending) return;
    setSending(true);
    try {
      await sendTestEmail(session.access_token, slug);
      show({ kind: "ok", text: "Test email sent" });
    } catch (error) {
      show({
        kind: "error",
        text: error instanceof Error ? error.message : "The test email failed",
      });
    } finally {
      setSending(false);
    }
  };

  return { requestOpen, setRequestOpen, status, sending, sendEmail, show };
}

type SendActions = ReturnType<typeof useSendActions>;

function SendItems({
  send,
  canEmail,
  mailFirst,
}: {
  send: SendActions;
  canEmail: boolean;
  mailFirst: boolean;
}) {
  const request = (
    <DropdownMenuItem
      key="request"
      onClick={() => send.setRequestOpen(true)}
      className="items-start"
    >
      <Globe className="h-4 w-4 mt-0.5" />
      <span>
        <span className="block">Send test request</span>
        <span className="block text-xs text-muted-foreground">
          A POST with a JSON body, or a signed provider template
        </span>
      </span>
    </DropdownMenuItem>
  );
  if (!canEmail) return request;
  const email = (
    <DropdownMenuItem
      key="email"
      onClick={send.sendEmail}
      disabled={send.sending}
      className="items-start"
    >
      <Mail className="h-4 w-4 mt-0.5" />
      <span>
        <span className="block">Send test email</span>
        <span className="block text-xs text-muted-foreground">
          A sample email delivered straight to this endpoint
        </span>
      </span>
    </DropdownMenuItem>
  );
  // mailhooks.cc lists the email first, as its bar and empty state do.
  return <>{mailFirst ? [email, request] : [request, email]}</>;
}

function SendMenu({
  send,
  canEmail,
  mailFirst,
  className,
}: {
  send: SendActions;
  canEmail: boolean;
  mailFirst: boolean;
  className?: string;
}) {
  const buttonClass = cn("py-1.5! px-3! text-xs flex items-center gap-1.5", className);
  if (!canEmail) {
    // Only the request to send: the button opens its dialog directly.
    return (
      <Button
        variant="outlined"
        type="button"
        onClick={() => send.setRequestOpen(true)}
        className={buttonClass}
      >
        <Send className="h-3.5 w-3.5" />
        Send
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outlined"
            type="button"
            className={buttonClass}
            disabled={send.sending}
          />
        }
      >
        <Send className="h-3.5 w-3.5" />
        Send
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 border shadow-float">
        <SendItems send={send} canEmail={canEmail} mailFirst={mailFirst} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The test email's result. Always in the accessibility tree so it is announced. */
function SendStatus({ status }: { status: SendActions["status"] }) {
  // Below the wide layout, Send sits in the Actions menu, so the result is a
  // toast at the foot of the screen; on wide screens it is this text next to Send.
  useEffect(() => {
    if (!status || window.matchMedia("(min-width: 1024px)").matches) return;
    toast.custom(
      () => (
        // The status line below announces it; the toast is only seen.
        <div
          aria-hidden
          className={cn(
            "ml-auto w-fit max-w-full rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-surface",
            status.kind === "error" ? "text-destructive-ink" : "text-muted-foreground"
          )}
        >
          {status.text}
        </div>
      ),
      { id: SEND_TOAST, duration: 6000 }
    );
  }, [status]);
  useEffect(() => () => void toast.dismiss(SEND_TOAST), []);

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        status ? "max-lg:sr-only text-xs max-w-[260px] truncate" : "sr-only",
        status?.kind === "error" ? "text-destructive-ink" : "text-muted-foreground"
      )}
      title={status?.text}
    >
      {status?.text}
    </span>
  );
}

const SEND_TOAST = "send-status";

/**
 * A phone's and a tablet's one menu for what the bar's Setup, Send and Export
 * buttons do on wider screens, so the bar keeps to the address row and the tabs.
 */
function ActionsMenu({
  setup,
  send,
  slug,
  canEmail,
  mailFirst,
  onOpenGuide,
  onOpenSettings,
  onExport,
  copyAddresses,
}: {
  setup: Setup;
  send: SendActions;
  slug: string;
  canEmail: boolean;
  mailFirst: boolean;
  onOpenGuide: () => void;
  onOpenSettings?: (section: SettingsSection) => void;
  onExport?: (format: "json" | "csv") => void;
  /** A phone's address row is hidden (the endpoint has requests): copy them from here. */
  copyAddresses?: { url: string; email: string | null };
}) {
  const copyAddress = async (text: string, what: string) => {
    send.show(
      (await copyToClipboard(text))
        ? { kind: "ok", text: `${what} copied` }
        : { kind: "error", text: `The ${what.toLowerCase()} could not be copied` }
    );
  };
  const email = copyAddresses?.email ?? null;
  const copyItems = copyAddresses
    ? [
        <DropdownMenuItem
          key="url"
          className="md:hidden"
          onClick={() => void copyAddress(copyAddresses.url, "Webhook URL")}
        >
          <Globe className="h-3.5 w-3.5" />
          Copy webhook URL
        </DropdownMenuItem>,
        ...(email
          ? [
              <DropdownMenuItem
                key="email"
                className="md:hidden"
                onClick={() => void copyAddress(email, "Email address")}
              >
                <Mail className="h-3.5 w-3.5" />
                Copy email address
              </DropdownMenuItem>,
            ]
          : []),
      ]
    : [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outlined"
            className="py-1.5! px-3! text-xs flex items-center gap-1.5 max-md:min-h-9"
            type="button"
          />
        }
      >
        <Ellipsis className="h-3.5 w-3.5" />
        Actions
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 max-w-[calc(100vw-2rem)] border shadow-float"
      >
        {copyItems.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground md:hidden">
              Address
            </DropdownMenuLabel>
            {/* The site's own address first, as the address row has it. */}
            {mailFirst ? [...copyItems].reverse() : copyItems}
            <DropdownMenuSeparator className="md:hidden" />
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Send</DropdownMenuLabel>
        <SendItems send={send} canEmail={canEmail} mailFirst={mailFirst} />
        {onExport && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Export</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onExport("json")}>
              <Download className="h-3.5 w-3.5" />
              Export JSON
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("csv")}>
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {setup.open ? setupLabel(setup) : "Help"}
        </DropdownMenuLabel>
        <SetupItems
          setup={setup}
          slug={slug}
          onOpenGuide={onOpenGuide}
          onOpenSettings={onOpenSettings}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The endpoint's addresses: both pills on wide screens; below xl one at a
 * time, the site's own first, with a toggle that swaps it (two pills beside
 * the actions would squeeze both until the values vanish).
 */
function EndpointAddresses({
  slug,
  emailAddress,
  className,
}: {
  slug: string;
  emailAddress?: string | null;
  className?: string;
}) {
  const mailFirst = useSite().key === "mailhooks";
  const [phoneAddress, setPhoneAddress] = useState<"http" | "email">(mailFirst ? "email" : "http");
  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;
  const shownUrl = url.replace(/^https?:\/\//, "");
  const pillClass = "min-w-0 flex-1 xl:flex-none xl:w-auto xl:max-w-[calc(50%-0.25rem)]";
  const httpPill = (
    <AddressPill
      label="HTTP"
      icon={Globe}
      value={shownUrl}
      copyValue={url}
      hideLabelBelowXl
      className={cn(pillClass, phoneAddress !== "http" && "max-xl:hidden")}
    />
  );
  const emailPill = emailAddress ? (
    <AddressPill
      label="Email"
      icon={Mail}
      value={emailAddress}
      hideLabelBelowXl
      className={cn(pillClass, phoneAddress !== "email" && "max-xl:hidden")}
    />
  ) : null;
  return (
    <div className={cn("min-w-0 flex items-center gap-2", className)}>
      {emailAddress ? (
        <>
          {/* In the DOM in the order they show, so Tab meets the site's own first. */}
          {mailFirst ? (
            <>
              {emailPill}
              {httpPill}
            </>
          ) : (
            <>
              {httpPill}
              {emailPill}
            </>
          )}
          <Segmented
            name="Address shown"
            value={phoneAddress}
            onChange={setPhoneAddress}
            size="xs"
            className="xl:hidden shrink-0"
            // In the order the pills come in on wide screens, the site's own first.
            options={
              mailFirst
                ? [
                    { value: "email", label: "Email" },
                    { value: "http", label: "HTTP" },
                  ]
                : [
                    { value: "http", label: "HTTP" },
                    { value: "email", label: "Email" },
                  ]
            }
          />
        </>
      ) : (
        <>
          <AddressPill
            label="HTTP"
            icon={Globe}
            value={shownUrl}
            copyValue={url}
            className="min-w-0 flex-1 md:flex-none md:w-auto md:max-w-[44%]"
          />
          <span className="max-md:hidden inline-flex items-center gap-2 h-9 px-3 text-xs text-muted-foreground border border-dashed rounded-md">
            <Lock className="h-3 w-3" />
            Endpoints on an account also receive email
          </span>
        </>
      )}
    </div>
  );
}

export function EndpointBar({
  name,
  slug,
  emailAddress,
  tab,
  onTabChange,
  hasRequests,
  exportMenu,
  onExport,
  setupState,
  onOpenSettings,
  detailOpen = false,
}: EndpointBarProps) {
  const [guideOpen, setGuideOpen] = useState(false);
  const mailFirst = useSite().key === "mailhooks";
  const canEmail = Boolean(emailAddress);
  // mailhooks.cc's checklist whatever the endpoint: its address may not be known yet.
  const setup = useGettingStarted(hasRequests, setupState, mailFirst);
  const send = useSendActions(slug);
  const openGuide = () => setGuideOpen(true);
  // mailhooks.cc names its request list for what it mostly holds.
  const inboxLabel = mailFirst && canEmail ? "Inbox" : "Requests";
  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;
  // Export folds into Actions on a phone when the page hands over the exports
  // themselves; otherwise its own menu sits beside Actions.
  const phoneExport = hasRequests ? onExport : undefined;
  // A phone's address row goes once requests arrive; one line under the tabs
  // keeps the site's own address in sight and copies it on a tap.
  const phoneAddress =
    mailFirst && emailAddress
      ? { shown: emailAddress, copy: emailAddress, what: "Email address" }
      : { shown: url.replace(/^https?:\/\//, ""), copy: url, what: "Webhook URL" };
  const copyPhoneAddress = async () => {
    send.show(
      (await copyToClipboard(phoneAddress.copy))
        ? { kind: "ok", text: `${phoneAddress.what} copied` }
        : { kind: "error", text: `The ${phoneAddress.what.toLowerCase()} could not be copied` }
    );
  };

  return (
    <div className="border-b bg-card px-4 pt-3 max-md:pt-2 shrink-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* On a phone the header's endpoint switcher already shows the name. */}
        <h1 className="font-bold text-sm tracking-normal shrink-0 order-1 max-md:sr-only">
          {name}
        </h1>
        {/* Once requests arrive, a phone gives the list the address row's room:
            the addresses are copied from Actions there. */}
        <EndpointAddresses
          slug={slug}
          emailAddress={emailAddress}
          className={cn(
            "order-3 md:order-2 w-full md:w-auto md:flex-1",
            (detailOpen || hasRequests) && "max-md:hidden"
          )}
        />
        {/* Below lg the group's box goes (its buttons move to Actions, which
            leaves a tablet's address its room) and only the send status stays, as
            a toast. */}
        <div
          className={cn(
            "order-2 md:order-3 ml-auto flex items-center gap-2",
            detailOpen ? "max-md:hidden" : "max-lg:contents"
          )}
        >
          <SendStatus status={send.status} />
          <SetupMenu
            setup={setup}
            slug={slug}
            onOpenGuide={openGuide}
            onOpenSettings={onOpenSettings}
            className="max-lg:hidden"
          />
          <SendMenu
            send={send}
            canEmail={canEmail}
            mailFirst={mailFirst}
            className="max-lg:hidden"
          />
          {exportMenu && <div className="max-lg:hidden">{exportMenu}</div>}
        </div>
      </div>
      <nav className="flex items-center gap-1 mt-2 max-md:mt-1" aria-label="Endpoint">
        {(["requests", "settings"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => onTabChange(entry)}
            aria-current={tab === entry ? "page" : undefined}
            className={cn(
              "relative h-9 px-3 text-sm font-semibold cursor-pointer transition-colors",
              tab === entry ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {entry === "requests" ? inboxLabel : "Settings"}
            {tab === entry && (
              // The bar's bottom line is light, so the marker covers it.
              <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-foreground" />
            )}
          </button>
        ))}
        {/* A phone with a request open keeps to the tabs; a tablet keeps its Actions. */}
        <div
          className={cn("lg:hidden ml-auto flex items-center gap-2", detailOpen && "max-md:hidden")}
        >
          {exportMenu && !phoneExport && exportMenu}
          <ActionsMenu
            setup={setup}
            send={send}
            slug={slug}
            canEmail={canEmail}
            mailFirst={mailFirst}
            onOpenGuide={openGuide}
            onOpenSettings={onOpenSettings}
            onExport={phoneExport}
            copyAddresses={hasRequests ? { url, email: emailAddress ?? null } : undefined}
          />
        </div>
      </nav>
      {hasRequests && !detailOpen && (
        <button
          type="button"
          onClick={() => void copyPhoneAddress()}
          aria-label={`Copy ${phoneAddress.shown}`}
          title="Copy"
          className="md:hidden flex w-full min-w-0 items-center gap-1.5 -mt-1 py-1.5 text-left text-xs font-mono text-muted-foreground hover:text-foreground cursor-pointer [font-variant-ligatures:none]"
        >
          <span className="truncate">{phoneAddress.shown}</span>
          <Copy className="h-3 w-3 shrink-0" aria-hidden />
        </button>
      )}
      <SendWebhookDialog slug={slug} open={send.requestOpen} onOpenChange={send.setRequestOpen} />
      <DashboardGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
    </div>
  );
}
