"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { trackTestWebhookSent } from "@/lib/analytics";
import { WEB_TEMPLATE_PROVIDER_OPTIONS } from "@/lib/provider-catalog";
import {
  buildTemplateRequest,
  getDefaultTemplateId,
  getTemplatePresets,
  isSecretRequired,
  type TemplateProvider,
} from "@/lib/template-send";
import { CodeBox } from "@/components/ui/code";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type SendMode = "manual" | TemplateProvider;

/** The heading of each group of modes in the Mode dropdown. */
const GROUP_LABEL = "pl-2 text-xs font-semibold text-muted-foreground";

interface SendWebhookDialogProps {
  slug: string;
  /** Controlled open state, for opening from a menu; uses its own button otherwise. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type TemplateSelectionByProvider = Record<TemplateProvider, string>;

function defaultTemplateSelection(): TemplateSelectionByProvider {
  return Object.fromEntries(
    WEB_TEMPLATE_PROVIDER_OPTIONS.map(({ id }) => [id, getDefaultTemplateId(id)])
  ) as TemplateSelectionByProvider;
}

/**
 * The catalog labels each template "<Provider> template", with "(signed)" or
 * "(token)" when the request carries a signature or a secret token. The mode
 * list groups by that instead of repeating it on every option.
 */
function templateOptionGroups() {
  const signed: { id: TemplateProvider; label: string }[] = [];
  const unsigned: { id: TemplateProvider; label: string }[] = [];
  for (const option of WEB_TEMPLATE_PROVIDER_OPTIONS) {
    const match = / template(?: \((signed|token)\))?$/.exec(option.label);
    const name = match ? option.label.slice(0, match.index) : option.label;
    if (match?.[1] === "signed") signed.push({ id: option.id, label: name });
    else if (match?.[1] === "token")
      signed.push({ id: option.id, label: `${name} (secret token)` });
    else unsigned.push({ id: option.id, label: name });
  }
  return { signed, unsigned };
}

const { signed: SIGNED_TEMPLATE_OPTIONS, unsigned: UNSIGNED_TEMPLATE_OPTIONS } =
  templateOptionGroups();

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    out[key] = value;
  }

  return out;
}

