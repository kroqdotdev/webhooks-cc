"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Copy,
  Globe,
  HelpCircle,
  ListChecks,
  Lock,
  Mail,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { sendTestEmail } from "@/lib/dashboard-api";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SendWebhookDialog } from "./send-webhook-dialog";
import { DashboardGuideDialog } from "./dashboard-guide-dialog";
import { useGettingStarted } from "./getting-started";

export type EndpointTab = "requests" | "settings";

interface EndpointBarProps {
  name: string;
  slug: string;
  /** null for endpoints that cannot receive email (no owner). */
  emailAddress?: string | null;
  tab: EndpointTab;
  onTabChange: (tab: EndpointTab) => void;
  hasRequests: boolean;
  /** The Export menu, when there is something to export. */
  exportMenu?: React.ReactNode;
}

/** "label | value | copy", the idiom the email view's picks share. */
export function AddressPill({
  label,
  icon: Icon,
  value,
  copyValue,
  className,
}: {
  label: string;
  icon: React.ElementType;
  value: string;
  copyValue?: string;
  className?: string;
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
        "inline-flex items-stretch h-9 min-w-0 border-strong border-line rounded-md bg-background shadow-raised-sm overflow-hidden",
        className
      )}
    >
      <span className="flex items-center gap-1.5 px-2.5 bg-muted text-muted-foreground text-[11px] font-semibold caps border-r-strong border-line shrink-0">
        <Icon className="h-3 w-3 hidden sm:block" />
        {label}
      </span>
      <button
        type="button"
        onClick={copy}
        className="flex flex-1 items-center px-2.5 min-w-0 font-mono text-[13px] text-left cursor-pointer hover:bg-muted/50"
        title="Copy"
      >
        <span className="truncate">{value}</span>
      </button>
      <button
        type="button"
        onClick={copy}
        className="flex items-center justify-center w-9 shrink-0 border-l-strong border-line text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors"
        aria-label={`Copy ${label === "HTTP" ? "webhook URL" : "email address"}`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

function SetupMenu({
  hasRequests,
  onOpenGuide,
}: {
  hasRequests: boolean;
  onOpenGuide: () => void;
}) {
  const setup = useGettingStarted(hasRequests);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
        >
          {setup.open ? (
            <ListChecks className="h-3.5 w-3.5" />
          ) : (
            <HelpCircle className="h-3.5 w-3.5" />
          )}
          {setup.open ? `Setup ${setup.progress}/${setup.total}` : "Guide"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border-strong border-line shadow-raised">
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
            return item.href ? (
              <DropdownMenuItem key={item.id} asChild onSelect={() => setup.markVisited(item.id)}>
                <Link href={item.href}>{body}</Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={item.id} disabled={done}>
                {body}
              </DropdownMenuItem>
            );
          })}
        {setup.open && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onOpenGuide}>
          <HelpCircle className="h-3.5 w-3.5" />
          Dashboard guide
        </DropdownMenuItem>
        {setup.open && (
          <DropdownMenuItem onSelect={setup.dismiss} className="text-muted-foreground">
            Hide the setup list
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SendMenu({ slug, canEmail }: { slug: string; canEmail: boolean }) {
  const { session } = useAuth();
  const [requestOpen, setRequestOpen] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const show = (next: { kind: "ok" | "error"; text: string }) => {
    setStatus(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 6000);
  };

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

  return (
    <>
      {/* Always in the accessibility tree so the result is announced; a bubble
          under Send on narrow screens, inline text next to it on wide ones. */}
      <span
        role="status"
        aria-live="polite"
        className={cn(
          !status
            ? "sr-only"
            : "absolute right-0 top-full z-20 mt-2 w-max max-w-[min(280px,calc(100vw-2rem))] rounded-md border-strong border-line bg-card px-2.5 py-1.5 text-xs shadow-raised-sm lg:static lg:mt-0 lg:w-auto lg:max-w-[260px] lg:truncate lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none",
          status?.kind === "error" ? "text-destructive" : "text-muted-foreground"
        )}
        title={status?.text}
      >
        {status?.text}
      </span>
      {canEmail ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
              disabled={sending}
            >
              <Send className="h-3.5 w-3.5" />
              Send
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 border-strong border-line shadow-raised">
            <DropdownMenuItem onSelect={() => setRequestOpen(true)} className="items-start">
              <Globe className="h-4 w-4 mt-0.5" />
              <span>
                <span className="block">Send test request</span>
                <span className="block text-xs text-muted-foreground">
                  A POST with a JSON body, or a signed provider template
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={sendEmail} className="items-start">
              <Mail className="h-4 w-4 mt-0.5" />
              <span>
                <span className="block">Send test email</span>
                <span className="block text-xs text-muted-foreground">
                  A sample email delivered straight to this endpoint
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <SendWebhookDialog
        slug={slug}
        {...(canEmail ? { open: requestOpen, onOpenChange: setRequestOpen } : {})}
      />
    </>
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
}: EndpointBarProps) {
  const [guideOpen, setGuideOpen] = useState(false);
  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;
  const shownUrl = url.replace(/^https?:\/\//, "");

  return (
    <div className="border-b-strong border-line bg-card px-4 pt-3 shrink-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-bold text-sm caps shrink-0 order-1">{name}</span>
        <div className="order-3 md:order-2 w-full md:w-auto md:flex-1 min-w-0 flex flex-col md:flex-row gap-2">
          <AddressPill
            label="HTTP"
            icon={Globe}
            value={shownUrl}
            copyValue={url}
            className="w-full md:w-auto md:max-w-[44%]"
          />
          {emailAddress ? (
            <AddressPill
              label="Email"
              icon={Mail}
              value={emailAddress}
              className="w-full md:w-auto md:max-w-[44%]"
            />
          ) : (
            <span className="inline-flex items-center gap-2 h-9 px-3 text-xs text-muted-foreground border-strong border-line border-dashed rounded-md">
              <Lock className="h-3 w-3" />
              Endpoints on an account also receive email
            </span>
          )}
        </div>
        <div className="relative order-2 md:order-3 ml-auto flex items-center gap-2">
          <div className="hidden md:block">
            <SetupMenu hasRequests={hasRequests} onOpenGuide={() => setGuideOpen(true)} />
          </div>
          <SendMenu slug={slug} canEmail={!!emailAddress} />
          {exportMenu && <div className="hidden md:block">{exportMenu}</div>}
        </div>
      </div>
      <nav className="flex gap-1 mt-2" aria-label="Endpoint">
        {(["requests", "settings"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => onTabChange(entry)}
            aria-current={tab === entry ? "page" : undefined}
            className={cn(
              "relative h-9 px-3 text-sm font-semibold caps cursor-pointer transition-colors",
              tab === entry ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {entry === "requests" ? "Requests" : "Settings"}
            {tab === entry && (
              // Classic's bottom line is already foreground, so the marker sits on top of it;
              // clean's line is light, so the marker covers it.
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[3px] clean:-bottom-px clean:h-0.5 bg-foreground"
              />
            )}
          </button>
        ))}
      </nav>
      <DashboardGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
    </div>
  );
}
