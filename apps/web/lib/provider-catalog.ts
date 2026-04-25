import {
  TEMPLATE_METADATA,
  TEMPLATE_PROVIDERS,
  VERIFY_PROVIDERS,
  type TemplateProvider,
} from "@webhooks-cc/sdk";

export type WebProviderId = TemplateProvider | "generic-hmac";

export interface WebProviderInfo {
  label: string;
  algorithm: string;
  header: string;
  secretPlaceholder: string;
  verificationMode: "secret" | "publicKey" | "unsupported";
}

const PROVIDER_LABELS: Record<TemplateProvider, string> = {
  stripe: "Stripe",
  github: "GitHub",
  shopify: "Shopify",
  twilio: "Twilio",
  slack: "Slack",
  paddle: "Paddle",
  linear: "Linear",
  sendgrid: "SendGrid",
  clerk: "Clerk",
  discord: "Discord",
  vercel: "Vercel",
  gitlab: "GitLab",
  typeform: "Typeform",
  "standard-webhooks": "Standard Webhooks",
};

const SECRET_PLACEHOLDERS: Record<TemplateProvider, string> = {
  stripe: "whsec_...",
  github: "your webhook secret",
  shopify: "your Shopify secret",
  twilio: "your auth token",
  slack: "your signing secret",
  paddle: "your webhook secret",
  linear: "your webhook secret",
  sendgrid: "",
  clerk: "whsec_...",
  discord: "your application public key",
  vercel: "your webhook secret",
  gitlab: "your secret token",
  typeform: "your webhook secret",
  "standard-webhooks": "whsec_...",
};

function formatAlgorithm(value: string | undefined): string {
  if (!value) {
    return "Not applicable";
  }

  if (value === "hmac-sha256") return "HMAC-SHA256";
  if (value === "hmac-sha1") return "HMAC-SHA1";
  if (value === "token") return "Token";
  return value;
}

export const WEB_PROVIDER_CATALOG: Record<WebProviderId, WebProviderInfo> = {
  ...Object.fromEntries(
    TEMPLATE_PROVIDERS.map((provider) => {
      const metadata = TEMPLATE_METADATA[provider];
      const signatureAlgorithm =
        "signatureAlgorithm" in metadata ? metadata.signatureAlgorithm : undefined;
      const signatureHeader = "signatureHeader" in metadata ? metadata.signatureHeader : undefined;

      return [
        provider,
        {
          label: PROVIDER_LABELS[provider],
          algorithm:
            provider === "discord" ? "Ed25519" : formatAlgorithm(signatureAlgorithm),
          header: provider === "discord" ? "x-signature-ed25519" : (signatureHeader ?? ""),
          secretPlaceholder: SECRET_PLACEHOLDERS[provider],
          verificationMode:
            provider === "sendgrid"
              ? "unsupported"
              : provider === "discord"
                ? "publicKey"
                : "secret",
        },
      ];
    })
  ),
  "generic-hmac": {
    label: "Generic HMAC",
    algorithm: "HMAC-SHA256",
    header: "",
    secretPlaceholder: "your shared secret",
    verificationMode: "secret",
  },
} as Record<WebProviderId, WebProviderInfo>;

export interface WebProviderOption<T extends string = string> {
  id: T;
  label: string;
}

export const WEB_TEMPLATE_PROVIDER_OPTIONS: readonly WebProviderOption<TemplateProvider>[] =
  TEMPLATE_PROVIDERS.map((provider) => ({
    id: provider,
    label:
      provider === "sendgrid"
        ? `${PROVIDER_LABELS[provider]} template`
        : provider === "discord"
          ? `${PROVIDER_LABELS[provider]} template`
          : provider === "gitlab"
            ? `${PROVIDER_LABELS[provider]} template (token)`
            : `${PROVIDER_LABELS[provider]} template (signed)`,
  }));

export const WEB_VERIFICATION_PROVIDER_OPTIONS: readonly WebProviderOption<WebProviderId>[] = [
  ...VERIFY_PROVIDERS.map((provider) => ({
    id: provider,
    label: PROVIDER_LABELS[provider],
  })),
  {
    id: "generic-hmac",
    label: "Generic HMAC",
  },
];

export function getWebProviderInfo(provider: string | null | undefined): WebProviderInfo | null {
  if (!provider) {
    return null;
  }

  return WEB_PROVIDER_CATALOG[provider as WebProviderId] ?? null;
}

export function getWebProviderLabel(provider: string | null | undefined): string | null {
  return getWebProviderInfo(provider)?.label ?? null;
}
