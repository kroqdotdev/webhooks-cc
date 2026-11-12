"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trackToolUsed } from "@/lib/analytics";
import {
  HMAC_ALGORITHMS,
  SECRET_ENCODINGS,
  SIGNATURE_ENCODINGS,
  SIGNATURE_PRESETS,
  checkProviderSignature,
  computeHmac,
  explainComparison,
  explainProviderCheck,
  getSignaturePreset,
  headerLines,
  signProviderPayload,
  signaturesMatch,
  type HmacAlgorithm,
  type SecretEncoding,
  type SignatureEncoding,
  type SignatureVerdict,
} from "@/lib/tools/signature";
import { cn } from "@/lib/utils";
import { CodeSample, Field, NO_MEMORY, PRIVATE_INPUT, Verdict, fieldNote } from "./tool-parts";

const SLUG = "webhook-signature-checker";

/** The scheme that is no provider's: a plain HMAC in the algorithm and encoding chosen. */
const CUSTOM = "custom";

const PAYLOAD_SAMPLE = '{"id":"evt_123","type":"order.paid","amount":4200}';

interface Result {
  verdict: SignatureVerdict | null;
  /** A computed signature, or the headers a provider would send. */
  output: { label: string; code: string; note?: string } | null;
}

/**
 * Computes and checks webhook signatures in the browser (lib/tools/signature.ts).
 * It makes no request at all: the secret and the payload never leave the page.
 */
