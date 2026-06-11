-- ============================================================================
-- Migration 00032: Allow tier-3 signing providers
--
-- Extends the check_signing_config constraint (last updated in 00028) to
-- accept three additional server-verifiable named providers:
--   - docusign (HMAC-SHA256 base64 over raw body)
--   - adyen    (HMAC-SHA256 base64 over standard notification fields; body)
--   - paypal   (RSA-SHA256 with PayPal certificate fetch; secret stores webhook ID)
--
-- Plaid is intentionally omitted: Plaid-Verification is JWT/JWK based and
-- requires Plaid API credentials, so it remains template/detection-only.
-- ============================================================================

alter table public.endpoints
  drop constraint if exists check_signing_config;

alter table public.endpoints
  add constraint check_signing_config
  check (
    (
      signing_provider is null
      and signing_secret_encrypted is null
      and signing_header is null
    )
    or (
      signing_provider = 'generic-hmac'
      and signing_secret_encrypted is not null
      and signing_header is not null
      and length(signing_header) <= 256
      and signing_header ~ '^[A-Za-z0-9_-]+$'
    )
    or (
      signing_provider in (
        'stripe',
        'github',
        'shopify',
        'twilio',
        'slack',
        'paddle',
        'linear',
        'clerk',
        'discord',
        'vercel',
        'gitlab',
        'typeform',
        'standard-webhooks',
        'meta',
        'lemonsqueezy',
        'coinbase-commerce',
        'razorpay',
        'cal',
        'intercom',
        'telegram',
        'square',
        'hubspot',
        'mailgun',
        'calendly',
        'mux',
        'sentry',
        'bitbucket',
        'docusign',
        'adyen',
        'paypal'
      )
      and signing_secret_encrypted is not null
      and signing_header is null
    )
  ) not valid;

alter table public.endpoints
  validate constraint check_signing_config;

notify pgrst, 'reload schema';
