import {
  TEMPLATE_METADATA,
  TEMPLATE_PROVIDERS,
  VERIFY_PROVIDERS,
  type TemplateProvider,
} from "@webhooks-cc/sdk";

export type WebProviderId = TemplateProvider | "generic-hmac";

export type WebProviderIconGlyph = WebProviderId;

export interface WebProviderIcon {
  glyph: WebProviderIconGlyph;
  text: string;
  background: string;
  foreground: string;
  border: string;
}

export interface WebProviderInfo {
  label: string;
  icon: WebProviderIcon;
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
  meta: "Meta",
  lemonsqueezy: "Lemon Squeezy",
  "coinbase-commerce": "Coinbase Commerce",
  razorpay: "Razorpay",
  cal: "Cal.com",
  intercom: "Intercom",
  telegram: "Telegram",
  square: "Square",
  hubspot: "HubSpot",
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
  meta: "your app secret",
  lemonsqueezy: "your signing secret",
  "coinbase-commerce": "your shared webhook secret",
  razorpay: "your webhook secret",
  cal: "your webhook secret",
  intercom: "your Intercom client secret",
  telegram: "your secret token",
  square: "your signature key",
  hubspot: "your app client secret",
};

const PROVIDER_ICONS: Record<TemplateProvider, WebProviderIcon> = {
  stripe: {
    glyph: "stripe",
    text: "ST",
    background: "#635bff",
    foreground: "#ffffff",
    border: "#4f46e5",
  },
  github: {
    glyph: "github",
    text: "GH",
    background: "#24292f",
    foreground: "#ffffff",
    border: "#111827",
  },
  shopify: {
    glyph: "shopify",
    text: "SH",
    background: "#95bf47",
    foreground: "#17210b",
    border: "#5e8e3e",
  },
  twilio: {
    glyph: "twilio",
    text: "TW",
    background: "#f22f46",
    foreground: "#ffffff",
    border: "#b91c1c",
  },
  slack: {
    glyph: "slack",
    text: "SL",
    background: "#f8fafc",
    foreground: "#111827",
    border: "#cbd5e1",
  },
  paddle: {
    glyph: "paddle",
    text: "PD",
    background: "#4b28ff",
    foreground: "#ffffff",
    border: "#3217b8",
  },
  linear: {
    glyph: "linear",
    text: "LN",
    background: "#5e6ad2",
    foreground: "#ffffff",
    border: "#4338ca",
  },
  sendgrid: {
    glyph: "sendgrid",
    text: "SG",
    background: "#1a82e2",
    foreground: "#ffffff",
    border: "#075985",
  },
  clerk: {
    glyph: "clerk",
    text: "CK",
    background: "#6c47ff",
    foreground: "#ffffff",
    border: "#4c1d95",
  },
  discord: {
    glyph: "discord",
    text: "DC",
    background: "#5865f2",
    foreground: "#ffffff",
    border: "#3730a3",
  },
  vercel: {
    glyph: "vercel",
    text: "VC",
    background: "#111111",
    foreground: "#ffffff",
    border: "#000000",
  },
  gitlab: {
    glyph: "gitlab",
    text: "GL",
    background: "#fc6d26",
    foreground: "#111827",
    border: "#c2410c",
  },
  typeform: {
    glyph: "typeform",
    text: "TF",
    background: "#111111",
    foreground: "#ffffff",
    border: "#facc15",
  },
  "standard-webhooks": {
    glyph: "standard-webhooks",
    text: "SW",
    background: "#f8fafc",
    foreground: "#0f172a",
    border: "#64748b",
  },
  meta: {
    glyph: "meta",
    text: "MA",
    background: "#0866ff",
    foreground: "#ffffff",
    border: "#0a4fc2",
  },
  lemonsqueezy: {
    glyph: "lemonsqueezy",
    text: "LS",
    background: "#ffc233",
    foreground: "#0b0b0b",
    border: "#d9a400",
  },
  "coinbase-commerce": {
    glyph: "coinbase-commerce",
    text: "CB",
    background: "#0052ff",
    foreground: "#ffffff",
    border: "#003bb3",
  },
  razorpay: {
    glyph: "razorpay",
    text: "RP",
    background: "#0c2451",
    foreground: "#ffffff",
    border: "#3395ff",
  },
  cal: {
    glyph: "cal",
    text: "CAL",
    background: "#111827",
    foreground: "#ffffff",
    border: "#000000",
  },
  intercom: {
    glyph: "intercom",
    text: "IC",
    background: "#1f8ded",
    foreground: "#ffffff",
    border: "#0b5cad",
  },
  telegram: {
    glyph: "telegram",
    text: "TG",
    background: "#229ed9",
    foreground: "#ffffff",
    border: "#1a7fb0",
  },
  square: {
    glyph: "square",
    text: "SQ",
    background: "#000000",
    foreground: "#ffffff",
    border: "#3d3d3d",
  },
  hubspot: {
    glyph: "hubspot",
    text: "HS",
    background: "#ff7a59",
    foreground: "#ffffff",
    border: "#e35c3a",
  },
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
          icon: PROVIDER_ICONS[provider],
          algorithm: provider === "discord" ? "Ed25519" : formatAlgorithm(signatureAlgorithm),
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
    icon: {
      glyph: "generic-hmac",
      text: "HM",
      background: "#f59e0b",
      foreground: "#111827",
      border: "#92400e",
    },
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
