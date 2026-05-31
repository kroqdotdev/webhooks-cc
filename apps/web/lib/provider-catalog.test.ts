import { TEMPLATE_PROVIDERS, VERIFY_PROVIDERS } from "@webhooks-cc/sdk";
import { describe, expect, test } from "vitest";

import {
  getWebProviderInfo,
  getWebProviderLabel,
  WEB_TEMPLATE_PROVIDER_OPTIONS,
  WEB_VERIFICATION_PROVIDER_OPTIONS,
} from "./provider-catalog";

describe("provider-catalog", () => {
  test("keeps template providers in the shared SDK order", () => {
    // Source of truth is the SDK's TEMPLATE_PROVIDERS array; the web option list
    // must be a faithful 1:1 projection of it (same members, same order).
    expect(WEB_TEMPLATE_PROVIDER_OPTIONS.map((provider) => provider.id)).toEqual([
      ...TEMPLATE_PROVIDERS,
    ]);
  });

  test("lists only verification-capable providers plus generic hmac", () => {
    // Verification options mirror the SDK's VERIFY_PROVIDERS (which omits
    // unsupported providers like SendGrid) with generic-hmac appended.
    expect(WEB_VERIFICATION_PROVIDER_OPTIONS.map((provider) => provider.id)).toEqual([
      ...VERIFY_PROVIDERS,
      "generic-hmac",
    ]);
  });

  test("returns provider-specific UI metadata", () => {
    expect(getWebProviderInfo("discord")).toMatchObject({
      label: "Discord",
      icon: { glyph: "discord", text: "DC" },
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
      icon: { glyph: "generic-hmac", text: "HM" },
      verificationMode: "secret",
    });
  });

  test("assigns drawable glyphs for every visible provider badge", () => {
    const visibleProviders = [
      ...WEB_TEMPLATE_PROVIDER_OPTIONS.map((provider) => provider.id),
      "generic-hmac",
    ];

    for (const provider of visibleProviders) {
      const providerInfo = getWebProviderInfo(provider);

      expect(providerInfo?.icon.glyph).toBe(provider);
      // Glyph badges use 2-3 uppercase letters (e.g. "ST", "CAL", "MUX").
      expect(providerInfo?.icon.text).toMatch(/^[A-Z]{2,3}$/);
    }
  });

  test("returns labels for known providers and null for unknown ones", () => {
    expect(getWebProviderLabel("standard-webhooks")).toBe("Standard Webhooks");
    expect(getWebProviderLabel("missing-provider")).toBeNull();
  });
});
