"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import {
  buildTemplateRequest,
  getDefaultTemplateId,
  getTemplatePresets,
  type TemplateProvider,
} from "@/lib/template-send";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type SendMode = "manual" | TemplateProvider;

interface SendWebhookDialogProps {
  slug: string;
}

interface TemplateSelectionByProvider {
  stripe: string;
  github: string;
  shopify: string;
  twilio: string;
}

function defaultTemplateSelection(): TemplateSelectionByProvider {
  return {
    stripe: getDefaultTemplateId("stripe"),
    github: getDefaultTemplateId("github"),
    shopify: getDefaultTemplateId("shopify"),
    twilio: getDefaultTemplateId("twilio"),
  };
}

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

export function SendWebhookDialog({ slug }: SendWebhookDialogProps) {
  const [open, setOpen] = useState(false);
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
      const response = await fetch(url, {
        method: requestMethod,
        headers: requestHeaders,
        body: requestBody,
      });
      setStatus("sent");
      setStatusText(`${response.status} ${response.statusText}`.trim());
    } catch (error) {
      // Browser CORS can hide response details even if request reached receiver.
      const message = error instanceof Error ? error.message : "";
      const likelyCorsOpaque =
        error instanceof TypeError &&
        /Failed to fetch|Load failed|NetworkError/i.test(message || "Failed to fetch");

      if (likelyCorsOpaque) {
        setStatus("sent");
        setStatusText("Request sent (response unavailable due to browser restrictions)");
        return;
      }

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
      <DialogTrigger asChild>
        <button className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5">
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground shadow-neo max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-bold uppercase tracking-wide">Send Webhook</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide mb-2">Mode</p>
              <select
                value={mode}
                onChange={(e) => handleModeChange(e.target.value as SendMode)}
                className="neo-input text-sm w-full"
              >
                <option value="manual">Manual request</option>
                <option value="stripe">Stripe template (signed)</option>
                <option value="github">GitHub template (signed)</option>
                <option value="shopify">Shopify template (signed)</option>
                <option value="twilio">Twilio template (signed)</option>
              </select>
            </div>
            {isTemplateMode && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wide mb-2">Template preset</p>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => handleTemplateChange(mode, e.target.value)}
                  className="neo-input text-sm w-full"
                >
                  {providerPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {isTemplateMode && (
            <>
              <div>
                <p className="text-xs font-bold uppercase tracking-wide mb-2">
                  Mock webhook secret
                </p>
                <Input
                  value={mockWebhookSecret}
                  onChange={(e) => setMockWebhookSecret(e.target.value)}
                  className="neo-input text-sm"
                  placeholder="whsec_..."
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  The signing secret your app uses to verify webhook signatures.
                </p>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-wide mb-2">
                  Event/topic override (optional)
                </p>
                <Input
                  value={templateEventOverride}
                  onChange={(e) => setTemplateEventOverride(e.target.value)}
                  className="neo-input text-sm"
                  placeholder={selectedTemplate?.event ?? "event.name"}
                />
              </div>

              <div className="neo-code p-3! text-xs space-y-1">
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
              </div>
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as HttpMethod)}
              className="neo-input text-sm"
              disabled={isTemplateMode}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <div className="md:col-span-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/"
                className="neo-input text-sm"
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-bold uppercase tracking-wide mb-2">Endpoint</p>
            <pre className="neo-code text-xs overflow-x-auto">{endpointUrl}</pre>
          </div>

          <div>
            <p className="text-xs font-bold uppercase tracking-wide mb-2">
              Headers (one per line: Key: Value)
            </p>
            <Textarea
              value={headersInput}
              onChange={(e) => setHeadersInput(e.target.value)}
              className="neo-input min-h-24 font-mono text-sm"
            />
          </div>

          <div>
            <p className="text-xs font-bold uppercase tracking-wide mb-2">Body</p>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="neo-input min-h-28 font-mono text-sm"
              placeholder='{"event":"test"}'
              disabled={method === "GET" || isTemplateMode}
            />
          </div>

          {status !== "idle" && (
            <div
              className={
                status === "error"
                  ? "border-2 border-destructive bg-destructive/10 p-3 text-sm text-destructive"
                  : "neo-code p-3! text-sm"
              }
            >
              {status === "sending" ? "Sending..." : statusText || "Sent"}
            </div>
          )}

          <Button
            onClick={handleSend}
            disabled={status === "sending"}
            className="w-full neo-btn-primary rounded-none!"
          >
            {status === "sending" ? "Sending..." : "Send webhook"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
