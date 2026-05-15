-- ============================================================================
-- Migration 00026: Harden signing configuration invariants
--
-- Prevent silent verification failures caused by partial or stale endpoint
-- signing config:
--   - provider null means no encrypted secret/header remains
--   - generic-hmac requires a valid custom header
--   - named providers must not retain a stale generic header
--   - sendgrid is a template provider only; it uses IP allowlisting, not signing
-- ============================================================================

update public.endpoints
   set signing_provider = null,
       signing_secret_encrypted = null,
       signing_header = null
 where (
      signing_provider is null
      and (signing_secret_encrypted is not null or signing_header is not null)
    )
    or signing_provider not in (
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
      'generic-hmac'
    )
    or (
      signing_provider = 'generic-hmac'
      and (
        signing_secret_encrypted is null
        or signing_header is null
        or length(signing_header) > 256
        or signing_header !~ '^[A-Za-z0-9_-]+$'
      )
    );

update public.endpoints
   set signing_header = null
 where signing_provider is not null
   and signing_provider <> 'generic-hmac'
   and signing_header is not null;

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
        'standard-webhooks'
      )
      and signing_secret_encrypted is not null
      and signing_header is null
    )
  ) not valid;

alter table public.endpoints
  validate constraint check_signing_config;

notify pgrst, 'reload schema';
