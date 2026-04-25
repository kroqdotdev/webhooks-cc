import { describe, expect, test } from "vitest";

import {
  getWebProviderInfo,
  getWebProviderLabel,
  WEB_TEMPLATE_PROVIDER_OPTIONS,
  WEB_VERIFICATION_PROVIDER_OPTIONS,
} from "./provider-catalog";

describe("provider-catalog", () => {
  test("keeps template providers in the shared SDK order", () => {
    expect(WEB_TEMPLATE_PROVIDER_OPTIONS.map((provider) => provider.id)).toEqual([
      "stripe",
      "github",
      "shopify",
      "twilio",
      "slack",
      "paddle",
      "linear",
      "sendgrid",
      "clerk",
      "discord",
      "vercel",
      "gitlab",
      "typeform",
      "standard-webhooks",
    ]);
  });

  test("lists only verification-capable providers plus generic hmac", () => {
    expect(WEB_VERIFICATION_PROVIDER_OPTIONS.map((provider) => provider.id)).toEqual([
      "stripe",
      "github",
      "shopify",
      "twilio",
      "slack",
      "paddle",
      "linear",
      "clerk",
      "discord",
      "vercel",
      "gitlab",
      "typeform",
      "standard-webhooks",
      "generic-hmac",
    ]);
  });

  test("returns provider-specific UI metadata", () => {
    expect(getWebProviderInfo("discord")).toMatchObject({
      label: "Discord",
      algorithm: "Ed25519",
      header: "x-signature-ed25519",
      verificationMode: "publicKey",
    });
    expect(getWebProviderInfo("sendgrid")).toMatchObject({
      label: "SendGrid",
      algorithm: "Not applicable",
      verificationMode: "unsupported",
    });
    expect(getWebProviderInfo("generic-hmac")).toMatchObject({
      label: "Generic HMAC",
      verificationMode: "secret",
    });
  });

  test("returns labels for known providers and null for unknown ones", () => {
    expect(getWebProviderLabel("standard-webhooks")).toBe("Standard Webhooks");
    expect(getWebProviderLabel("missing-provider")).toBeNull();
  });
});
