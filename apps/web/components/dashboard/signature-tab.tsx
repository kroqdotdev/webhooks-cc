"use client";

import { useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert, Shield, Copy, Check, Loader2 } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import type { DisplayableRequest } from "./request-detail";

/** Provider metadata for display and auto-detection. */
const PROVIDERS: Record<
  string,
  { label: string; algorithm: string; header: string; secretPlaceholder: string }
> = {
  stripe: {
    label: "Stripe",
    algorithm: "HMAC-SHA256",
    header: "stripe-signature",
    secretPlaceholder: "whsec_...",
  },
  github: {
    label: "GitHub",
    algorithm: "HMAC-SHA256",
    header: "x-hub-signature-256",
    secretPlaceholder: "your webhook secret",
  },
  shopify: {
    label: "Shopify",
    algorithm: "HMAC-SHA256",
    header: "x-shopify-hmac-sha256",
    secretPlaceholder: "your Shopify secret",
  },
  twilio: {
    label: "Twilio",
    algorithm: "HMAC-SHA1",
    header: "x-twilio-signature",
    secretPlaceholder: "your auth token",
  },
  slack: {
    label: "Slack",
    algorithm: "HMAC-SHA256",
    header: "x-slack-signature",
    secretPlaceholder: "your signing secret",
  },
  paddle: {
    label: "Paddle",
    algorithm: "HMAC-SHA256",
    header: "paddle-signature",
    secretPlaceholder: "your webhook secret",
  },
  linear: {
    label: "Linear",
    algorithm: "HMAC-SHA256",
    header: "linear-signature",
    secretPlaceholder: "your webhook secret",
  },
  vercel: {
    label: "Vercel",
    algorithm: "HMAC-SHA1",
    header: "x-vercel-signature",
    secretPlaceholder: "your webhook secret",
  },
  gitlab: {
    label: "GitLab",
    algorithm: "Token",
    header: "x-gitlab-token",
    secretPlaceholder: "your secret token",
  },
  clerk: {
    label: "Clerk",
    algorithm: "HMAC-SHA256",
    header: "svix-id",
    secretPlaceholder: "whsec_...",
  },
  discord: {
    label: "Discord",
    algorithm: "Ed25519",
    header: "x-signature-ed25519",
    secretPlaceholder: "your application public key",
  },
  "standard-webhooks": {
    label: "Standard Webhooks",
    algorithm: "HMAC-SHA256",
    header: "webhook-signature",
    secretPlaceholder: "whsec_...",
  },
  "generic-hmac": {
    label: "Generic HMAC",
    algorithm: "HMAC-SHA256",
    header: "",
    secretPlaceholder: "your shared secret",
  },
};

/** Auto-detect provider from request headers. */
function detectProvider(headers: Record<string, string>): string | null {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  if (lowerHeaders["stripe-signature"]) return "stripe";
  if (lowerHeaders["x-hub-signature-256"]) return "github";
  if (lowerHeaders["x-shopify-hmac-sha256"]) return "shopify";
  if (lowerHeaders["x-twilio-signature"]) return "twilio";
  if (lowerHeaders["x-slack-signature"]) return "slack";
  if (lowerHeaders["paddle-signature"]) return "paddle";
  if (lowerHeaders["linear-signature"]) return "linear";
  if (lowerHeaders["x-vercel-signature"]) return "vercel";
  if (lowerHeaders["x-gitlab-token"]) return "gitlab";
  if (lowerHeaders["svix-id"]) return "clerk";
  if (lowerHeaders["x-signature-ed25519"]) return "discord";
  if (lowerHeaders["webhook-id"] && lowerHeaders["webhook-signature"]) return "standard-webhooks";
  return null;
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
}

export function SignatureTab({ request, onOpenSettings }: SignatureTabProps) {
  const req = request as DisplayableRequest & {
    signatureVerified?: boolean | null;
    signatureError?: string | null;
    signingProvider?: string | null;
  };
  const signatureVerified = req.signatureVerified;
  const signatureError = req.signatureError;
  const signingProvider = req.signingProvider;

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
  return <ClientSideVerification request={request} onOpenSettings={onOpenSettings} />;
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
  const providerInfo = provider ? PROVIDERS[provider] : null;
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
}: {
  request: DisplayableRequest;
  onOpenSettings?: () => void;
}) {
  const detectedProvider = useMemo(() => detectProvider(request.headers), [request.headers]);
  const [provider, setProvider] = useState<string>(detectedProvider ?? "");
  const [secret, setSecret] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; error: string | null } | null>(null);

  const providerInfo = provider ? PROVIDERS[provider] : null;

  const handleVerify = useCallback(async () => {
    if (!provider || !secret) return;
    setVerifying(true);
    setResult(null);

    try {
      const { verifySignature } = await import("@webhooks-cc/sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: any =
        provider === "discord" ? { provider: "discord", publicKey: secret } : { provider, secret };
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
      setResult({
        verified: false,
        error: JSON.stringify({
          code: "mismatch",
          message: err instanceof Error ? err.message : "Verification failed",
        }),
      });
    } finally {
      setVerifying(false);
    }
  }, [provider, secret, request.body, request.headers, providerInfo?.header]);

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

      {detectedProvider && PROVIDERS[detectedProvider] && (
        <div className="text-xs text-muted-foreground">
          <span className="font-bold uppercase tracking-wide">Detected: </span>
          {PROVIDERS[detectedProvider].label}{" "}
          <span className="font-mono">(via {PROVIDERS[detectedProvider].header})</span>
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
            {Object.entries(PROVIDERS).map(([key, info]) => (
              <option key={key} value={key}>
                {info.label}
              </option>
            ))}
          </select>
        </div>

        {provider && provider !== "sendgrid" && (
          <div className="space-y-1">
            <label htmlFor="sig-secret" className="font-bold uppercase tracking-wide text-xs">
              {provider === "discord" ? "Public Key" : "Secret"}
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

        {provider === "sendgrid" && (
          <p className="text-xs text-muted-foreground">
            SendGrid uses IP allowlisting, not signatures. Signature verification is not applicable.
          </p>
        )}

        {provider && provider !== "sendgrid" && (
          <button
            onClick={handleVerify}
            disabled={verifying || !secret}
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
  const handleCopy = async () => {
    const success = await copyToClipboard(value);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
  const providerLabel = signingProvider && PROVIDERS[signingProvider]?.label;

  if (signatureVerified) {
    return (
      <span
        className={cn("inline-flex items-center gap-0.5 cursor-default", className)}
        title={`Signature verified${providerLabel ? ` (${providerLabel})` : ""}`}
        onClick={onClick}
        role={onClick ? "button" : undefined}
      >
        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex items-center gap-0.5 cursor-default", className)}
      title={`Signature invalid${errorData?.code ? `: ${errorData.code}` : ""}${providerLabel ? ` (${providerLabel})` : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
    </span>
  );
}
