import type { SimpleIcon } from "simple-icons";
import {
  siCaldotcom,
  siClerk,
  siCoinbase,
  siDiscord,
  siGithub,
  siGitlab,
  siHubspot,
  siIntercom,
  siLemonsqueezy,
  siLinear,
  siMailgun,
  siMeta,
  siPaddle,
  siRazorpay,
  siSentry,
  siShopify,
  siSquare,
  siStripe,
  siTelegram,
  siTypeform,
  siVercel,
} from "simple-icons";

import type { WebProviderIconGlyph } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

const SIMPLE_PROVIDER_ICONS: Partial<Record<WebProviderIconGlyph, SimpleIcon>> = {
  stripe: siStripe,
  github: siGithub,
  shopify: siShopify,
  paddle: siPaddle,
  linear: siLinear,
  clerk: siClerk,
  discord: siDiscord,
  vercel: siVercel,
  gitlab: siGitlab,
  typeform: siTypeform,
  meta: siMeta,
  lemonsqueezy: siLemonsqueezy,
  "coinbase-commerce": siCoinbase,
  razorpay: siRazorpay,
  cal: siCaldotcom,
  intercom: siIntercom,
  telegram: siTelegram,
  square: siSquare,
  hubspot: siHubspot,
  mailgun: siMailgun,
  sentry: siSentry,
};

export function ProviderIcon({
  glyph,
  fallbackText,
  className,
}: {
  glyph: WebProviderIconGlyph;
  fallbackText: string;
  className?: string;
}) {
  const simpleIcon = SIMPLE_PROVIDER_ICONS[glyph];

  if (simpleIcon) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={cn("h-3 w-3", className)}
        fill="currentColor"
      >
        <path d={simpleIcon.path} />
      </svg>
    );
  }

  if (glyph === "slack") {
    return <SlackGlyph className={className} />;
  }

  if (glyph === "twilio") {
    return <TwilioGlyph className={className} />;
  }

  if (glyph === "sendgrid") {
    return <SendGridGlyph className={className} />;
  }

  if (glyph === "standard-webhooks") {
    return <StandardWebhooksGlyph className={className} />;
  }

  if (glyph === "generic-hmac") {
    return <GenericHmacGlyph className={className} />;
  }

  return (
    <span className="font-mono text-[7px] font-black leading-none tracking-tighter">
      {fallbackText}
    </span>
  );
}

function SlackGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={cn("h-3.5 w-3.5", className)}>
      <rect width="5.2" height="10" x="4" y="2" rx="2.6" fill="#36c5f0" />
      <rect
        width="5.2"
        height="10"
        x="2"
        y="14.8"
        rx="2.6"
        transform="rotate(-90 2 14.8)"
        fill="#36c5f0"
      />
      <rect width="5.2" height="10" x="14.8" y="12" rx="2.6" fill="#ecb22e" />
      <rect
        width="5.2"
        height="10"
        x="12"
        y="9.2"
        rx="2.6"
        transform="rotate(-90 12 9.2)"
        fill="#ecb22e"
      />
      <rect width="5.2" height="10" x="4" y="12" rx="2.6" fill="#2eb67d" />
      <rect
        width="5.2"
        height="10"
        x="2"
        y="9.2"
        rx="2.6"
        transform="rotate(-90 2 9.2)"
        fill="#e01e5a"
      />
      <rect width="5.2" height="10" x="14.8" y="2" rx="2.6" fill="#e01e5a" />
      <rect
        width="5.2"
        height="10"
        x="12"
        y="14.8"
        rx="2.6"
        transform="rotate(-90 12 14.8)"
        fill="#2eb67d"
      />
    </svg>
  );
}

function TwilioGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="8.5" cy="8.5" r="1.9" fill="currentColor" />
      <circle cx="15.5" cy="8.5" r="1.9" fill="currentColor" />
      <circle cx="8.5" cy="15.5" r="1.9" fill="currentColor" />
      <circle cx="15.5" cy="15.5" r="1.9" fill="currentColor" />
    </svg>
  );
}

function SendGridGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={cn("h-3.5 w-3.5", className)}>
      <g fill="currentColor">
        <rect x="3" y="3" width="5" height="5" rx="1.1" opacity="0.95" />
        <rect x="9.5" y="3" width="5" height="5" rx="1.1" opacity="0.85" />
        <rect x="16" y="3" width="5" height="5" rx="1.1" opacity="0.7" />
        <rect x="3" y="9.5" width="5" height="5" rx="1.1" opacity="0.75" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="1.1" opacity="0.95" />
        <rect x="16" y="9.5" width="5" height="5" rx="1.1" opacity="0.85" />
        <rect x="3" y="16" width="5" height="5" rx="1.1" opacity="0.55" />
        <rect x="9.5" y="16" width="5" height="5" rx="1.1" opacity="0.75" />
        <rect x="16" y="16" width="5" height="5" rx="1.1" opacity="0.95" />
      </g>
    </svg>
  );
}

function StandardWebhooksGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
    >
      <path
        d="M7 7.5h3.6c2.4 0 3.9 1.5 3.9 3.7v1.6c0 2.2 1.5 3.7 3.8 3.7H20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.2"
      />
      <path
        d="M15 8.2 18.8 12 15 15.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
      <circle cx="5" cy="7.5" r="2.2" fill="currentColor" />
      <circle cx="5" cy="16.5" r="2.2" fill="currentColor" />
    </svg>
  );
}

function GenericHmacGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("h-3.5 w-3.5", className)}
      fill="none"
    >
      <path
        d="M12 3.5 19 6v5.5c0 4.3-2.8 7.4-7 9-4.2-1.6-7-4.7-7-9V6l7-2.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="10" cy="11" r="2.2" stroke="currentColor" strokeWidth="2" />
      <path
        d="m11.8 12.8 4 4M14 15l1.4-1.4M15.6 16.6 17 15.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}
