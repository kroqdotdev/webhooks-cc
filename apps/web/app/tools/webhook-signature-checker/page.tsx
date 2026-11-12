import { SignatureChecker } from "@/components/tools/signature-checker";
import {
  NextStep,
  ReferenceTable,
  TextLink,
  ToolPageFrame,
  ToolSection,
} from "@/components/tools/tool-page";
import type { FAQItem } from "@/lib/schemas";
import { createPageMetadata } from "@/lib/seo";
import { requireTool, toolPath } from "@/lib/tools/catalog";
import { SIGNATURE_PRESETS } from "@/lib/tools/signature";

const page = requireTool("webhook-signature-checker");

export const metadata = createPageMetadata({
  title: page.title,
  description: page.description,
  path: toolPath(page.slug),
  keywords: [
    "webhook signature checker",
    "webhook signature verification tool",
    "hmac calculator",
    "hmac sha256 online",
    "verify webhook signature",
    "stripe signature checker",
    "github webhook signature checker",
    "x-hub-signature-256 calculator",
  ],
});

const FAQ: FAQItem[] = [
  {
    question: "How do I check a webhook signature?",
    answer:
      "Pick the provider under Scheme, enter the signing secret, paste the request body exactly as it arrived and the request's headers, and press Check signature. The tool recomputes the signature the way that provider defines it and tells you whether it matches. For a provider that is not listed, choose Custom HMAC, set the algorithm and encoding its documentation names, and paste the signature to compare.",
  },
  {
    question: "Why does my webhook signature not match?",
    answer:
      "Almost always because the bytes that were signed are not the bytes being checked. A framework that parses JSON and writes it out again changes whitespace, key order or escaping, and the signature is over the original text: verify against the raw body. The other common causes are a secret from another endpoint or from test rather than live mode, the wrong encoding (hex where the provider sends Base64), and schemes that sign more than the body, such as a timestamp or the request URL.",
  },
  {
    question: "Is the signature hex or Base64?",
    answer:
      "It depends on the provider. GitHub sends hex after a sha256= label, Stripe sends hex inside a header that also carries a timestamp, and Shopify, DocuSign and Square send Base64. With a provider chosen the tool handles this for you; with Custom HMAC, pick the encoding the provider's documentation names. Hex and Base64 are two ways of writing the same bytes, so the wrong choice never matches.",
  },
  {
    question: "Is it safe to paste my signing secret here?",
    answer:
      "The signature is computed in your browser with the Web Crypto API. This page makes no network request with what you type: there is no webhooks.cc server behind the tool, nothing is stored, and its analytics never record the fields. Your browser's network tab stays empty when you press the button. For a production secret you may still prefer to rotate it afterwards, as with anything pasted into a web page.",
  },
  {
    question: "Why are some providers missing?",
    answer:
      "The presets are the schemes that are an HMAC carried in a header. Discord interactions and PayPal are signed with public keys instead, GitLab and Telegram send a shared token rather than a signature, Adyen and Mailgun put the signature inside the payload, and HubSpot's signature expires five minutes after the request was sent, so a captured request would always read as invalid here. webhooks.cc checks all of these on requests it captures.",
  },
  {
    question: "How do I make a test request with a valid signature?",
    answer:
      "Choose the provider, enter a secret and a payload, and press Sign this payload. The tool shows the signature headers that provider would send, which you can add to a curl request against your handler. To send whole signed sample events instead, webhooks.cc has templates for each provider in the dashboard, the SDK and the MCP server.",
  },
];

export default function WebhookSignatureCheckerPage() {
  return (
    <ToolPageFrame
      page={page}
      heading="Webhook signature checker"
      lead="Compute an HMAC over a payload, or check a request's signature the way its provider signs it. Everything is computed in your browser."
      tool={<SignatureChecker />}
      privacy="A signing secret is a credential. This tool makes no request with it: the signature is computed on this page, and nothing you type reaches webhooks.cc or is stored."
      faq={FAQ}
      faqHeading="Webhook signature questions"
      footer={
        <NextStep
          title="Check every delivery, not one by hand"
          links={[
            {
              href: "/docs/guides/verify-webhook-signatures",
              label: "Signature verification guide",
            },
            { href: "/docs/sdk/signatures", label: "Verify in code with the SDK" },
            { href: "/", label: "Get a free endpoint" },
          ]}
        >
          Add the signing secret to a webhooks.cc endpoint and every request it captures is marked
          valid or invalid as it arrives, with the headers and raw body beside it. The same checks
          are in the TypeScript, Python and Go SDKs for your handler and your tests.
        </NextStep>
      }
    >
      <ToolSection title="How webhook signatures work">
        <p>
          A provider and your server share a secret. When the provider sends a webhook, it computes
          an HMAC, a keyed hash, over the request body (some add a timestamp or a message id) and
          puts the result in a header. Your server computes the same HMAC over the body it received
          and compares the two. If they are equal, the request came from someone who holds the
          secret and the body was not changed on the way.
        </p>
        <p>
          The comparison is over <strong>exact bytes</strong>. One added space or a re-ordered key
          gives a different signature, which is why the check must run on the raw body, before any
          JSON parsing. Compare in constant time in your own code, and where the scheme signs a
          timestamp, refuse requests that are too old.
        </p>
      </ToolSection>

      <ToolSection title="Provider presets">
        <p>
          Each preset checks a request the way that provider signs it: what goes into the signed
          text, how the secret is decoded, and how the header is written. They are the same checks
          the webhooks.cc SDK and dashboard run. Sign this payload does the reverse and shows the
          headers the provider would send.
        </p>
        <ReferenceTable
          columns={["Provider", "Signature header", "Algorithm"]}
          codeColumn={1}
          rows={SIGNATURE_PRESETS.map((preset) => [
            <TextLink key={preset.id} href={`/webhooks/${preset.id}`}>
              {preset.label}
            </TextLink>,
            preset.header,
            preset.needsUrl ? `${preset.algorithm}, over the URL and the body` : preset.algorithm,
          ])}
        />
      </ToolSection>

      <ToolSection title="Custom HMAC">
        <p>
          For a provider without a preset, Custom HMAC computes a plain HMAC of the payload with
          SHA-256, SHA-1, SHA-384 or SHA-512 and writes it as hex, Base64 or Base64url. Most secrets
          are text; choose Hex or Base64 under Secret is written as when the provider hands the key
          out in that form and its documentation says to decode it first.
        </p>
        <p>
          Paste a signature under Signature to compare and the tool says whether it is the one
          computed. A label in front of the value, such as <code>sha256=</code>, is ignored, and hex
          is compared without regard to case.
        </p>
      </ToolSection>
    </ToolPageFrame>
  );
}
