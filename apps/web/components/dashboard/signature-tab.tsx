"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert, Shield, Copy, Check, Loader2 } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import {
  getWebProviderInfo,
  getWebProviderLabel,
  WEB_PROVIDER_CATALOG,
} from "@/lib/provider-catalog";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import type { DisplayableRequest } from "./request-detail";

/**
 * Providers whose signature is computed over the request URL (and, for HubSpot,
 * the HTTP method). For these, verifySignature() requires `options.url`, so the
 * manual-verify UI must expose a URL field (and a method field for HubSpot).
 */
const URL_BOUND_PROVIDERS = new Set(["twilio", "square", "hubspot"]);
const METHOD_BOUND_PROVIDERS = new Set(["hubspot"]);

/**
 * Reconstruct the capture URL the receiver signs against:
 * `${WEBHOOK_BASE_URL}/w/${slug}${path === "/" ? "" : path}` plus the query
 * string, mirroring the receiver's build_verification_request_url().
 */
function buildVerificationUrl(slug: string | undefined, request: DisplayableRequest): string {
  if (!slug) return "";
  const path = request.path === "/" ? "" : request.path;
  const params = request.queryParams ?? {};
  const query = new URLSearchParams(params).toString();
  return `${WEBHOOK_BASE_URL}/w/${slug}${path}${query ? `?${query}` : ""}`;
}

/** Parsed structured signature error from JSON string. */
interface SignatureErrorData {
  code?: string;
  expected?: string;
  received?: string;
  timestamp?: number;
  header?: string;
  message?: string;
}

function parseSignatureError(error: string | null | undefined): SignatureErrorData | null {
  if (!error) return null;
  try {
    return JSON.parse(error) as SignatureErrorData;
  } catch {
    return { message: error };
  }
}

/** Provider-specific debugging tips. */
function getProviderTip(provider: string): string | null {
  const tips: Record<string, string> = {
    stripe:
      "Check your signing secret in the Stripe dashboard (Developers → Webhooks → Signing secret). Make sure you're using the endpoint-specific secret, not the global one.",
    github:
      "Check Settings → Webhooks → Secret in your GitHub repository. The secret must match exactly.",
    shopify: "Find the API secret key in your Shopify app settings under App credentials.",
    slack: "Find the Signing Secret in your Slack app's Basic Information page, not the bot token.",
    paddle:
      "Check the webhook secret in your Paddle dashboard under Developer Tools → Notifications.",
    discord:
      "Use the Application Public Key from the General Information page in the Discord Developer Portal.",
    clerk: "Find the signing secret in your Clerk dashboard under Webhooks.",
  };
  return tips[provider] ?? null;
}

interface SignatureTabProps {
  request: DisplayableRequest;
  onOpenSettings?: () => void;
  endpointSlug?: string;
}

export function SignatureTab({ request, onOpenSettings, endpointSlug }: SignatureTabProps) {
  const signatureVerified = request.signatureVerified;
  const signatureError = request.signatureError;
  const signingProvider = request.signingProvider;

  // Server-side result available
  if (signatureVerified !== null && signatureVerified !== undefined) {
    return (
      <ServerSideResult
        verified={signatureVerified}
        error={signatureError ?? null}
        provider={signingProvider ?? null}
      />
    );
  }

  // Client-side verification mode
  // key resets component state when switching between requests
  const requestId =
    "id" in request
      ? (request as { id: string }).id
      : "_id" in request
        ? (request as { _id: string })._id
        : "";
  return (
    <ClientSideVerification
      key={requestId}
      request={request}
      onOpenSettings={onOpenSettings}
      endpointSlug={endpointSlug}
    />
  );
}

