-- ============================================================================
-- Migration 00028: Allow tier-2 signing providers
--
-- Extends the check_signing_config constraint (introduced in 00026, last
-- updated in 00027) to accept 7 additional named providers:
--   - square    (HMAC-SHA256 base64 over notificationURL + body)
--   - hubspot   (HMAC-SHA256 base64 over method + uri + body + timestamp)
--   - mailgun   (HMAC-SHA256 hex over timestamp + token; signature in body)
--   - calendly  (HMAC-SHA256 hex, Stripe-style t=,v1= header)
--   - mux       (HMAC-SHA256 hex, Stripe-style t=,v1= header)
--   - sentry    (HMAC-SHA256 raw hex over body)
--   - bitbucket (HMAC-SHA256, sha256= hex — GitHub scheme, on x-hub-signature)
--
-- Like every named provider, these require an encrypted secret and must not
-- retain a generic signing header. Mailgun carries its signature in the body
-- (no signing header), so it fits the named-provider branch exactly.
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
        'bitbucket'
      )
      and signing_secret_encrypted is not null
      and signing_header is null
    )
  ) not valid;

alter table public.endpoints
  validate constraint check_signing_config;

notify pgrst, 'reload schema';
