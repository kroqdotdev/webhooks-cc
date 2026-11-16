/**
 * Conformance vectors for the SDKs in other languages.
 *
 * This file builds the JSON files in packages/sdk/conformance/ from this
 * SDK, checks that this SDK gives the expected answer for every case, and
 * fails when a file on disk differs from what it builds. The other SDKs run
 * the same files in their own suites, so a port either behaves like this SDK
 * or its CI fails. After a deliberate change, regenerate the files with
 * `pnpm --filter @webhooks-cc/sdk exec vitest run conformance -u` and port the
 * change to every SDK. See conformance/README.md for the format.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";
import { WebhookVerificationError, WebhooksCCError } from "../errors";
import {
  isEmailRequest,
  matchAll,
  matchAny,
  matchBodyPath,
  matchBodySubset,
  matchContentType,
  matchEmail,
  matchHeader,
  matchMethod,
  matchPath,
  matchQueryParam,
  matchUnverified,
  matchVerified,
} from "../matchers";
import { buildTemplateSendOptions, TEMPLATE_PROVIDERS, VERIFY_PROVIDERS } from "../templates";
import type { EmailCriteria, Request, TemplateProvider, VerifySignatureOptions } from "../types";
import { parseDuration } from "../utils";
import {
  verifyForwardedEmail,
  verifyForwardedJson,
  verifyForwardedRequest,
  verifyRelayedRequest,
  verifySignature,
} from "../verify";

const FORMAT_VERSION = 1;
/** forwarding.json is at 3: version 2 added expected.invalidSecret, version 3 verifyForwardedJson. */
const FORWARDING_FORMAT_VERSION = 3;
const GENERATED_BY = "packages/sdk/src/__tests__/conformance.test.ts";

/** 2026-01-01T00:00:00Z, in seconds. */
const TIMESTAMP = 1767225600;
/** One minute after TIMESTAMP, in milliseconds: "now" for verification. */
const NOW = (TIMESTAMP + 60) * 1000;
const URL_SIGNED = "https://example.com/webhooks/acme?source=conformance";
const JSON_BODY =
  '{"id":"evt_conformance_1","type":"order.paid","data":{"amount":2000,"currency":"eur","note":"café ✓"}}';

function file(description: string, vectors: unknown[], version = FORMAT_VERSION): string {
  return `${JSON.stringify(
    { version, generatedBy: GENERATED_BY, description, vectors },
    null,
    2
  )}\n`;
}

function pick(headers: Record<string, string>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (value === undefined) throw new Error(`expected a ${name} header`);
    out[name] = value;
  }
  return out;
}

function hmacBase64(key: Buffer, message: Buffer | string): string {
  return createHmac("sha256", key).update(message).digest("base64");
}

function whsecKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

type SignedProvider = Exclude<TemplateProvider, "sendgrid" | "discord" | "plaid" | "paypal">;

/**
 * The headers that carry each provider's signature, and the timestamp or id
 * it covers. Mailgun and Adyen sign inside the body. A port may send more
 * headers (content type, user agent, event names); these are the ones a
 * receiver checks.
 */
const SIGNATURE_HEADERS: Record<SignedProvider, readonly string[]> = {
  stripe: ["stripe-signature"],
  github: ["x-hub-signature-256"],
  shopify: ["x-shopify-hmac-sha256"],
  twilio: ["x-twilio-signature"],
  slack: ["x-slack-request-timestamp", "x-slack-signature"],
  paddle: ["paddle-signature"],
  linear: ["linear-signature"],
  clerk: [
    "webhook-id",
    "webhook-timestamp",
    "webhook-signature",
    "svix-id",
    "svix-timestamp",
    "svix-signature",
  ],
  vercel: ["x-vercel-signature"],
  gitlab: ["x-gitlab-token"],
  typeform: ["typeform-signature"],
  "standard-webhooks": ["webhook-id", "webhook-timestamp", "webhook-signature"],
  meta: ["x-hub-signature-256"],
  lemonsqueezy: ["x-signature"],
  "coinbase-commerce": ["x-cc-webhook-signature"],
  razorpay: ["x-razorpay-signature"],
  cal: ["x-cal-signature-256"],
  intercom: ["x-hub-signature"],
  telegram: ["x-telegram-bot-api-secret-token"],
  square: ["x-square-hmacsha256-signature"],
  hubspot: ["x-hubspot-request-timestamp", "x-hubspot-signature-v3"],
  mailgun: [],
  calendly: ["calendly-webhook-signature"],
  mux: ["mux-signature"],
  sentry: ["sentry-hook-signature"],
  bitbucket: ["x-hub-signature"],
  docusign: ["x-docusign-signature-1", "x-authorization-digest"],
  adyen: [],
  resend: ["svix-id", "svix-timestamp", "svix-signature"],
  workos: ["workos-signature"],
};

/** Providers sendTo() does not sign, and why. They have no signing vectors. */
const NOT_SIGNED: Record<Exclude<TemplateProvider, SignedProvider>, string> = {
  sendgrid: "SendGrid does not sign its event webhooks.",
  discord: "Discord signs with the application's Ed25519 private key, which a test does not hold.",
  plaid: "Plaid signs a JWT with its own key; templates carry a placeholder.",
  paypal: "PayPal signs with its RSA private key; templates carry a placeholder.",
};

/** Providers that sign a message id; the vector gives it as `messageId`. */
const SIGNS_MESSAGE_ID = new Set<TemplateProvider>(["standard-webhooks", "clerk", "resend"]);

const SECRETS: Partial<Record<SignedProvider, string>> = {
  clerk: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  "standard-webhooks": "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  resend: "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD",
  // Adyen's HMAC key is hex.
  adyen: "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056",
};

const TWILIO_BODY =
  "CallSid=CA1234567890ABCDE&From=%2B14155550123&To=%2B14155559876&Body=Caf%C3%A9+%E2%9C%93";
const MAILGUN_BODY =
  '{"signature":{"timestamp":"1767225600","token":"a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0","signature":"to-be-signed"},"event-data":{"event":"delivered","id":"CPgfbmQMTCKtHW6uIWtuVe","recipient":"alice@example.com"}}';
const ADYEN_BODY =
  '{"live":"false","notificationItems":[{"NotificationRequestItem":{"amount":{"currency":"EUR","value":2000},"eventCode":"AUTHORISATION","eventDate":"2026-01-01T00:00:00+01:00","merchantAccountCode":"AcmeECOM","merchantReference":"order-1001","pspReference":"7914073381342284","success":"true"}}]}';

function defaultBody(provider: SignedProvider): string {
  if (provider === "twilio") return TWILIO_BODY;
  if (provider === "mailgun") return MAILGUN_BODY;
  if (provider === "adyen") return ADYEN_BODY;
  return JSON_BODY;
}

interface SigningCase {
  name: string;
  provider: SignedProvider;
  secret: string;
  method: string;
  url: string;
  body: string;
  timestamp: number;
  messageId?: string;
  /** Where a published vector comes from. */
  source?: string;
  /** Published headers this SDK must reproduce. */
  published?: Record<string, string>;
}

function signingCase(provider: SignedProvider, overrides: Partial<SigningCase> = {}): SigningCase {
  return {
    name: provider,
    provider,
    secret: SECRETS[provider] ?? `conformance_${provider.replace(/-/g, "_")}_secret`,
    method: "POST",
    url: URL_SIGNED,
    body: defaultBody(provider),
    timestamp: TIMESTAMP,
    ...(SIGNS_MESSAGE_ID.has(provider) ? { messageId: "msg_2LJJbVBoPJyDAfGDSaxj6XQkPNy" } : {}),
    ...overrides,
  };
}