/** Display server-side verification result (read-only). */
function ServerSideResult({
  verified,
  error,
  provider,
}: {
  verified: boolean;
  error: string | null;
  provider: string | null;
}) {
  const errorData = parseSignatureError(error);
  const providerInfo = getWebProviderInfo(provider);
  const tip = provider ? getProviderTip(provider) : null;

  if (verified) {
    return (
      <div className="border-2 border-foreground border-l-4 border-l-primary p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="font-bold uppercase tracking-wide text-xs text-primary">
              Signature Valid
            </span>
          </div>
          {providerInfo && (
            <span className="text-xs font-mono text-muted-foreground">{providerInfo.label}</span>
          )}
        </div>
        <div className="neo-code p-3 text-sm">
          <table className="font-mono w-full">
            <tbody>
              <Row label="Provider" value={providerInfo?.label ?? provider ?? "Unknown"} />
              <Row label="Algorithm" value={providerInfo?.algorithm ?? "HMAC-SHA256"} />
              {providerInfo?.header && <Row label="Header" value={providerInfo.header} />}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Invalid or skipped
  const isSkipped = errorData?.code === "missing_header" || errorData?.code === "unsupported";

  if (isSkipped) {
    return (
      <div className="border-2 border-foreground border-l-4 border-l-yellow-500 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-yellow-600" />
            <span className="font-bold uppercase tracking-wide text-xs text-yellow-600">
              Verification Skipped
            </span>
          </div>
          {providerInfo && (
            <span className="text-xs font-mono text-muted-foreground">{providerInfo.label}</span>
          )}
        </div>
        {errorData?.message && <p className="text-sm text-muted-foreground">{errorData.message}</p>}
      </div>
    );
  }

  return (
    <div className="border-2 border-foreground border-l-4 border-l-destructive p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-destructive" />
          <span className="font-bold uppercase tracking-wide text-xs text-destructive">
            {errorData?.code === "mismatch" ? "Signature Mismatch" : "Signature Invalid"}
          </span>
        </div>
        {providerInfo && (
          <span className="text-xs font-mono text-muted-foreground">{providerInfo.label}</span>
        )}
      </div>

      {(errorData?.expected || errorData?.received) && (
        <div className="neo-code p-3 text-sm space-y-1">
          <table className="font-mono w-full">
            <tbody>
              {errorData?.expected && <CopyableRow label="Expected" value={errorData.expected} />}
              {errorData?.received && <CopyableRow label="Received" value={errorData.received} />}
              {errorData?.timestamp != null && (
                <Row
                  label="Timestamp"
                  value={`${errorData.timestamp} (${new Date(errorData.timestamp * 1000).toISOString()})`}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {errorData?.message && !errorData.expected && (
        <p className="text-sm text-muted-foreground">{errorData.message}</p>
      )}

      {tip && (
        <div className="bg-muted border border-foreground/20 p-3 text-xs text-muted-foreground">
          <span className="font-bold uppercase tracking-wide">Tip: </span>
          {tip}
        </div>
      )}
    </div>
  );
}

/** Client-side verification UI — paste secret, verify in browser. */
function ClientSideVerification({
  request,
  onOpenSettings,
  endpointSlug,
}: {
  request: DisplayableRequest;
  onOpenSettings?: () => void;
  endpointSlug?: string;
}) {
  const detectedProvider = request.detectedProvider ?? null;
  const [provider, setProvider] = useState<string>(detectedProvider ?? "");
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState(() => buildVerificationUrl(endpointSlug, request));
  const [method, setMethod] = useState(request.method || "POST");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; error: string | null } | null>(null);

  const providerInfo = getWebProviderInfo(provider);
  const needsUrl = URL_BOUND_PROVIDERS.has(provider);
  const needsMethod = METHOD_BOUND_PROVIDERS.has(provider);

  const handleVerify = useCallback(async () => {
    if (!provider || !secret) return;
    if (needsUrl && !url) return;
    setVerifying(true);
    setResult(null);

    try {
      const { verifySignature } = await import("@webhooks-cc/sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: any =
        provider === "discord" ? { provider: "discord", publicKey: secret } : { provider, secret };
      if (needsUrl) options.url = url;
      if (needsMethod) options.method = method;
      const res = await verifySignature(
        { body: request.body ?? "", headers: request.headers },
        options
      );
      setResult({
        verified: res.valid,
        error: res.valid
          ? null
          : JSON.stringify({
              code: "mismatch",
              message: "Computed signature does not match the received signature",
              header: providerInfo?.header,
            }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed";
      const isLoadError =
        message.includes("import") || message.includes("fetch") || message.includes("chunk");
      setResult({
        verified: false,
        error: JSON.stringify({
          code: isLoadError ? "load_error" : "verification_error",
          message: isLoadError
            ? "Failed to load verification library. Check your network connection and try again."
            : message,
        }),
      });
    } finally {
      setVerifying(false);
    }
  }, [
    provider,
    secret,
    needsUrl,
    needsMethod,
    url,
    method,
    request.body,
    request.headers,
    providerInfo,
  ]);

  // Show result if verification was performed
  if (result) {
    return (
      <div className="space-y-4">
        <ServerSideResult verified={result.verified} error={result.error} provider={provider} />
        <button onClick={() => setResult(null)} className="neo-btn-outline py-1.5! px-3! text-xs">
          Verify Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="font-bold uppercase tracking-wide text-xs mb-1">Verify Signature</p>
        <p className="text-xs text-muted-foreground">
          Paste your signing secret to verify this request&apos;s signature. Verification runs in
          your browser — the secret is never sent to our servers.
        </p>
      </div>

      {detectedProvider && (
        <div className="text-xs text-muted-foreground">
          <span className="font-bold uppercase tracking-wide">Detected: </span>
          {getWebProviderLabel(detectedProvider) ?? detectedProvider}
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="sig-provider" className="font-bold uppercase tracking-wide text-xs">
            Provider
          </label>
          <select
            id="sig-provider"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setResult(null);
            }}
            className="neo-input w-full text-sm"
          >
            <option value="">Select provider...</option>
            {Object.entries(WEB_PROVIDER_CATALOG).map(([key, info]) => (
              <option key={key} value={key}>
                {info.label}
              </option>
            ))}
          </select>
        </div>

        {provider && getWebProviderInfo(provider)?.verificationMode !== "unsupported" && (
          <div className="space-y-1">
            <label htmlFor="sig-secret" className="font-bold uppercase tracking-wide text-xs">
              {getWebProviderInfo(provider)?.verificationMode === "publicKey"
                ? "Public Key"
                : "Secret"}
            </label>
            <input
              id="sig-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={providerInfo?.secretPlaceholder ?? "your secret"}
              className="neo-input w-full text-sm font-mono"
              disabled={verifying}
            />
          </div>
        )}

        {needsUrl && (
          <div className="space-y-1">
            <label htmlFor="sig-url" className="font-bold uppercase tracking-wide text-xs">
              Request URL
            </label>
            <input
              id="sig-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://go.webhooks.cc/w/your-slug"
              className="neo-input w-full text-sm font-mono"
              disabled={verifying}
            />
            <p className="text-xs text-muted-foreground">
              {getWebProviderInfo(provider)?.label} signs the request URL, so it must match exactly.
            </p>
          </div>
        )}

        {needsMethod && (
          <div className="space-y-1">
            <label htmlFor="sig-method" className="font-bold uppercase tracking-wide text-xs">
              HTTP Method
            </label>
            <input
              id="sig-method"
              type="text"
              value={method}
              onChange={(e) => setMethod(e.target.value.toUpperCase())}
              placeholder="POST"
              className="neo-input w-full text-sm font-mono"
              disabled={verifying}
            />
          </div>
        )}

        {provider && getWebProviderInfo(provider)?.verificationMode === "unsupported" && (
          <p className="text-xs text-muted-foreground">
            SendGrid uses IP allowlisting, not signatures. Signature verification is not applicable.
          </p>
        )}

        {provider && getWebProviderInfo(provider)?.verificationMode !== "unsupported" && (
          <button
            onClick={handleVerify}
            disabled={verifying || !secret || (needsUrl && !url)}
            className="neo-btn-primary py-1.5! px-4! text-xs flex items-center gap-1.5"
          >
            {verifying ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify"
            )}
          </button>
        )}
      </div>

      {onOpenSettings && (
        <>
          <div className="border-t border-foreground/20" />
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Want automatic verification on every request?
            </p>
            <button onClick={onOpenSettings} className="neo-btn-outline py-1.5! px-3! text-xs">
              Save to Endpoint Settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-foreground/10 last:border-0">
      <td className="pr-4 py-1 text-muted-foreground font-semibold whitespace-nowrap align-top text-xs">
        {label}
      </td>
      <td className="py-1 break-all text-xs">{value}</td>
    </tr>
  );
}

function CopyableRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);
  const handleCopy = async () => {
    const success = await copyToClipboard(value);
    if (success) {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <tr className="border-b border-foreground/10 last:border-0">
      <td className="pr-4 py-1 text-muted-foreground font-semibold whitespace-nowrap align-top text-xs">
        {label}
      </td>
      <td className="py-1 break-all text-xs">
        <span className="font-mono">{value}</span>
        <button
          onClick={handleCopy}
          className="ml-2 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </td>
    </tr>
  );
}

/** Small inline badge for the request list and summary bar. */
export function SignatureVerificationBadge({
  signatureVerified,
  signatureError,
  signingProvider,
  className,
  onClick,
}: {
  signatureVerified?: boolean | null;
  signatureError?: string | null;
  signingProvider?: string | null;
  className?: string;
  onClick?: () => void;
}) {
  if (signatureVerified === null || signatureVerified === undefined) return null;

  const errorData = parseSignatureError(signatureError);
  const providerLabel = getWebProviderLabel(signingProvider);

  const isSkipped =
    !signatureVerified &&
    errorData?.code &&
    (errorData.code === "missing_header" || errorData.code === "unsupported");

  const title = signatureVerified
    ? `Signature verified${providerLabel ? ` (${providerLabel})` : ""}`
    : isSkipped
      ? `Verification skipped${errorData?.code ? `: ${errorData.code}` : ""}${providerLabel ? ` (${providerLabel})` : ""}`
      : `Signature invalid${errorData?.code ? `: ${errorData.code}` : ""}${providerLabel ? ` (${providerLabel})` : ""}`;
  const icon = signatureVerified ? (
    <ShieldCheck className="h-3.5 w-3.5 text-primary" />
  ) : isSkipped ? (
    <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
  ) : (
    <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cn("inline-flex items-center gap-0.5 cursor-pointer", className)}
        title={title}
        onClick={onClick}
        aria-label={title}
      >
        {icon}
      </button>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-0.5 cursor-default", className)}
      title={title}
    >
      {icon}
    </span>
  );
}