export function SignatureChecker() {
  const [scheme, setScheme] = useState<string>(CUSTOM);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [payload, setPayload] = useState(PAYLOAD_SAMPLE);

  const [algorithm, setAlgorithm] = useState<HmacAlgorithm>("SHA-256");
  const [encoding, setEncoding] = useState<SignatureEncoding>("hex");
  const [secretEncoding, setSecretEncoding] = useState<SecretEncoding>("utf8");
  const [expected, setExpected] = useState("");

  const [headers, setHeaders] = useState("");
  const [url, setUrl] = useState("");

  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const preset = scheme === CUSTOM ? null : getSignaturePreset(scheme);

  // A provider page links here with its scheme chosen: ?scheme=docusign. Read
  // from the address once, after hydration, so the page itself stays static.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("scheme");
    if (asked && getSignaturePreset(asked)) setScheme(asked);
  }, []);

  /** Anything typed makes the result on screen stale. */
  function changed() {
    setResult(null);
    setProblem(null);
  }

  async function run(action: "compute" | "check" | "sign") {
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      if (action === "compute") {
        const computed = await computeHmac({
          secret,
          secretEncoding,
          payload,
          algorithm,
          encoding,
        });
        if (!computed.ok) return setProblem(computed.problem);
        const compared = expected.trim()
          ? signaturesMatch(computed.signature, expected, encoding)
          : null;
        setResult({
          verdict: compared === null ? null : explainComparison(compared),
          output: {
            label: `HMAC-${algorithm.replace("-", "")} signature`,
            code: computed.signature,
          },
        });
        trackToolUsed(SLUG, action, compared === null ? "computed" : compared ? "match" : "differ");
        return;
      }
      if (!preset) return;
      if (action === "check") {
        const checked = await checkProviderSignature({
          preset,
          secret,
          payload,
          headersText: headers,
          url,
        });
        if (!checked.ok) return setProblem(checked.problem);
        setResult({ verdict: explainProviderCheck(preset, checked), output: null });
        trackToolUsed(SLUG, action, checked.valid ? "valid" : "invalid");
        return;
      }
      const signed = await signProviderPayload({ preset, secret, payload, url });
      if (!signed.ok) return setProblem(signed.problem);
      setResult({
        verdict: null,
        output: {
          label: `Headers ${preset.label} would send with this payload`,
          code: headerLines(signed.headers),
          note: "Where the scheme has a timestamp, it is the current time, so the value changes each time.",
        },
      });
      trackToolUsed(SLUG, action, "signed");
    } catch {
      // The SDK calls report their own problems; this is WebCrypto refusing a key or input.
      setProblem("Your browser could not compute this signature. Check the secret and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void run(preset ? "check" : "compute");
      }}
      className="ui-card ui-card-static space-y-5"
    >
      <Field
        id="signature-scheme"
        label="Scheme"
        hint={
          preset
            ? `${preset.label} signs with ${preset.algorithm} and sends the signature in the ${preset.header} header.`
            : "A plain HMAC of the payload. Pick a provider to check a request the way it signs."
        }
      >
        <Select
          value={scheme}
          onValueChange={(value: string) => {
            setScheme(value);
            changed();
          }}
        >
          <SelectTrigger id="signature-scheme" aria-describedby={fieldNote("signature-scheme")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CUSTOM}>Custom HMAC</SelectItem>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Providers</SelectLabel>
              {SIGNATURE_PRESETS.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <Field
        id="signature-secret"
        label="Secret"
        aside={
          <button
            type="button"
            onClick={() => setShowSecret((shown) => !shown)}
            aria-pressed={showSecret}
            className="cursor-pointer font-medium text-primary hover:underline"
          >
            {showSecret ? "Hide" : "Show"}
          </button>
        }
      >
        {/* Not type="password": a browser would offer to save it. Masked instead. */}
        <Input
          id="signature-secret"
          type="text"
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value);
            changed();
          }}
          placeholder={preset?.secretPlaceholder ?? "your webhook secret"}
          className={cn(
            PRIVATE_INPUT,
            "font-mono",
            !showSecret && secret && "[-webkit-text-security:disc]"
          )}
          {...NO_MEMORY}
        />
      </Field>

      <Field
        id="signature-payload"
        label="Payload"
        hint="The request body exactly as it was received. Every space and line break is signed."
      >
        <Textarea
          id="signature-payload"
          value={payload}
          onChange={(event) => {
            setPayload(event.target.value);
            changed();
          }}
          rows={6}
          aria-describedby={fieldNote("signature-payload")}
          className={`${PRIVATE_INPUT} font-mono`}
          {...NO_MEMORY}
        />
      </Field>

      {preset ? (
        <>
          {preset.needsUrl && (
            <Field
              id="signature-url"
              label="Webhook URL"
              hint={`${preset.label} signs the URL it sent the webhook to, query string included.`}
            >
              <Input
                id="signature-url"
                type="text"
                inputMode="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  changed();
                }}
                placeholder="https://example.com/webhooks"
                aria-describedby={fieldNote("signature-url")}
                className={`${PRIVATE_INPUT} font-mono`}
                {...NO_MEMORY}
              />
            </Field>
          )}
          <Field
            id="signature-headers"
            label="Request headers"
            hint="One per line as Name: value, or a JSON object. Only the signature headers are read; the rest are ignored."
          >
            <Textarea
              id="signature-headers"
              value={headers}
              onChange={(event) => {
                setHeaders(event.target.value);
                changed();
              }}
              rows={4}
              placeholder={`${preset.header}: ...`}
              aria-describedby={fieldNote("signature-headers")}
              className={`${PRIVATE_INPUT} font-mono`}
              {...NO_MEMORY}
            />
          </Field>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="signature-algorithm" label="Algorithm">
              <Select
                value={algorithm}
                onValueChange={(value: HmacAlgorithm) => {
                  setAlgorithm(value);
                  changed();
                }}
              >
                <SelectTrigger id="signature-algorithm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HMAC_ALGORITHMS.map((item) => (
                    <SelectItem key={item} value={item}>
                      HMAC-{item.replace("-", "")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="signature-encoding" label="Signature encoding">
              <Select
                value={encoding}
                onValueChange={(value: SignatureEncoding) => {
                  setEncoding(value);
                  changed();
                }}
              >
                <SelectTrigger id="signature-encoding">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIGNATURE_ENCODINGS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="signature-secret-encoding" label="Secret is written as">
              <Select
                value={secretEncoding}
                onValueChange={(value: SecretEncoding) => {
                  setSecretEncoding(value);
                  changed();
                }}
              >
                <SelectTrigger id="signature-secret-encoding">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECRET_ENCODINGS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            id="signature-expected"
            label="Signature to compare"
            aside="optional"
            hint="Paste the signature a request carried to see whether it matches. A label such as sha256= in front is fine."
          >
            <Input
              id="signature-expected"
              type="text"
              value={expected}
              onChange={(event) => {
                setExpected(event.target.value);
                changed();
              }}
              aria-describedby={fieldNote("signature-expected")}
              className={`${PRIVATE_INPUT} font-mono`}
              {...NO_MEMORY}
            />
          </Field>
        </>
      )}

      {problem && (
        <p role="alert" className={`${PRIVATE_INPUT} text-sm text-destructive-ink`}>
          {problem}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {preset ? (
          <>
            <Button type="submit" disabled={busy}>
              Check signature
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run("sign")}
            >
              Sign this payload
            </Button>
          </>
        ) : (
          <Button type="submit" disabled={busy}>
            {expected.trim() ? "Compute and compare" : "Compute signature"}
          </Button>
        )}
        <p className="text-sm text-muted-foreground">Computed in your browser. Nothing is sent.</p>
      </div>

      {result && (
        <div className={`${PRIVATE_INPUT} space-y-4 border-t border-border pt-5`}>
          {result.verdict && <Verdict explanation={result.verdict} />}
          {result.output && (
            <div className="space-y-1.5">
              <CodeSample
                label={result.output.label}
                code={result.output.code}
                testId="tool-output"
              />
              {result.output.note && (
                <p className="text-sm text-muted-foreground">{result.output.note}</p>
              )}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