const SIGNING_CASES: SigningCase[] = [
  ...(Object.keys(SIGNATURE_HEADERS) as SignedProvider[]).map((provider) => signingCase(provider)),
  signingCase("stripe", { name: "stripe, empty body", body: "" }),
  signingCase("twilio", {
    name: "twilio, repeated parameters sort by name, then value",
    body: "To=%2B14155559876&MediaUrl0=b&MediaUrl0=a&AccountSid=AC123",
  }),
  signingCase("hubspot", {
    name: "hubspot, reserved characters in the URL are decoded before signing",
    url: "https://example.com/webhooks/hub%3Aspot?next=https%3A%2F%2Fexample.com%2Fdone%40home&q=%7Bx%7D",
  }),
  signingCase("hubspot", { name: "hubspot, the method is signed", method: "PUT" }),
  signingCase("hubspot", {
    name: "hubspot, all twelve uppercase escapes are decoded and lowercase ones are not",
    url: "https://example.com/hooks/%3A%2F%3F%40%21%24%27%28%29%2A%2C%3B?next=%3a%2f%20",
  }),
  signingCase("mailgun", {
    name: "mailgun, the timestamp and token in the body are signed, not the timestamp option",
    timestamp: TIMESTAMP + 3600,
  }),
  signingCase("standard-webhooks", {
    name: "standard-webhooks, base64 secret without padding",
    secret: "whsec_dGVzdC1zZWNyZXQ",
  }),
  signingCase("standard-webhooks", {
    name: "standard-webhooks, a secret without the whsec_ prefix is still base64",
    secret: "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  }),
  signingCase("standard-webhooks", {
    name: "standard-webhooks, a secret that is not base64 signs with its UTF-8 bytes, prefix included",
    secret: "whsec_polar-raw_secret!",
  }),
  signingCase("github", {
    name: "github, GitHub's documented example",
    secret: "It's a Secret to Everybody",
    body: "Hello, World!",
    source:
      "https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation",
    published: {
      "x-hub-signature-256":
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    },
  }),
  signingCase("standard-webhooks", {
    name: "standard-webhooks, Svix's documented example",
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    messageId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: 1614265330,
    body: '{"test": 2432232314}',
    source: "https://docs.svix.com/receiving/verifying-payloads/how-manual",
    published: {
      "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "webhook-timestamp": "1614265330",
      "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    },
  }),
  signingCase("resend", {
    name: "resend, the svix-webhooks library's example",
    secret: "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD",
    messageId: "msg_27UH4WbU6Z5A5EzD8u03UvzRbpk",
    timestamp: 1649367553,
    body: '{"email":"test@example.com","username":"test_user"}',
    source: "https://github.com/svix/svix-webhooks",
    published: {
      "svix-id": "msg_27UH4WbU6Z5A5EzD8u03UvzRbpk",
      "svix-timestamp": "1649367553",
      "svix-signature": "v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw=",
    },
  }),
];

interface SigningVector extends Omit<SigningCase, "published"> {
  expected: { headers: Record<string, string>; body: string };
}

async function buildSigningVectors(): Promise<SigningVector[]> {
  const vectors: SigningVector[] = [];
  for (const { published, ...input } of SIGNING_CASES) {
    const built = await buildTemplateSendOptions(input.url, {
      provider: input.provider,
      secret: input.secret,
      method: input.method,
      body: input.body,
      timestamp: input.timestamp,
      messageId: input.messageId,
    });
    const headers = pick(built.headers ?? {}, SIGNATURE_HEADERS[input.provider]);
    if (published) expect(headers, input.name).toEqual(published);
    vectors.push({ ...input, expected: { headers, body: built.body as string } });
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface VerifyVector {
  name: string;
  provider: TemplateProvider;
  /** The shared secret; for PayPal, the webhook id. Absent for Discord. */
  secret?: string;
  /** Discord: the application's Ed25519 public key, hex. */
  publicKey?: string;
  /** PayPal: what the certificate URL serves. */
  certificate?: string;
  url: string;
  method: string;
  /** The current time, in milliseconds. */
  now: number;
  body: string;
  headers: Record<string, string>;
  expected: boolean;
}

/** Providers whose signature does not cover the whole raw body. */
const BODY_NOT_COVERED: Record<string, string> = {
  gitlab: "The token is the secret itself.",
  telegram: "The token is the secret itself.",
  mailgun: "The signature covers the timestamp and token in the body, not the event.",
  adyen: "The signature covers fixed fields of each notification item.",
};

function withoutHeaders(
  headers: Record<string, string>,
  names: readonly string[]
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));
}

const DISCORD = {
  publicKey: "ad4547997dd68ce739d1fd35c45d131f0d58f58c13229bf04800cafd3f366aa0",
  otherPublicKey: "08403ef43393fdd926f4b5a9dbd00cb3e4b4312a4d99103531bc3efded10ad40",
  timestamp: "1767225600",
  body: '{"type":1,"id":"1294763522360823808","application_id":"1294763418115096576","version":1}',
  signature:
    "84792cb8f855aeb33db536f5f707774f932fc5fd88825a399ae6f433f0da40637e1c173fa20a1f43e6a27479104bb6184b274d37aef45fffdada4c840c76d00b",
};

/**
 * A self-signed test certificate, valid 2025 to 2125; its private key signed
 * `signature` once and was thrown away.
 */
const PAYPAL = {
  webhookId: "1JE4291016473214C",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-conformance",
  transmissionId: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  transmissionTime: "2026-01-01T00:00:00Z",
  body: '{"id":"WH-58D329510W468432D-8HN650336L201105X","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"currency_code":"EUR","value":"20.00"},"note":"café ✓"}}',
  signature:
    "SYEldQX06SEqfGQQQLV+6MZjUtAEEfvbAc5xyDIMrgi/7nrJkZt/M0IW8vroXclfXGvag6odo64mnwE2QQtq+trWsdtNONN/bNr/6s4YVKLzQz6vsmJ3U8BHtA0/ux/Fno4rFwX0kKMW3xCXj9+nGotTOru3QPDYAEl+lw3rHCecSh6KHa08Q9z7NLEodrSkU9foDuYolqeocRXF7KXKYhnmcc6BiM22LXW396OA7WquGqP1hFcuQ8b/jJC1cMQuejIYn1wAgId5akmoLzcYDa9WhtoODuYpNletuiCZtrlRtGeCA9/eM3rBWpx1YbxY2ta0cUMT10hi7ud1uT4mew==",
  certificate: `-----BEGIN CERTIFICATE-----
MIIC9DCCAdygAwIBAgIUBg8VlgFh4jj4NbjGUMAEtJYo8rkwDQYJKoZIhvcNAQEL
BQAwMzExMC8GA1UEAwwod2ViaG9va3MuY2MgY29uZm9ybWFuY2UgdGVzdCBjZXJ0
aWZpY2F0ZTAgFw0yNTAxMDEwMDAwMDBaGA8yMTI1MDEwMTAwMDAwMFowMzExMC8G
A1UEAwwod2ViaG9va3MuY2MgY29uZm9ybWFuY2UgdGVzdCBjZXJ0aWZpY2F0ZTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALKq/nA++XEt4wrHaIWe+uAy
FvRzn1IxYmQI0AdEdirN/IhkTzQrPhKOnXbuao1wGp89JR/Q9Tc3Vi9sgp9XaLZd
U1BBmFC14pTDDuswC8H1Vl06/onIfPCTW3OH22OBdHdWAkA/F39R3XAJQTNEV/zd
OFi+Xh4UQqbmpYnf3oDv/megSJJF2eHTd+mXq3+ecuCvnx/FojGN6JD0BGPXTTKV
GZIWVAi/UYHNETxM2t4SKpPcay46lxPu7TwlQ1ItLBU2XFkFzh2YCY0ezb8J8VVV
KgW9eaUK8tUmkCnfybGyVJMWn3pA0B8yirPEiF/T2xGjj0RkXIzboeoOoTPLavEC
AwEAATANBgkqhkiG9w0BAQsFAAOCAQEAeRHkjRgxd57Ux+9Yl/CoEhZHD5IconZb
8OPD4zn/pyhgOSyoezxyDx8YcK+k+pZBx5Y2piLwXQOpdmL4YyD9qVhYXER+LSSw
bRwmPPpDCczNkOeozS3OjavLLuJpa/ICkOHjazlDUYqTc5McdbCtRQkSI1mI3pI+
MZSE/E4LIiYYUqY/mg5hAgSOwWoPNv7svFpxMFE2zORhMzqYYZwONam0RARFfMts
obxhHbKleok2xkAZhNfdL9C2M/oJXQmRd5EIRL7JxV2vQNxt2Ke/qWxM6Q4/LBNV
NKtDhXWxkSyf1aKNpLH/LgGfQDjMGHrJPeu1WGlPY90FxH7La3Hklg==
-----END CERTIFICATE-----
`,
};

function paypalHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "paypal-transmission-id": PAYPAL.transmissionId,
    "paypal-transmission-time": PAYPAL.transmissionTime,
    "paypal-cert-url": PAYPAL.certUrl,
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": PAYPAL.signature,
    ...overrides,
  };
}

function buildVerifyCases(signing: SigningVector[]): VerifyVector[] {
  const cases: VerifyVector[] = [];
  const add = (vector: VerifyVector) => cases.push(vector);
  const fromSigning = (
    vector: SigningVector,
    name: string,
    changes: Partial<VerifyVector> & { expected: boolean }
  ) =>
    add({
      name,
      provider: vector.provider,
      secret: vector.secret,
      url: vector.url,
      method: vector.method,
      now: (vector.timestamp + 60) * 1000,
      body: vector.expected.body,
      headers: vector.expected.headers,
      ...changes,
    });

  for (const vector of signing) {
    const provider = vector.provider;
    const isDefault = vector.name === provider;
    fromSigning(vector, vector.name, { expected: true });
    if (!isDefault) continue;

    fromSigning(vector, `${provider}, wrong secret`, {
      secret: provider === "adyen" ? "00".repeat(32) : `${vector.secret}-wrong`,
      expected: false,
    });

    if (provider === "mailgun") {
      const parsed = JSON.parse(vector.expected.body);
      fromSigning(vector, "mailgun, changed token", {
        body: JSON.stringify({
          ...parsed,
          signature: { ...parsed.signature, token: "0".repeat(50) },
        }),
        expected: false,
      });
      fromSigning(vector, "mailgun, changed event data still verifies", {
        body: JSON.stringify({ ...parsed, "event-data": { event: "failed" } }),
        expected: true,
      });
      const unsigned = { ...parsed };
      delete unsigned.signature;
      fromSigning(vector, "mailgun, no signature", {
        body: JSON.stringify(unsigned),
        expected: false,
      });
    } else if (provider === "adyen") {
      const signedItem = () => JSON.parse(vector.expected.body);
      const amount = signedItem();
      amount.notificationItems[0].NotificationRequestItem.amount.value = 1;
      fromSigning(vector, "adyen, changed amount", {
        body: JSON.stringify(amount),
        expected: false,
      });
      const eventDate = signedItem();
      eventDate.notificationItems[0].NotificationRequestItem.eventDate =
        "2027-01-01T00:00:00+01:00";
      fromSigning(vector, "adyen, changed field outside the signature still verifies", {
        body: JSON.stringify(eventDate),
        expected: true,
      });
      const unsigned = signedItem();
      delete unsigned.notificationItems[0].NotificationRequestItem.additionalData;
      fromSigning(vector, "adyen, no signature", {
        body: JSON.stringify(unsigned),
        expected: false,
      });
      const batch = signedItem();
      batch.notificationItems.push(JSON.parse(ADYEN_BODY).notificationItems[0]);
      fromSigning(vector, "adyen, one unsigned item in a batch", {
        body: JSON.stringify(batch),
        expected: false,
      });
    } else {
      fromSigning(vector, `${provider}, changed body`, {
        body: `${vector.expected.body} `,
        expected: provider in BODY_NOT_COVERED,
      });
      fromSigning(vector, `${provider}, no signature headers`, {
        headers: withoutHeaders(vector.expected.headers, SIGNATURE_HEADERS[provider]),
        expected: false,
      });
    }
  }

  const byName = (name: string) => {
    const found = signing.find((vector) => vector.name === name);
    if (!found) throw new Error(`no signing vector named ${name}`);
    return found;
  };

  const stripe = byName("stripe");
  const stripeHeader = stripe.expected.headers["stripe-signature"];
  const stripeSig = stripeHeader.split("v1=")[1];
  fromSigning(stripe, "stripe, any v1 signature in the header may match", {
    headers: { "stripe-signature": `t=${TIMESTAMP},v1=${"0".repeat(64)},v1=${stripeSig}` },
    expected: true,
  });
  fromSigning(stripe, "stripe, a v0 signature is not checked", {
    headers: { "stripe-signature": `t=${TIMESTAMP},v0=${stripeSig}` },
    expected: false,
  });
  fromSigning(stripe, "stripe, no age limit: a day-old signature verifies", {
    now: (TIMESTAMP + 86_400) * 1000,
    expected: true,
  });

  const github = byName("github");
  fromSigning(github, "github, header names match in any case", {
    headers: { "X-Hub-Signature-256": github.expected.headers["x-hub-signature-256"] },
    expected: true,
  });

  const standard = byName("standard-webhooks");
  fromSigning(standard, "standard-webhooks, any signature in a space-separated list may match", {
    headers: {
      ...standard.expected.headers,
      "webhook-signature": `v1,b2xkLXNlY3JldC1zaWduYXR1cmU= ${standard.expected.headers["webhook-signature"]}`,
    },
    expected: true,
  });

  const clerk = byName("clerk");
  fromSigning(clerk, "clerk, only the svix-* headers, as Clerk sends them", {
    headers: withoutHeaders(clerk.expected.headers, [
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]),
    expected: true,
  });
  fromSigning(clerk, "clerk, only the webhook-* headers", {
    headers: withoutHeaders(clerk.expected.headers, [
      "svix-id",
      "svix-timestamp",
      "svix-signature",
    ]),
    expected: true,
  });

  const linear = byName("linear");
  fromSigning(linear, "linear, bare hex without sha256=, as Linear sends it", {
    headers: { "linear-signature": linear.expected.headers["linear-signature"].slice(7) },
    expected: true,
  });

  const twilio = byName("twilio");
  fromSigning(twilio, "twilio, a different URL", {
    url: "https://example.com/webhooks/acme",
    expected: false,
  });

  const hubspot = byName("hubspot");
  fromSigning(hubspot, "hubspot, a signature older than five minutes", {
    now: (TIMESTAMP + 301) * 1000,
    expected: false,
  });
  fromSigning(hubspot, "hubspot, a different method", { method: "PUT", expected: false });

  const discord = {
    provider: "discord" as const,
    publicKey: DISCORD.publicKey,
    url: URL_SIGNED,
    method: "POST",
    now: NOW,
    body: DISCORD.body,
    headers: {
      "x-signature-ed25519": DISCORD.signature,
      "x-signature-timestamp": DISCORD.timestamp,
    },
  };
  add({ name: "discord", ...discord, expected: true });
  add({ name: "discord, changed body", ...discord, body: `${DISCORD.body} `, expected: false });
  add({
    name: "discord, another application's public key",
    ...discord,
    publicKey: DISCORD.otherPublicKey,
    expected: false,
  });
  add({
    name: "discord, changed timestamp",
    ...discord,
    headers: { ...discord.headers, "x-signature-timestamp": String(TIMESTAMP + 1) },
    expected: false,
  });

  const paypal = {
    provider: "paypal" as const,
    secret: PAYPAL.webhookId,
    certificate: PAYPAL.certificate,
    url: URL_SIGNED,
    method: "POST",
    now: NOW,
    body: PAYPAL.body,
  };
  add({ name: "paypal", ...paypal, headers: paypalHeaders(), expected: true });
  add({
    name: "paypal, changed body",
    ...paypal,
    body: `${PAYPAL.body} `,
    headers: paypalHeaders(),
    expected: false,
  });
  add({
    name: "paypal, another webhook id",
    ...paypal,
    secret: "8PT597110X687430LKGECATA",
    headers: paypalHeaders(),
    expected: false,
  });
  add({
    name: "paypal, a certificate URL outside PayPal is refused",
    ...paypal,
    headers: paypalHeaders({
      "paypal-cert-url": "https://example.com/v1/notifications/certs/CERT-360caa42-conformance",
    }),
    expected: false,
  });
  add({
    name: "paypal, a PayPal host outside /v1/notifications/certs/ is refused",
    ...paypal,
    headers: paypalHeaders({
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/other/CERT-360caa42-conformance",
    }),
    expected: false,
  });
  add({
    name: "paypal, an algorithm other than SHA256withRSA is refused",
    ...paypal,
    headers: paypalHeaders({ "paypal-auth-algo": "SHA1withRSA" }),
    expected: false,
  });

  return cases;
}

async function runVerify(vector: VerifyVector): Promise<boolean> {
  vi.spyOn(Date, "now").mockReturnValue(vector.now);
  const options = (
    vector.provider === "discord"
      ? { provider: "discord", publicKey: vector.publicKey }
      : {
          provider: vector.provider,
          secret: vector.secret,
          url: vector.url,
          method: vector.method,
          ...(vector.certificate
            ? { fetchCertificate: async () => vector.certificate as string }
            : {}),
        }
  ) as VerifySignatureOptions;
  const { valid } = await verifySignature({ body: vector.body, headers: vector.headers }, options);
  return valid;
}

// ---------------------------------------------------------------------------
// Forwarding (webhooks.cc's own signatures)
// ---------------------------------------------------------------------------

type ForwardFunction =
  | "verifyForwardedEmail"
  | "verifyForwardedRequest"
  | "verifyForwardedJson"
  | "verifyRelayedRequest";

interface ForwardingVector {
  name: string;
  function: ForwardFunction;
  secret: string;
  /** The current time, in milliseconds. */
  now: number;
  /** The body as text, or as base64 when it is not UTF-8. */
  body?: string;
  bodyBase64?: string;
  headers: Record<string, string>;
  expected: { ok: true } | { error: string } | { invalidSecret: true };
}

const FORWARD_SECRET = "whsec_c2VjcmV0LWZvci1jb25mb3JtYW5jZS10ZXN0cw==";
const EMAIL_EVENT = JSON.stringify({
  type: "email.received",
  timestamp: "2026-01-01T00:00:00.000Z",
  data: {
    id: "3f6c2a1e-8b7d-4c9e-a2f1-0d5b6e7c8a90",
    endpoint: { slug: "acme-signup", name: null },
    receivedAt: "2026-01-01T00:00:00.000Z",
    address: "acme-signup+run-42@mailhooks.cc",
    tag: "run-42",
    subject: "Confirm your email",
    text: "Your code is 482913",
    headers: { "message-id": "<1@example.com>" },
  },
});
const REQUEST_EVENT = JSON.stringify({
  type: "request.received",
  timestamp: "2026-01-01T00:00:00.000Z",
  data: {
    id: "7b1d9e4a-2c3f-4a5b-9c8d-1e2f3a4b5c6d",
    method: "POST",
    path: "/webhooks/stripe",
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  },
});

/** A destination's own JSON: whatever its template made, types kept. */
const TEMPLATE_BODY = JSON.stringify({
  invoice: "in_1Q",
  amount: 4200,
  paid: true,
  customer: null,
});

/** What anyone can sign with: a secret that decodes to no key at all. */
const EMPTY_KEY = Buffer.alloc(0);

function standardHeaders(
  body: string,
  timestamp = TIMESTAMP,
  key = whsecKey(FORWARD_SECRET)
): Record<string, string> {
  const id = "msg_3f6c2a1e8b7d4c9ea2f10d5b6e7c8a90";
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${hmacBase64(key, `${id}.${timestamp}.${body}`)}`,
  };
}

function relayedHeaders(body: Buffer, key = whsecKey(FORWARD_SECRET)): Record<string, string> {
  const requestId = "7b1d9e4a-2c3f-4a5b-9c8d-1e2f3a4b5c6d";
  const receivedAt = "1767225600123";
  return {
    "webhooks-cc-request-id": requestId,
    "webhooks-cc-received-at": receivedAt,
    "webhooks-cc-endpoint": "acme-signup",
    "webhooks-cc-attempt": "1",
    "webhooks-cc-signature": `v1,${hmacBase64(
      key,
      Buffer.concat([Buffer.from(`${requestId}.${receivedAt}.`), body])
    )}`,
  };
}

function buildForwardingVectors(): ForwardingVector[] {
  const email = (name: string, changes: Partial<ForwardingVector>): ForwardingVector => ({
    name,
    function: "verifyForwardedEmail",
    secret: FORWARD_SECRET,
    now: NOW,
    body: EMAIL_EVENT,
    headers: standardHeaders(EMAIL_EVENT),
    expected: { ok: true },
    ...changes,
  });
  const notJson = "email.received";
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0xc3]);
  const relayedJson = Buffer.from('{"id":"evt_1","note":"café ✓"}');
  const relayed = (name: string, changes: Partial<ForwardingVector>): ForwardingVector => ({
    name,
    function: "verifyRelayedRequest",
    secret: FORWARD_SECRET,
    now: NOW,
    body: relayedJson.toString("utf8"),
    headers: relayedHeaders(relayedJson),
    expected: { ok: true },
    ...changes,
  });

  return [
    email("forwarded email", {}),
    email("forwarded email, changed body", {
      body: `${EMAIL_EVENT} `,
      expected: { error: "invalid_signature" },
    }),
    email("forwarded email, wrong secret", {
      secret: "whsec_d3Jvbmctc2VjcmV0LWZvci1jb25mb3JtYW5jZQ==",
      expected: { error: "invalid_signature" },
    }),
    email("forwarded email, timestamp more than 300 seconds old", {
      now: (TIMESTAMP + 301) * 1000,
      expected: { error: "timestamp_out_of_range" },
    }),
    email("forwarded email, timestamp more than 300 seconds ahead", {
      now: (TIMESTAMP - 301) * 1000,
      expected: { error: "timestamp_out_of_range" },
    }),
    email("forwarded email, missing webhook-signature", {
      headers: withoutHeaders(standardHeaders(EMAIL_EVENT), ["webhook-signature"]),
      expected: { error: "missing_headers" },
    }),
    email("forwarded email, a signed body that is not JSON", {
      body: notJson,
      headers: standardHeaders(notJson),
      expected: { error: "invalid_payload" },
    }),
    email("forwarded email, a signed request.received event", {
      body: REQUEST_EVENT,
      headers: standardHeaders(REQUEST_EVENT),
      expected: { error: "invalid_payload" },
    }),
    // Signed with the empty key, as anyone could sign it.
    email("forwarded email, a secret that decodes to an empty key", {
      secret: "whsec_",
      headers: standardHeaders(EMAIL_EVENT, TIMESTAMP, EMPTY_KEY),
      expected: { invalidSecret: true },
    }),
    email("forwarded email, an empty key is refused before the headers are read", {
      secret: "whsec_ ",
      headers: {},
      expected: { invalidSecret: true },
    }),
    {
      name: "forwarded request",
      function: "verifyForwardedRequest",
      secret: FORWARD_SECRET,
      now: NOW,
      body: REQUEST_EVENT,
      headers: standardHeaders(REQUEST_EVENT),
      expected: { ok: true },
    },
    {
      name: "forwarded request, a signed email.received event",
      function: "verifyForwardedRequest",
      secret: FORWARD_SECRET,
      now: NOW,
      body: EMAIL_EVENT,
      headers: standardHeaders(EMAIL_EVENT),
      expected: { error: "invalid_payload" },
    },
    {
      name: "forwarded request, a secret of only whitespace",
      function: "verifyForwardedRequest",
      secret: " \n",
      now: NOW,
      body: REQUEST_EVENT,
      headers: standardHeaders(REQUEST_EVENT, TIMESTAMP, EMPTY_KEY),
      expected: { invalidSecret: true },
    },
    {
      name: "your own JSON",
      function: "verifyForwardedJson",
      secret: FORWARD_SECRET,
      now: NOW,
      body: TEMPLATE_BODY,
      headers: standardHeaders(TEMPLATE_BODY),
      expected: { ok: true },
    },
    {
      name: "your own JSON, a body that is a lone JSON value",
      function: "verifyForwardedJson",
      secret: FORWARD_SECRET,
      now: NOW,
      body: "4200",
      headers: standardHeaders("4200"),
      expected: { ok: true },
    },
    {
      name: "your own JSON, changed body",
      function: "verifyForwardedJson",
      secret: FORWARD_SECRET,
      now: NOW,
      body: TEMPLATE_BODY.replace("4200", "9999"),
      headers: standardHeaders(TEMPLATE_BODY),
      expected: { error: "invalid_signature" },
    },
    {
      name: "your own JSON, signed more than five minutes ago",
      function: "verifyForwardedJson",
      secret: FORWARD_SECRET,
      now: (TIMESTAMP + 301) * 1000,
      body: TEMPLATE_BODY,
      headers: standardHeaders(TEMPLATE_BODY),
      expected: { error: "timestamp_out_of_range" },
    },
    {
      name: "your own JSON, a signed body that is not JSON",
      function: "verifyForwardedJson",
      secret: FORWARD_SECRET,
      now: NOW,
      body: "invoice 4200",
      headers: standardHeaders("invoice 4200"),
      expected: { error: "invalid_payload" },
    },
    {
      name: "your own JSON, a secret that decodes to an empty key",
      function: "verifyForwardedJson",
      secret: "whsec_",
      now: NOW,
      body: TEMPLATE_BODY,
      headers: standardHeaders(TEMPLATE_BODY, TIMESTAMP, EMPTY_KEY),
      expected: { invalidSecret: true },
    },
    relayed("relayed request", {}),
    relayed("relayed request, no age limit: a week later still verifies", {
      now: (TIMESTAMP + 7 * 86_400) * 1000,
    }),
    relayed("relayed request, a body that is not UTF-8", {
      body: undefined,
      bodyBase64: binary.toString("base64"),
      headers: relayedHeaders(binary),
    }),
    relayed("relayed request, changed body", {
      body: '{"id":"evt_2","note":"café ✓"}',
      expected: { error: "invalid_signature" },
    }),
    relayed("relayed request, any signature in a space-separated list may match", {
      headers: {
        ...relayedHeaders(relayedJson),
        "webhooks-cc-signature": `v1,b2xkLXNlY3JldC1zaWduYXR1cmU= ${relayedHeaders(relayedJson)["webhooks-cc-signature"]}`,
      },
    }),
    relayed("relayed request, missing webhooks-cc-received-at", {
      headers: withoutHeaders(relayedHeaders(relayedJson), ["webhooks-cc-received-at"]),
      expected: { error: "missing_headers" },
    }),
    relayed("relayed request, a secret that decodes to an empty key", {
      secret: "whsec_",
      headers: relayedHeaders(relayedJson, EMPTY_KEY),
      expected: { invalidSecret: true },
    }),
    relayed("relayed request, an empty key is refused before the headers are read", {
      secret: "whsec_",
      headers: {},
      expected: { invalidSecret: true },
    }),
  ];
}

async function runForwarding(vector: ForwardingVector): Promise<ForwardingVector["expected"]> {
  const body =
    vector.bodyBase64 !== undefined
      ? new Uint8Array(Buffer.from(vector.bodyBase64, "base64"))
      : (vector.body as string);
  try {
    if (vector.function === "verifyForwardedEmail") {
      await verifyForwardedEmail(body, vector.headers, vector.secret, { now: vector.now });
    } else if (vector.function === "verifyForwardedRequest") {
      await verifyForwardedRequest(body, vector.headers, vector.secret, { now: vector.now });
    } else if (vector.function === "verifyForwardedJson") {
      await verifyForwardedJson(body, vector.headers, vector.secret, { now: vector.now });
    } else {
      await verifyRelayedRequest(body, vector.headers, vector.secret);
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof WebhookVerificationError) return { error: error.code };
    if (error instanceof Error && error.message === "The secret decodes to an empty key") {
      return { invalidSecret: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/** A matcher by its TypeScript name and arguments; matchAll and matchAny take matchers. */
interface MatcherSpec {
  fn: string;
  args: unknown[];
}

const m = (fn: string, ...args: unknown[]): MatcherSpec => ({ fn, args });

function toMatcher(spec: MatcherSpec): (request: Request) => boolean {
  const [a, b] = spec.args;
  switch (spec.fn) {
    case "matchMethod":
      return matchMethod(a as string);
    case "matchHeader":
      return matchHeader(a as string, b as string | undefined);
    case "matchPath":
      return matchPath(a as string);
    case "matchQueryParam":
      return matchQueryParam(a as string, b as string | undefined);
    case "matchBodyPath":
      return matchBodyPath(a as string, b);
    case "matchBodySubset":
      return matchBodySubset(a as Record<string, unknown>);
    case "matchContentType":
      return matchContentType(a as string);
    case "matchVerified":
      return matchVerified();
    case "matchUnverified":
      return matchUnverified();
    case "matchEmail":
      return matchEmail(a as EmailCriteria);
    case "isEmailRequest":
      return isEmailRequest;
    case "matchAll": {
      const [first, ...rest] = (spec.args as MatcherSpec[]).map(toMatcher);
      return matchAll(first, ...rest);
    }
    case "matchAny": {
      const [first, ...rest] = (spec.args as MatcherSpec[]).map(toMatcher);
      return matchAny(first, ...rest);
    }
    default:
      throw new Error(`unknown matcher ${spec.fn}`);
  }
}

const EMAIL_CAPTURE = {
  subject: "Confirm your email for Acme",
  from: [{ name: "Acme", address: "No-Reply@Acme.test" }],
  to: [{ name: null, address: "signup+run-42@mailhooks.cc" }],
  cc: [{ name: "QA", address: "qa@acme.test" }],
  replyTo: [],
  sender: [],
  date: "Thu, 01 Jan 2026 00:00:00 +0000",
  messageId: "<1@acme.test>",
  inReplyTo: [],
  tag: "run-42",
  text: "Your verification code is 482913",
  html: null,
  textFromHtml: false,
  attachments: [],
  auth: null,
  smtp: null,
  parseError: false,
  truncated: {
    raw: false,
    text: false,
    html: false,
    headers: false,
    addresses: false,
    attachments: false,
  },
};

const MATCHER_REQUESTS: Record<string, Request> = {
  stripe: {
    id: "4f0e7c1a-0000-4000-8000-000000000001",
    endpointId: "9a8b7c6d-0000-4000-8000-000000000001",
    method: "POST",
    path: "/hooks/stripe/live",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Stripe-Signature": "t=1767225600,v1=abc",
      "x-request-id": "Req_1",
    },
    body: '{"type":"checkout.session.completed","data":{"object":{"id":"cs_1","amount_total":2000,"paid":true,"coupon":null,"metadata":{"order":"1001"}}},"items":[{"sku":"A","qty":1},{"sku":"B","qty":2}]}',
    queryParams: { attempt: "1", debug: "" },
    contentType: "application/json; charset=utf-8",
    ip: "203.0.113.7",
    size: 190,
    receivedAt: 1767225600000,
    signatureVerified: true,
    kind: "http",
  },
  form: {
    id: "4f0e7c1a-0000-4000-8000-000000000002",
    endpointId: "9a8b7c6d-0000-4000-8000-000000000001",
    method: "put",
    path: "/a/b/c.json",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "x=1&y=2",
    queryParams: {},
    ip: "203.0.113.7",
    size: 7,
    receivedAt: 1767225600000,
    signatureVerified: false,
    kind: "http",
  },
  email: {
    id: "4f0e7c1a-0000-4000-8000-000000000003",
    endpointId: "9a8b7c6d-0000-4000-8000-000000000001",
    method: "EMAIL",
    path: "signup+run-42@mailhooks.cc",
    headers: { subject: "Confirm your email for Acme" },
    body: "Subject: Confirm your email for Acme\r\n\r\nYour verification code is 482913",
    queryParams: {},
    ip: "198.51.100.1",
    size: 72,
    receivedAt: 1767225600000,
    signatureVerified: null,
    kind: "email",
    email: EMAIL_CAPTURE,
  },
  emailBcc: {
    id: "4f0e7c1a-0000-4000-8000-000000000006",
    endpointId: "9a8b7c6d-0000-4000-8000-000000000001",
    method: "EMAIL",
    path: "signup+run-42@mailhooks.cc",
    headers: {},
    queryParams: {},
    ip: "198.51.100.1",
    size: 0,
    receivedAt: 1767225600000,
    kind: "email",
    email: { ...EMAIL_CAPTURE, to: [{ name: null, address: "team@acme.test" }], cc: [] },
  },
  emailFromOlderServer: {
    id: "4f0e7c1a-0000-4000-8000-000000000004",
    endpointId: "9a8b7c6d-0000-4000-8000-000000000001",
    method: "EMAIL",
    path: "signup@mailhooks.cc",
    headers: {},
    queryParams: {},
    ip: "198.51.100.1",
    size: 0,
    receivedAt: 1767225600000,
    email: { ...EMAIL_CAPTURE, tag: null, to: [{ name: null, address: "signup@mailhooks.cc" }] },
  },
  emailFromStream: {
    id: "4f0e7c1a-0000-4000-8000-000000000005",
    endpointId: "9a8b7c6d-0000-4000-8000-000000000001",
    method: "EMAIL",
    path: "signup+run-42@mailhooks.cc",
    headers: {},
    queryParams: {},
    ip: "198.51.100.1",
    size: 0,
    receivedAt: 1767225600000,
    kind: "email",
    email: null,
  },
};

interface MatcherCase {
  name: string;
  request: keyof typeof MATCHER_REQUESTS;
  matcher: MatcherSpec;
  expected: boolean;
}

const MATCHER_CASES: MatcherCase[] = [
  { name: "method", request: "stripe", matcher: m("matchMethod", "POST"), expected: true },
  {
    name: "method, any case on either side",
    request: "form",
    matcher: m("matchMethod", "Put"),
    expected: true,
  },
  {
    name: "method, different",
    request: "stripe",
    matcher: m("matchMethod", "GET"),
    expected: false,
  },
  {
    name: "header present, name in any case",
    request: "stripe",
    matcher: m("matchHeader", "stripe-signature"),
    expected: true,
  },
  {
    name: "header value, exact",
    request: "stripe",
    matcher: m("matchHeader", "X-Request-Id", "Req_1"),
    expected: true,
  },
  {
    name: "header value, case matters",
    request: "stripe",
    matcher: m("matchHeader", "x-request-id", "req_1"),
    expected: false,
  },
  {
    name: "header absent",
    request: "form",
    matcher: m("matchHeader", "stripe-signature"),
    expected: false,
  },
  {
    name: "path, exact",
    request: "stripe",
    matcher: m("matchPath", "/hooks/stripe/live"),
    expected: true,
  },
  {
    name: "path, * stays within a segment",
    request: "stripe",
    matcher: m("matchPath", "/hooks/*"),
    expected: false,
  },
  {
    name: "path, * matches one segment",
    request: "stripe",
    matcher: m("matchPath", "/hooks/*/live"),
    expected: true,
  },
  {
    name: "path, ** crosses segments",
    request: "stripe",
    matcher: m("matchPath", "/hooks/**"),
    expected: true,
  },
  {
    name: "path, a dot is literal",
    request: "form",
    matcher: m("matchPath", "/a/b/c.json"),
    expected: true,
  },
  {
    name: "path, ? is one character",
    request: "form",
    matcher: m("matchPath", "/a/b/c.jso?"),
    expected: true,
  },
  {
    name: "path, ? is not a slash",
    request: "form",
    matcher: m("matchPath", "/a?b/c.json"),
    expected: false,
  },
  {
    name: "path, a dot in the pattern matches only a dot",
    request: "form",
    matcher: m("matchPath", "/a/b/c.jso."),
    expected: false,
  },
  {
    name: "path, ** takes the slash after it",
    request: "form",
    matcher: m("matchPath", "/a/**/b/c.json"),
    expected: true,
  },
  {
    name: "path, the whole path must match",
    request: "form",
    matcher: m("matchPath", "/a/b"),
    expected: false,
  },
  {
    name: "query parameter present",
    request: "stripe",
    matcher: m("matchQueryParam", "attempt"),
    expected: true,
  },
  {
    name: "query parameter present with an empty value",
    request: "stripe",
    matcher: m("matchQueryParam", "debug"),
    expected: true,
  },
  {
    name: "query parameter value",
    request: "stripe",
    matcher: m("matchQueryParam", "attempt", "2"),
    expected: false,
  },
  {
    name: "body path, string",
    request: "stripe",
    matcher: m("matchBodyPath", "type", "checkout.session.completed"),
    expected: true,
  },
  {
    name: "body path, nested number",
    request: "stripe",
    matcher: m("matchBodyPath", "data.object.amount_total", 2000),
    expected: true,
  },
  {
    name: "body path, a number does not equal its string",
    request: "stripe",
    matcher: m("matchBodyPath", "data.object.amount_total", "2000"),
    expected: false,
  },
  {
    name: "body path, boolean",
    request: "stripe",
    matcher: m("matchBodyPath", "data.object.paid", true),
    expected: true,
  },
  {
    name: "body path, null",
    request: "stripe",
    matcher: m("matchBodyPath", "data.object.coupon", null),
    expected: true,
  },
  {
    name: "body path, array index",
    request: "stripe",
    matcher: m("matchBodyPath", "items.1.sku", "B"),
    expected: true,
  },
  {
    name: "body path, index past the end",
    request: "stripe",
    matcher: m("matchBodyPath", "items.2.sku", "B"),
    expected: false,
  },
  {
    name: "body path, missing key",
    request: "stripe",
    matcher: m("matchBodyPath", "data.object.missing", null),
    expected: false,
  },
  {
    name: "body path, objects never match",
    request: "stripe",
    matcher: m("matchBodyPath", "data.object.metadata", { order: "1001" }),
    expected: false,
  },
  {
    name: "body path, a body that is not JSON",
    request: "form",
    matcher: m("matchBodyPath", "x", "1"),
    expected: false,
  },
  {
    name: "body subset, nested",
    request: "stripe",
    matcher: m("matchBodySubset", { data: { object: { metadata: { order: "1001" } } } }),
    expected: true,
  },
  {
    name: "body subset, arrays match by position",
    request: "stripe",
    matcher: m("matchBodySubset", { items: [{ sku: "A" }] }),
    expected: true,
  },
  {
    name: "body subset, arrays do not match out of position",
    request: "stripe",
    matcher: m("matchBodySubset", { items: [{ sku: "B" }] }),
    expected: false,
  },
  {
    name: "body subset, a value differs",
    request: "stripe",
    matcher: m("matchBodySubset", { type: "invoice.paid" }),
    expected: false,
  },
  {
    name: "body subset, null matches null",
    request: "stripe",
    matcher: m("matchBodySubset", { data: { object: { coupon: null } } }),
    expected: true,
  },
  {
    name: "content type, parameters ignored",
    request: "stripe",
    matcher: m("matchContentType", "application/json"),
    expected: true,
  },
  {
    name: "content type, any case",
    request: "stripe",
    matcher: m("matchContentType", "Application/JSON"),
    expected: true,
  },
  {
    name: "content type, from the header when contentType is absent",
    request: "form",
    matcher: m("matchContentType", "application/x-www-form-urlencoded"),
    expected: true,
  },
  {
    name: "content type, a prefix is not enough",
    request: "stripe",
    matcher: m("matchContentType", "application/js"),
    expected: false,
  },
  { name: "verified", request: "stripe", matcher: m("matchVerified"), expected: true },
  { name: "verified, failed", request: "form", matcher: m("matchVerified"), expected: false },
  { name: "unverified", request: "form", matcher: m("matchUnverified"), expected: true },
  {
    name: "unverified, not checked at all",
    request: "email",
    matcher: m("matchUnverified"),
    expected: false,
  },
  {
    name: "all, every matcher",
    request: "stripe",
    matcher: m("matchAll", m("matchMethod", "POST"), m("matchPath", "/hooks/**")),
    expected: true,
  },
  {
    name: "all, one fails",
    request: "stripe",
    matcher: m("matchAll", m("matchMethod", "POST"), m("matchPath", "/other/**")),
    expected: false,
  },
  {
    name: "any, one matches",
    request: "stripe",
    matcher: m("matchAny", m("matchMethod", "GET"), m("matchHeader", "stripe-signature")),
    expected: true,
  },
  {
    name: "any, none match",
    request: "form",
    matcher: m("matchAny", m("matchMethod", "GET"), m("matchHeader", "stripe-signature")),
    expected: false,
  },
  { name: "is email", request: "email", matcher: m("isEmailRequest"), expected: true },
  {
    name: "is email, method EMAIL and an address as the path from a server without kind",
    request: "emailFromOlderServer",
    matcher: m("isEmailRequest"),
    expected: true,
  },
  {
    name: "is email, not without the parsed message",
    request: "emailFromStream",
    matcher: m("isEmailRequest"),
    expected: false,
  },
  { name: "is email, http", request: "stripe", matcher: m("isEmailRequest"), expected: false },
  {
    name: "email, no criteria",
    request: "email",
    matcher: m("matchEmail", {}),
    expected: true,
  },
  {
    name: "email, never an http request",
    request: "stripe",
    matcher: m("matchEmail", {}),
    expected: false,
  },
  {
    name: "email, tag",
    request: "email",
    matcher: m("matchEmail", { tag: "run-42" }),
    expected: true,
  },
  {
    name: "email, tags are case-sensitive",
    request: "email",
    matcher: m("matchEmail", { tag: "RUN-42" }),
    expected: false,
  },
  {
    name: "email, tag null matches untagged mail only",
    request: "email",
    matcher: m("matchEmail", { tag: null }),
    expected: false,
  },
  {
    name: "email, tag null on untagged mail",
    request: "emailFromOlderServer",
    matcher: m("matchEmail", { tag: null }),
    expected: true,
  },
  {
    name: "email, subject substring",
    request: "email",
    matcher: m("matchEmail", { subject: "your email" }),
    expected: true,
  },
  {
    name: "email, subject substring is case-sensitive",
    request: "email",
    matcher: m("matchEmail", { subject: "YOUR EMAIL" }),
    expected: false,
  },
  {
    name: "email, from in any case",
    request: "email",
    matcher: m("matchEmail", { from: "no-reply@acme.test" }),
    expected: true,
  },
  {
    name: "email, from is the whole address",
    request: "email",
    matcher: m("matchEmail", { from: "acme.test" }),
    expected: false,
  },
  {
    name: "email, to includes Cc",
    request: "email",
    matcher: m("matchEmail", { to: "QA@acme.test" }),
    expected: true,
  },
  {
    name: "email, to includes the address it was delivered to (a Bcc)",
    request: "emailBcc",
    matcher: m("matchEmail", { to: "signup+run-42@mailhooks.cc" }),
    expected: true,
  },
  {
    name: "email, to that is in neither To, Cc nor the delivered-to address",
    request: "emailBcc",
    matcher: m("matchEmail", { to: "someone@else.test" }),
    expected: false,
  },
  {
    name: "email, to also matches the To header",
    request: "emailBcc",
    matcher: m("matchEmail", { to: "team@acme.test" }),
    expected: true,
  },
  {
    name: "email, every criterion must match",
    request: "email",
    matcher: m("matchEmail", { tag: "run-42", subject: "Reset" }),
    expected: false,
  },
];

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const DURATION_INPUTS: (number | string)[] = [
  0,
  500,
  1500.5,
  "500",
  "0",
  "2.5",
  "500ms",
  "30s",
  "1.5s",
  "5m",
  "2h",
  "7d",
  " 10s ",
  "10 s",
  "",
  "-5",
  -5,
  "5x",
  "10S",
  "1m30s",
  "s",
  "0x10",
  "1e3",
  "0b11",
  "+5",
  // Digits past what a double holds, and a value its unit overflows: refused, never Infinity.
  "9".repeat(400),
  "1e400",
  `${"9".repeat(400)}ms`,
  `1${"0".repeat(306)}d`,
  ".5",
  "5.",
  "Infinity",
];

function buildDurationVectors() {
  return DURATION_INPUTS.map((input) => {
    try {
      return { input, expected: { ms: parseDuration(input) } };
    } catch {
      return { input, expected: { error: true } };
    }
  });
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

interface ErrorCase {
  name: string;
  status: number;
  /** The answer's body, exactly as sent. */
  body: string;
  /** The API's text before any hint the SDK adds (TypeScript's `apiMessage`). */
  message: string;
  /** The API's error code as this SDK reads it (`WebhooksCCError.code`), or null. */
  code: string | null;
  /** Whether the SDK adds its recovery hint (401 and 404 under 30 characters). */
  hinted: boolean;
}

const LONG_CODE = "a".repeat(1200);

const ERROR_CASES: ErrorCase[] = [
  // A bare code says the status in words, alone when the code only names it.
  {
    name: "404 not_found",
    status: 404,
    body: '{"error":"not_found"}',
    message: "Not found",
    code: "not_found",
    hinted: true,
  },
  {
    name: "401 unauthorized",
    status: 401,
    body: '{"error":"unauthorized"}',
    message: "Unauthorized",
    code: "unauthorized",
    hinted: true,
  },
  {
    name: "403 forbidden",
    status: 403,
    body: '{"error":"forbidden"}',
    message: "Forbidden",
    code: "forbidden",
    hinted: false,
  },
  {
    name: "409 conflict",
    status: 409,
    body: '{"error":"conflict"}',
    message: "Conflict",
    code: "conflict",
    hinted: false,
  },
  {
    name: "400 bad_request",
    status: 400,
    body: '{"error":"bad_request"}',
    message: "Bad request",
    code: "bad_request",
    hinted: false,
  },
  {
    name: "429 too_many_requests",
    status: 429,
    body: '{"error":"too_many_requests"}',
    message: "Too many requests",
    code: "too_many_requests",
    hinted: false,
  },
  {
    name: "500 server_error",
    status: 500,
    body: '{"error":"server_error"}',
    message: "Server error",
    code: "server_error",
    hinted: false,
  },
  {
    name: "410 names its own status words",
    status: 410,
    body: '{"error":"request_failed_with_http_410"}',
    message: "Request failed with HTTP 410",
    code: "request_failed_with_http_410",
    hinted: false,
  },
  // A code that says more than the status stays, in brackets.
  {
    name: "400 invalid_since",
    status: 400,
    body: '{"error":"invalid_since"}',
    message: "Bad request (invalid_since)",
    code: "invalid_since",
    hinted: false,
  },
  {
    name: "400 invalid_cursor",
    status: 400,
    body: '{"error":"invalid_cursor"}',
    message: "Bad request (invalid_cursor)",
    code: "invalid_cursor",
    hinted: false,
  },
  {
    name: "409 slug_exists",
    status: 409,
    body: '{"error":"slug_exists"}',
    message: "Conflict (slug_exists)",
    code: "slug_exists",
    hinted: false,
  },
  {
    name: "401 invalid_token",
    status: 401,
    body: '{"error":"invalid_token"}',
    message: "Unauthorized (invalid_token)",
    code: "invalid_token",
    hinted: true,
  },
  {
    name: "401 invalid_api_key is 30 characters, no hint",
    status: 401,
    body: '{"error":"invalid_api_key"}',
    message: "Unauthorized (invalid_api_key)",
    code: "invalid_api_key",
    hinted: false,
  },
  {
    name: "404 a code with digits",
    status: 404,
    body: '{"error":"e404"}',
    message: "Not found (e404)",
    code: "e404",
    hinted: true,
  },
  {
    name: "400 a code with digits and an underscore",
    status: 400,
    body: '{"error":"v2_bad"}',
    message: "Bad request (v2_bad)",
    code: "v2_bad",
    hinted: false,
  },
  {
    name: "429 search_busy",
    status: 429,
    body: '{"error":"search_busy"}',
    message: "Too many requests (search_busy)",
    code: "search_busy",
    hinted: false,
  },
  {
    name: "500 internal_error",
    status: 500,
    body: '{"error":"internal_error"}',
    message: "Server error (internal_error)",
    code: "internal_error",
    hinted: false,
  },
  {
    name: "503 unavailable",
    status: 503,
    body: '{"error":"unavailable"}',
    message: "Server error (unavailable)",
    code: "unavailable",
    hinted: false,
  },
  {
    name: "410 expired",
    status: 410,
    body: '{"error":"expired"}',
    message: "Request failed with HTTP 410 (expired)",
    code: "expired",
    hinted: false,
  },
  {
    name: "418 teapot",
    status: 418,
    body: '{"error":"im_a_teapot"}',
    message: "Request failed with HTTP 418 (im_a_teapot)",
    code: "im_a_teapot",
    hinted: false,
  },
  {
    name: "410 a message that is only a code",
    status: 410,
    body: '{"message":"expired"}',
    message: "Request failed with HTTP 410 (expired)",
    code: null,
    hinted: false,
  },
  {
    name: "409 a message that is only a code, beside another code",
    status: 409,
    body: '{"error":"invalid_input","message":"name_taken"}',
    message: "Conflict (name_taken)",
    code: "invalid_input",
    hinted: false,
  },
  {
    name: "400 a 1000-character code is whole",
    status: 400,
    body: JSON.stringify({ error: "a".repeat(1000) }),
    message: `Bad request (${"a".repeat(1000)})`,
    code: "a".repeat(1000),
    hinted: false,
  },
  {
    name: "400 a 1200-character code is cut and kept as text",
    status: 400,
    body: JSON.stringify({ error: LONG_CODE }),
    message: `${"a".repeat(1000)}...`,
    code: LONG_CODE,
    hinted: false,
  },
  // Text that is not a code is kept as it is.
  {
    name: "404 a bare number is no code",
    status: 404,
    body: '{"error":"404"}',
    message: "404",
    code: null,
    hinted: true,
  },
  {
    name: "404 a hyphen is no code",
    status: 404,
    body: '{"error":"not-found"}',
    message: "not-found",
    code: null,
    hinted: true,
  },
  {
    name: "404 a capital letter is no code",
    status: 404,
    body: '{"error":"Not_found"}',
    message: "Not_found",
    code: null,
    hinted: true,
  },
  {
    name: "404 a letter past ASCII is no code",
    status: 404,
    body: '{"error":"nöt_found"}',
    message: "nöt_found",
    code: null,
    hinted: true,
  },
  {
    name: "404 a padded code is no code",
    status: 404,
    body: '{"error":" not_found "}',
    message: " not_found ",
    code: null,
    hinted: true,
  },
  {
    name: "404 a code with a line break after it is no code",
    status: 404,
    body: '{"error":"not_found\\n"}',
    message: "not_found\n",
    code: null,
    hinted: true,
  },
  {
    name: "404 a sentence",
    status: 404,
    body: '{"error":"Request not found"}',
    message: "Request not found",
    code: null,
    hinted: true,
  },
  {
    name: "429 a sentence",
    status: 429,
    body: '{"error":"Rate limit exceeded"}',
    message: "Rate limit exceeded",
    code: null,
    hinted: false,
  },
  {
    name: "429 the status words as a sentence",
    status: 429,
    body: '{"error":"Too many requests"}',
    message: "Too many requests",
    code: null,
    hinted: false,
  },
  {
    name: "503 a sentence",
    status: 503,
    body: '{"error":"Service unavailable"}',
    message: "Service unavailable",
    code: null,
    hinted: false,
  },
  // message wins over error; a blank or non-string message gives way.
  {
    name: "404 message beside a code",
    status: 404,
    body: '{"error":"not_found","message":"Request not found"}',
    message: "Request not found",
    code: "not_found",
    hinted: true,
  },
  {
    name: "400 message beside invalid_cursor",
    status: 400,
    body: '{"error":"invalid_cursor","message":"The cursor is not one this search returned"}',
    message: "The cursor is not one this search returned",
    code: "invalid_cursor",
    hinted: false,
  },
  {
    name: "400 message before invalid_cursor",
    status: 400,
    body: '{"message":"The cursor is not one this search returned","error":"invalid_cursor"}',
    message: "The cursor is not one this search returned",
    code: "invalid_cursor",
    hinted: false,
  },
  {
    name: "409 message beside a sentence",
    status: 409,
    body: '{"message":"Name is taken","error":"Conflict"}',
    message: "Name is taken",
    code: null,
    hinted: false,
  },
  {
    name: "400 a blank message gives way",
    status: 400,
    body: '{"message":"  ","error":"name is too long"}',
    message: "name is too long",
    code: null,
    hinted: false,
  },
  {
    name: "400 a message only trim() calls blank (U+FEFF) gives way",
    status: 400,
    body: '{"message":"\\ufeff ","error":"name is too long"}',
    message: "name is too long",
    code: null,
    hinted: false,
  },
  {
    name: "404 a message that is not a string gives way",
    status: 404,
    body: '{"message":5,"error":"Endpoint not found"}',
    message: "Endpoint not found",
    code: null,
    hinted: true,
  },
  {
    name: "400 a message over 200 characters is read whole",
    status: 400,
    body: JSON.stringify({ error: "invalid_input", message: "y ".repeat(125) }),
    message: "y ".repeat(125),
    code: "invalid_input",
    hinted: false,
  },
  {
    name: "400 a message over 1000 characters is cut",
    status: 400,
    body: JSON.stringify({ message: "m".repeat(1500) }),
    message: `${"m".repeat(1000)}...`,
    code: null,
    hinted: false,
  },
  {
    name: "400 a cut never splits a surrogate pair",
    status: 400,
    body: JSON.stringify({
      error: "invalid_input",
      message: "a".repeat(999) + "\u{1F600}".repeat(5),
    }),
    message: "a".repeat(999) + "\u{1F600}...",
    code: "invalid_input",
    hinted: false,
  },
  // A code field beside the error.
  {
    name: "502 a code field beside a sentence",
    status: 502,
    body: '{"error":"Polar did not answer","code":"outcome_unknown"}',
    message: "Polar did not answer",
    code: "outcome_unknown",
    hinted: false,
  },
  {
    name: "429 search_busy as a code field",
    status: 429,
    body: '{"error":"Search busy","code":"search_busy"}',
    message: "Search busy",
    code: "search_busy",
    hinted: false,
  },
  {
    name: "400 a code field that is no code",
    status: 400,
    body: '{"error":"Bad things","code":"Not-A-Code"}',
    message: "Bad things",
    code: null,
    hinted: false,
  },
  // Bodies that are not a JSON object with text are kept, cut at 200 characters.
  {
    name: "502 plain text",
    status: 502,
    body: "Bad gateway",
    message: "Bad gateway",
    code: null,
    hinted: false,
  },
  {
    name: "404 plain text that looks like a code",
    status: 404,
    body: "not_found",
    message: "not_found",
    code: null,
    hinted: true,
  },
  {
    name: "404 a JSON string",
    status: 404,
    body: '"not_found"',
    message: '"not_found"',
    code: null,
    hinted: true,
  },
  {
    name: "404 a JSON array",
    status: 404,
    body: '["not_found"]',
    message: '["not_found"]',
    code: null,
    hinted: true,
  },
  { name: "404 JSON null", status: 404, body: "null", message: "null", code: null, hinted: true },
  {
    name: "400 an error that is an object",
    status: 400,
    body: '{"error":{"code":"x"}}',
    message: '{"error":{"code":"x"}}',
    code: null,
    hinted: false,
  },
  {
    name: "400 empty message and error",
    status: 400,
    body: '{"message":"","error":""}',
    message: '{"message":"","error":""}',
    code: null,
    hinted: false,
  },
  {
    name: "400 an object without either",
    status: 400,
    body: '{"detail":"x"}',
    message: '{"detail":"x"}',
    code: null,
    hinted: false,
  },
  {
    name: "503 HTML",
    status: 503,
    body: "<html><body>Service Unavailable</body></html>",
    message: "<html><body>Service Unavailable</body></html>",
    code: null,
    hinted: false,
  },
  { name: "404 an empty body", status: 404, body: "", message: "", code: null, hinted: true },
  {
    name: "500 a 200-character body is whole",
    status: 500,
    body: "z".repeat(200),
    message: "z".repeat(200),
    code: null,
    hinted: false,
  },
  {
    name: "500 a long body is cut",
    status: 500,
    body: "z".repeat(400),
    message: `${"z".repeat(200)}...`,
    code: null,
    hinted: false,
  },
  {
    name: "502 a cut body never splits a surrogate pair",
    status: 502,
    body: "b".repeat(199) + "\u{1F600}".repeat(50),
    message: "b".repeat(199) + "\u{1F600}...",
    code: null,
    hinted: false,
  },
  {
    name: "400 unterminated JSON is plain text",
    status: 400,
    body: `{"error":"${"x".repeat(300)}`,
    message: `{"error":"${"x".repeat(190)}...`,
    code: null,
    hinted: false,
  },
  // The hint: 401 and 404 under 30 characters (UTF-16 units here).
  {
    name: "404 29 characters get a hint",
    status: 404,
    body: '{"error":"This endpoint does not exist."}',
    message: "This endpoint does not exist.",
    code: null,
    hinted: true,
  },
  {
    name: "404 30 characters get none",
    status: 404,
    body: '{"error":"This endpoint does not exist!!"}',
    message: "This endpoint does not exist!!",
    code: null,
    hinted: false,
  },
  {
    name: "401 a short sentence",
    status: 401,
    body: '{"error":"Invalid API key"}',
    message: "Invalid API key",
    code: null,
    hinted: true,
  },
  {
    name: "401 a long sentence",
    status: 401,
    body: '{"error":"This API key was revoked by its owner."}',
    message: "This API key was revoked by its owner.",
    code: null,
    hinted: false,
  },
  {
    name: "404 20 accented letters",
    status: 404,
    body: JSON.stringify({ error: "é".repeat(20) }),
    message: "é".repeat(20),
    code: null,
    hinted: true,
  },
  {
    name: "404 a lone surrogate counts as one character",
    status: 404,
    body: '{"error":"\\ud800"}',
    message: "\ud800",
    code: null,
    hinted: true,
  },
  {
    name: "404 20 emoji",
    status: 404,
    body: JSON.stringify({ error: "\u{1F600}".repeat(20) }),
    message: "\u{1F600}".repeat(20),
    code: null,
    hinted: false,
  },
];

/** The error a call fails with when the API answers `status` with `body`. */
async function errorFor(status: number, body: string): Promise<WebhooksCCError> {
  const client = new WebhooksCC({
    apiKey: "whcc_conformance",
    baseUrl: "https://webhooks.test",
    fetch: (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch,
  });
  try {
    await client.endpoints.get("acme");
  } catch (error) {
    expect(error).toBeInstanceOf(WebhooksCCError);
    return error as WebhooksCCError;
  }
  throw new Error("expected the call to fail");
}

function buildErrorVectors() {
  return ERROR_CASES.map(({ name, status, body, message, code, hinted }) => ({
    name,
    status,
    body,
    expected: { message, code, hinted },
  }));
}

// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conformance vectors", () => {
  it("decides for every provider whether it is signed", () => {
    for (const provider of TEMPLATE_PROVIDERS) {
      const signed = provider in SIGNATURE_HEADERS;
      const unsigned = provider in NOT_SIGNED;
      expect(signed !== unsigned, provider).toBe(true);
    }
    expect(Object.keys(SIGNATURE_HEADERS).length + Object.keys(NOT_SIGNED).length).toBe(
      TEMPLATE_PROVIDERS.length
    );
  });

  it("signing.json", async () => {
    const vectors = await buildSigningVectors();
    await expect(
      file(
        "Signed requests a port must produce. Give the provider, secret, method, URL, body, timestamp (seconds) and, where present, messageId to the port's request builder; it must set every header in expected.headers to exactly that value and send expected.body. Mailgun and Adyen sign inside the body. Providers without vectors: " +
          Object.entries(NOT_SIGNED)
            .map(([provider, reason]) => `${provider} (${reason})`)
            .join(" "),
        vectors
      )
    ).toMatchFileSnapshot("../../conformance/signing.json");
  });

  it("verify.json", async () => {
    const signing = await buildSigningVectors();
    const vectors = buildVerifyCases(signing);
    for (const provider of VERIFY_PROVIDERS) {
      expect(
        vectors.some((vector) => vector.provider === provider && vector.expected),
        provider
      ).toBe(true);
    }
    for (const vector of vectors) {
      expect(await runVerify(vector), vector.name).toBe(vector.expected);
    }
    await expect(
      file(
        "Signature checks a port must agree with. Verify body and headers for the provider with secret (the webhook id for PayPal), publicKey (Discord), url and method, and a clock frozen at now (milliseconds); for PayPal, the certificate URL serves certificate. The result must equal expected. Header names match in any case. Only HubSpot limits the signature's age. Not verifiable: sendgrid (no signatures), plaid (needs Plaid's API).",
        vectors
      )
    ).toMatchFileSnapshot("../../conformance/verify.json");
  });

  it("forwarding.json", async () => {
    const vectors = buildForwardingVectors();
    for (const vector of vectors) {
      expect(await runForwarding(vector), vector.name).toEqual(vector.expected);
    }
    await expect(
      file(
        "webhooks.cc's own forwarding signatures. Call the port's equivalent of function with body (or the bytes of bodyBase64), headers and secret, with the clock at now (milliseconds). expected.ok means it returns the parsed event, the parsed body (verifyForwardedJson, for a destination's own JSON, which can be any JSON value) or the relay metadata; expected.error is the error code it raises. expected.invalidSecret means it refuses the secret itself, whatever the request carries, with the error the language uses for a bad argument rather than a verification error: the secret decodes to an empty key, and an HMAC keyed with nothing is one anyone can compute.",
        vectors,
        FORWARDING_FORMAT_VERSION
      )
    ).toMatchFileSnapshot("../../conformance/forwarding.json");
  });

  it("matchers.json", async () => {
    for (const testCase of MATCHER_CASES) {
      expect(toMatcher(testCase.matcher)(MATCHER_REQUESTS[testCase.request]), testCase.name).toBe(
        testCase.expected
      );
    }
    await expect(
      `${JSON.stringify(
        {
          version: FORMAT_VERSION,
          generatedBy: GENERATED_BY,
          description:
            "Request matchers. Build the matcher named by fn (TypeScript names; matchAll and matchAny take matchers as args), apply it to requests[request], and compare with expected. Regular-expression forms of matchEmail are left to each language.",
          requests: MATCHER_REQUESTS,
          vectors: MATCHER_CASES,
        },
        null,
        2
      )}\n`
    ).toMatchFileSnapshot("../../conformance/matchers.json");
  });

  it("durations.json", async () => {
    await expect(
      file(
        "Duration options (timeouts, poll intervals): a number is milliseconds; a string is trimmed, then must be ASCII digits with an optional fraction, optionally followed by whitespace and one of ms, s, m, h or d (lowercase). expected.ms is the result; expected.error means the input is refused.",
        buildDurationVectors()
      )
    ).toMatchFileSnapshot("../../conformance/durations.json");
  });

  it("errors.json", async () => {
    const names = new Set<string>();
    for (const testCase of ERROR_CASES) {
      expect(names.has(testCase.name), testCase.name).toBe(false);
      names.add(testCase.name);
      const error = await errorFor(testCase.status, testCase.body);
      expect(error.statusCode, testCase.name).toBe(testCase.status);
      expect(error.apiMessage, testCase.name).toBe(testCase.message);
      expect(error.code ?? null, testCase.name).toBe(testCase.code);
      const hintable = testCase.status === 401 || testCase.status === 404;
      expect(hintable && error.message !== error.apiMessage, testCase.name).toBe(testCase.hinted);
      if (testCase.hinted) {
        expect(error.message.startsWith(testCase.message), testCase.name).toBe(true);
      } else if (testCase.status !== 429) {
        expect(error.message, testCase.name).toBe(testCase.message);
      }
    }
    await expect(
      file(
        "Error messages made from API answers. A call (GET /api/endpoints/acme) answered with status and body (exactly these characters, as UTF-8) fails with an error whose text before any hint the SDK adds is expected.message: the body's string message, else its string error (a blank one, as JavaScript's trim() sees it, gives way), cut to 1000 characters with ... after it; a message that is only a code (lower-case ASCII letters, digits and underscores, starting with a letter) becomes the status in words, alone when the code only names the status, else with the code in brackets; a body that is not a JSON object with either is kept as it came, cut to 200 characters. Characters are code points, so a cut never splits a surrogate pair. expected.hinted says whether the SDK adds its recovery hint, which only a 401 or 404 message under 30 characters (UTF-16 units) gets; the hint's wording is each SDK's own. On any status but 401, 404 and 429 (whose message is each SDK's rate-limit text) the error's message is expected.message itself. expected.code is the API's error code as the TypeScript SDK reads it: error when it is a code, wherever it sits in the object, else a code field that is a code, else null; a sentence is never a code. A port lists in its test the vectors where it differs, and why.",
        buildErrorVectors()
      )
    ).toMatchFileSnapshot("../../conformance/errors.json");
  });
});
