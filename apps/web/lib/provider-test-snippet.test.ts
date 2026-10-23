import { describe, expect, it } from "vitest";
import ts from "typescript";
import { buildTemplateSendOptions, verifySignature, type TemplateProvider } from "@webhooks-cc/sdk";
import { getAllWebhookProviderPages, getWebhookProviderPage } from "./webhook-provider-pages";
import {
  hasProviderTestSnippet,
  providerForgedSecret,
  providerSecretEnv,
  providerTestSnippet,
  PROVIDER_TEST_SNIPPET_ADDED,
} from "./provider-test-snippet";

const pages = getAllWebhookProviderPages();
const withSnippet = pages.filter(hasProviderTestSnippet);

/** A test credential in the form each provider's signing scheme expects. */
function testSecret(slug: string): string {
  if (slug === "adyen") return "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
  if (["standard-webhooks", "clerk", "resend"].includes(slug)) {
    return `whsec_${Buffer.from("snippet-test-secret-0123456789").toString("base64")}`;
  }
  return `${slug}-snippet-test-secret`;
}

describe("provider test snippet", () => {
  it("is shown for providers a real handler can verify, and no others", () => {
    expect(withSnippet).toHaveLength(30);
    for (const slug of ["discord", "paypal", "plaid", "sendgrid", "zapier", "bigcommerce"]) {
      expect(providerTestSnippet(getWebhookProviderPage(slug)!), slug).toBeNull();
    }
  });

  it("builds a signed request the provider's verifier accepts with the same secret only", async () => {
    for (const page of withSnippet) {
      const url = `http://localhost:3000/api/webhooks/${page.slug}`;
      const secret = testSecret(page.slug);
      const sent = await buildTemplateSendOptions(url, {
        provider: page.slug as TemplateProvider,
        template: page.defaultTemplate ?? undefined,
        secret,
        body: page.defaultTemplate ? undefined : { type: "invoice.paid", data: { id: "inv_123" } },
      });
      const request = {
        headers: sent.headers ?? {},
        body: typeof sent.body === "string" ? sent.body : JSON.stringify(sent.body),
      };
      const options = { provider: page.slug as Exclude<TemplateProvider, "discord">, url };
      const valid = await verifySignature(request, { ...options, secret, method: "POST" });
      expect(valid.valid, page.slug).toBe(true);
      const forged = await verifySignature(request, {
        ...options,
        secret: testSecret("other"),
        method: "POST",
      });
      expect(forged.valid, `${page.slug} with another secret`).toBe(false);
    }
  });

  it("signs the snippet's own forged request, which the real secret then rejects", async () => {
    for (const page of withSnippet) {
      const url = `http://localhost:3000/api/webhooks/${page.slug}`;
      const forged = providerForgedSecret(page.slug);
      expect(providerTestSnippet(page), page.slug).toContain(`send(${JSON.stringify(forged)})`);
      const sent = await buildTemplateSendOptions(url, {
        provider: page.slug as TemplateProvider,
        template: page.defaultTemplate ?? undefined,
        secret: forged,
        body: page.defaultTemplate ? undefined : { type: "invoice.paid", data: { id: "inv_123" } },
      });
      const request = {
        headers: sent.headers ?? {},
        body: typeof sent.body === "string" ? sent.body : JSON.stringify(sent.body),
      };
      const result = await verifySignature(request, {
        provider: page.slug as Exclude<TemplateProvider, "discord">,
        secret: testSecret(page.slug),
        url,
        method: "POST",
      });
      expect(result.valid, page.slug).toBe(false);
    }
  });

  it("is valid TypeScript naming the provider, template, and secret env var", () => {
    const stripe = providerTestSnippet(getWebhookProviderPage("stripe")!)!;
    expect(stripe).toContain('provider: "stripe",');
    expect(stripe).toContain('template: "payment_intent.succeeded",');
    expect(stripe).toContain("process.env.STRIPE_WEBHOOK_SECRET!");
    expect(stripe).toContain('it("accepts a signed payment_intent.succeeded"');

    for (const page of withSnippet) {
      const snippet = providerTestSnippet(page)!;
      const { diagnostics } = ts.transpileModule(snippet, {
        reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      expect(diagnostics ?? [], page.slug).toEqual([]);
      expect(snippet, page.slug).toContain(`process.env.${providerSecretEnv(page.slug)}!`);
      expect(snippet, page.slug).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("names credentials the way the providers do", () => {
    expect(providerSecretEnv("twilio")).toBe("TWILIO_AUTH_TOKEN");
    expect(providerSecretEnv("slack")).toBe("SLACK_SIGNING_SECRET");
    expect(providerSecretEnv("coinbase-commerce")).toBe("COINBASE_COMMERCE_WEBHOOK_SECRET");
  });

  it("sends a body for providers without templates", () => {
    const snippet = providerTestSnippet(getWebhookProviderPage("standard-webhooks")!)!;
    expect(snippet).toContain('body: { type: "invoice.paid", data: { id: "inv_123" } },');
    expect(snippet).not.toContain("template:");
  });

  it("dates the pages that show it from when it arrived", () => {
    for (const page of withSnippet) {
      expect(page.lastModified.toISOString().slice(0, 10), page.slug).toBe(
        PROVIDER_TEST_SNIPPET_ADDED
      );
    }
  });
});
