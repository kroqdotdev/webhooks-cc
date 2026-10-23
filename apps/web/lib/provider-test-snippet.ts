/**
 * The "test your handler in CI" snippet on provider pages: a Vitest file that
 * sends a correctly signed sample to a local route with `sendTo`, plus a
 * forged one the handler must reject. Only for providers whose templates a
 * real handler can verify with its own secret.
 */

/** When the snippet first appeared: pages that show it date their content from here. */
export const PROVIDER_TEST_SNIPPET_ADDED = "2026-10-23";

/**
 * Templates whose signature is a placeholder: PayPal signs with its own
 * private key, which template generation cannot hold.
 */
const PLACEHOLDER_SIGNATURES = new Set(["paypal"]);

/** The env var a handler usually reads its credential from, where it is not <PROVIDER>_WEBHOOK_SECRET. */
const SECRET_ENV: Partial<Record<string, string>> = {
  adyen: "ADYEN_HMAC_KEY",
  clerk: "CLERK_WEBHOOK_SIGNING_SECRET",
  gitlab: "GITLAB_WEBHOOK_TOKEN",
  hubspot: "HUBSPOT_CLIENT_SECRET",
  intercom: "INTERCOM_CLIENT_SECRET",
  mailgun: "MAILGUN_WEBHOOK_SIGNING_KEY",
  meta: "META_APP_SECRET",
  slack: "SLACK_SIGNING_SECRET",
  "standard-webhooks": "WEBHOOK_SECRET",
  telegram: "TELEGRAM_SECRET_TOKEN",
  twilio: "TWILIO_AUTH_TOKEN",
};

export interface SnippetProvider {
  slug: string;
  label: string;
  inSdk: boolean;
  secretRequired: boolean;
  defaultTemplate: string | null;
}

export function hasProviderTestSnippet(page: SnippetProvider): boolean {
  return page.inSdk && page.secretRequired && !PLACEHOLDER_SIGNATURES.has(page.slug);
}

/** A wrong credential the provider's signing still accepts: Adyen keys must be hex. */
export function providerForgedSecret(slug: string): string {
  return slug === "adyen" ? "00".repeat(32) : "not-the-real-secret";
}

export function providerSecretEnv(slug: string): string {
  return SECRET_ENV[slug] ?? `${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_WEBHOOK_SECRET`;
}

export function providerTestSnippet(page: SnippetProvider): string | null {
  if (!hasProviderTestSnippet(page)) return null;
  const env = providerSecretEnv(page.slug);
  const template = page.defaultTemplate;
  const payload = template
    ? `    template: ${JSON.stringify(template)},`
    : `    body: { type: "invoice.paid", data: { id: "inv_123" } },`;
  const what = template ? `a signed ${template}` : "a signed event";
  return `import { describe, expect, it } from "vitest";
import { WebhooksCC } from "@webhooks-cc/sdk";

// Runs against your app on localhost. WHK_API_KEY and ${env} come from the env.
const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });
const url = "http://localhost:3000/api/webhooks/${page.slug}";

const send = (secret: string) =>
  client.sendTo(url, {
    provider: ${JSON.stringify(page.slug)},
${payload}
    secret,
  });

describe(${JSON.stringify(`${page.label} webhook handler`)}, () => {
  it(${JSON.stringify(`accepts ${what}`)}, async () => {
    const response = await send(process.env.${env}!);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });

  it("rejects a forged signature", async () => {
    const response = await send(${JSON.stringify(providerForgedSecret(page.slug))});
    // A 4xx, not a crash: providers retry 5xx responses.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
`;
}
