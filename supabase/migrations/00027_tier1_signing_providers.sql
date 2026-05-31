-- ============================================================================
-- Migration 00027: Allow tier-1 signing providers
--
-- Extends the check_signing_config constraint (introduced in 00026) to accept
-- 7 additional named providers that reuse existing receiver verification
-- schemes:
--   - meta              (HMAC-SHA256, sha256= hex — GitHub scheme, app secret)
--   - lemonsqueezy      (HMAC-SHA256 raw hex)
--   - coinbase-commerce (HMAC-SHA256 raw hex)
--   - razorpay          (HMAC-SHA256 raw hex)
--   - cal               (HMAC-SHA256 raw hex)
--   - intercom          (HMAC-SHA1, sha1= hex)
--   - telegram          (raw secret-token compare — GitLab scheme)
--
-- Like every named provider, these require an encrypted secret and must not
-- retain a generic signing header.
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
        'telegram'
      )
      and signing_secret_encrypted is not null
      and signing_header is null
    )
  ) not valid;

alter table public.endpoints
  validate constraint check_signing_config;

notify pgrst, 'reload schema';
