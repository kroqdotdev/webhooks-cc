-- ============================================================================
-- Migration 00046: Allow the Resend and WorkOS signing providers
--
-- Extends the check_signing_config constraint (last updated in 00032) with
-- two server-verifiable named providers:
--   - resend (Svix: HMAC-SHA256 base64 over `{svix-id}.{svix-timestamp}.{body}`,
--             keyed with the base64-decoded whsec_ secret)
--   - workos (HMAC-SHA256 hex over `{t}.{body}` from the
--             `workos-signature: t=<ms>, v1=<hex>` header)
--
-- Run outside a transaction (plain psql autocommit), like 00032: the NOT VALID
-- add and the separate VALIDATE keep the lock on endpoints short.
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
        'paypal',
        'resend',
        'workos'
      )
      and signing_secret_encrypted is not null
      and signing_header is null
    )
  ) not valid;

alter table public.endpoints
  validate constraint check_signing_config;

notify pgrst, 'reload schema';