export function SendWebhookDialog({
  slug,
  open: controlledOpen,
  onOpenChange,
}: SendWebhookDialogProps) {
  const { session } = useAuth();
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [mode, setMode] = useState<SendMode>("manual");
  const [templates, setTemplates] = useState<TemplateSelectionByProvider>(defaultTemplateSelection);
  const [method, setMethod] = useState<HttpMethod>("POST");
  const [path, setPath] = useState("/");
  const [headersInput, setHeadersInput] = useState("Content-Type: application/json");
  const [body, setBody] = useState('{"test": true}');
  const [mockWebhookSecret, setMockWebhookSecret] = useState("mock_webhook_secret");
  const [templateEventOverride, setTemplateEventOverride] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [statusText, setStatusText] = useState("");
  const endpointUrl = useMemo(() => `${WEBHOOK_BASE_URL}/w/${slug}`, [slug]);

  const isTemplateMode = mode !== "manual";
  const providerPresets = isTemplateMode ? getTemplatePresets(mode) : [];
  const selectedTemplateId = isTemplateMode ? templates[mode] : "";
  const selectedTemplate = isTemplateMode
    ? (providerPresets.find((preset) => preset.id === selectedTemplateId) ?? providerPresets[0])
    : null;

  const handleModeChange = (nextMode: SendMode) => {
    setMode(nextMode);
    setStatus("idle");
    setStatusText("");
    setTemplateEventOverride("");
    if (nextMode !== "manual") {
      setTemplates((prev) => ({
        ...prev,
        [nextMode]: prev[nextMode] || getDefaultTemplateId(nextMode),
      }));
    }
  };

  const handleTemplateChange = (provider: TemplateProvider, templateId: string) => {
    setTemplates((prev) => ({ ...prev, [provider]: templateId }));
    setStatus("idle");
    setStatusText("");
    setTemplateEventOverride("");
  };

  const handleSend = async () => {
    setStatus("sending");
    setStatusText("");

    const normalizedPath = path.trim()
      ? path.trim().startsWith("/")
        ? path.trim()
        : `/${path.trim()}`
      : "/";
    const url = `${endpointUrl}${normalizedPath === "/" ? "" : normalizedPath}`;

    const customHeaders = parseHeaders(headersInput);
    const hasHeaderInput = headersInput.split("\n").some((line) => line.trim().length > 0);
    if (hasHeaderInput && Object.keys(customHeaders).length === 0) {
      setStatus("error");
      setStatusText("Headers must use one 'Key: Value' entry per line");
      return;
    }

    let requestMethod: string = method;
    let requestHeaders: Record<string, string> = customHeaders;
    let requestBody: string | undefined = method === "GET" ? undefined : body || undefined;

    if (isTemplateMode) {
      try {
        const template = await buildTemplateRequest({
          provider: mode,
          template: templates[mode],
          secret: mockWebhookSecret,
          event: templateEventOverride || undefined,
          targetUrl: url,
        });
        requestMethod = template.method;
        const filteredCustom = Object.fromEntries(
          Object.entries(customHeaders).filter(([k]) => k.toLowerCase() !== "content-type")
        );
        requestHeaders = { ...template.headers, ...filteredCustom };
        requestBody = template.body;
      } catch (error) {
        setStatus("error");
        setStatusText(error instanceof Error ? error.message : "Failed to build template request");
        return;
      }
    }

    try {
      const accessToken = session?.access_token;
      if (!accessToken) {
        setStatus("error");
        setStatusText("Not authenticated");
        return;
      }

      const response = await fetch("/api/send-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          method: requestMethod,
          slug,
          path: normalizedPath,
          headers: requestHeaders,
          body: requestBody,
        }),
      });

      const text = await response.text();
      let result: Record<string, unknown> = {};
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        setStatus("error");
        setStatusText(`Invalid response from server: ${text.slice(0, 100) || "(empty)"}`);
        return;
      }

      if (!response.ok) {
        setStatus("error");
        setStatusText((result.error as string) || `Proxy error: ${response.status}`);
        return;
      }

      setStatus("sent");
      setStatusText(`${result.status ?? ""} ${result.statusText ?? ""}`.trim());
      trackTestWebhookSent(isTemplateMode ? mode : "manual", result.status as number);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setStatus("error");
      setStatusText(message || "Request failed");
    }
  };

  const resetAndClose = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setStatus("idle");
      setStatusText("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      {!controlled && (
        <DialogTrigger
          render={
            <Button
              variant="outlined"
              className="py-1.5! px-3! text-xs flex items-center gap-1.5"
            />
          }
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </DialogTrigger>
      )}
      <DialogContent className="border shadow-float max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-bold tracking-normal">Send a test request</DialogTitle>
          <DialogDescription className="sr-only">
            Send a test request to this endpoint
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label htmlFor="send-mode" className="block text-xs font-bold mb-2">
                Mode
              </label>
              <Select value={mode} onValueChange={(value) => handleModeChange(value as SendMode)}>
                <SelectTrigger id="send-mode" field className="text-sm w-full h-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectGroup>
                    <SelectLabel className={GROUP_LABEL}>Write your own</SelectLabel>
                    <SelectItem value="manual">Manual request</SelectItem>
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel className={GROUP_LABEL}>Signed provider templates</SelectLabel>
                    {SIGNED_TEMPLATE_OPTIONS.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel className={GROUP_LABEL}>Unsigned templates</SelectLabel>
                    {UNSIGNED_TEMPLATE_OPTIONS.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {isTemplateMode && (
              <div>
                <label htmlFor="send-template" className="block text-xs font-bold mb-2">
                  Template preset
                </label>
                <Select
                  value={selectedTemplateId}
                  onValueChange={(value) => handleTemplateChange(mode, value)}
                >
                  <SelectTrigger id="send-template" field className="text-sm w-full h-auto">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerPresets.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {isTemplateMode && (
            <>
              {isSecretRequired(mode) && (
                <div>
                  <label htmlFor="send-secret" className="block text-xs font-bold mb-2">
                    {mode === "gitlab" ? "Mock webhook token" : "Mock webhook secret"}
                  </label>
                  <Input
                    id="send-secret"
                    aria-describedby="send-secret-help"
                    value={mockWebhookSecret}
                    onChange={(e) => setMockWebhookSecret(e.target.value)}
                    field
                    className="text-sm"
                    placeholder={mode === "gitlab" ? "gl_token_..." : "whsec_..."}
                  />
                  <p id="send-secret-help" className="mt-2 text-xs text-muted-foreground">
                    {mode === "gitlab"
                      ? "The token your app checks in the x-gitlab-token header."
                      : "The signing secret your app uses to verify webhook signatures."}
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="send-event" className="block text-xs font-bold mb-2">
                  Event/topic override (optional)
                </label>
                <Input
                  id="send-event"
                  value={templateEventOverride}
                  onChange={(e) => setTemplateEventOverride(e.target.value)}
                  field
                  className="text-sm"
                  placeholder={selectedTemplate?.event ?? "event.name"}
                />
              </div>

              <CodeBox className="p-3! text-xs space-y-1">
                <p>
                  <span className="font-bold">Template:</span> {selectedTemplate?.description}
                </p>
                <p>
                  <span className="font-bold">Default event/topic:</span> {selectedTemplate?.event}
                </p>
                <p>
                  <span className="font-bold">Content-Type:</span> {selectedTemplate?.contentType}
                </p>
                <p className="pt-1">
                  Need field-level examples?{" "}
                  <Link href="/docs/endpoints/test-webhooks" className="underline font-bold">
                    Open dashboard test webhook docs
                  </Link>
                </p>
              </CodeBox>
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <label htmlFor="send-method" className="block text-xs font-bold mb-2">
                Method
              </label>
              <Select
                value={method}
                onValueChange={(value) => setMethod(value as HttpMethod)}
                disabled={isTemplateMode}
              >
                <SelectTrigger id="send-method" field className="text-sm w-full h-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <label htmlFor="send-path" className="block text-xs font-bold mb-2">
                Path
              </label>
              <Input
                id="send-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/"
                field
                className="text-sm"
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-bold mb-2">Endpoint</p>
            <CodeBox className="text-xs overflow-x-auto" render={<pre />}>
              {endpointUrl}
            </CodeBox>
          </div>

          <div>
            <label htmlFor="send-headers" className="block text-xs font-bold mb-2">
              Headers (one per line: Key: Value)
            </label>
            <Textarea
              id="send-headers"
              value={headersInput}
              onChange={(e) => setHeadersInput(e.target.value)}
              field
              className="min-h-24 font-mono text-sm"
            />
          </div>

          <div>
            <label htmlFor="send-body" className="block text-xs font-bold mb-2">
              Body
            </label>
            <Textarea
              id="send-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              field
              className="min-h-28 font-mono text-sm"
              placeholder='{"event":"test"}'
              disabled={method === "GET" || isTemplateMode}
            />
          </div>

          {status === "error" ? (
            <div className="border border-destructive rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
              {statusText || "Sent"}
            </div>
          ) : status !== "idle" ? (
            <CodeBox className="p-3! text-sm">
              {status === "sending" ? "Sending..." : statusText || "Sent"}
            </CodeBox>
          ) : null}

          <Button onClick={handleSend} disabled={status === "sending"} raised className="w-full">
            {status === "sending" ? "Sending..." : "Send request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
