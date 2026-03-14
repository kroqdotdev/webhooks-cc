# Supabase Migration Security Review

Date: 2026-03-14
Scope: `main...supabase-migration`

## Executive Summary

The Supabase migration introduces three high-impact security regressions compared with `main`.

1. Anonymous Supabase clients can read and write `device_codes`, which lets an attacker mint API keys without logging in.
2. Anonymous Supabase clients can enumerate all guest `/go` endpoints and their captured requests, and can also create ownerless endpoints directly through the public database API.
3. Sensitive account and billing mutation routes accept long-lived API keys, which allows an API key to delete an account or change subscription state.

I verified the first two classes directly in the dev environment using the public anon key, and I verified the third by deleting a throwaway user account through `DELETE /api/account` using only an API key.

## Critical

### 1. Anonymous `device_codes` access enables API-key minting without login

- Severity: Critical
- Rule IDs: NEXT-SECRETS-002, NEXT-CSRF/AUTH boundary review, secure RLS least-privilege
- Locations:
  - [supabase/migrations/00001_initial_schema.sql](/home/sauer/cc/webhooks-cc/supabase/migrations/00001_initial_schema.sql#L249)
  - [apps/web/lib/supabase/device-auth.ts](/home/sauer/cc/webhooks-cc/apps/web/lib/supabase/device-auth.ts#L176)

Evidence:

```sql
create policy device_codes_select on public.device_codes
  for select using (true);

create policy device_codes_insert on public.device_codes
  for insert with check (true);
```

```ts
export async function claimDeviceCode(deviceCode: string): Promise<ClaimedDeviceCode> {
  const code = await findDeviceCodeByCode(deviceCode);
  ...
  if (code.status !== "authorized") {
    throw new Error("Code not yet authorized");
  }
  if (!code.user_id) {
    throw new Error("Code not properly authorized");
  }
  ...
  return {
    apiKey: rawKey,
    userId: code.user_id,
    email: user?.email ?? "",
  };
}
```

Impact:

- Any anonymous caller with the public anon key can read pending device codes directly from Supabase.
- Any anonymous caller can also insert an already-authorized `device_codes` row.
- With a known user UUID, that attacker can call `/api/auth/device-claim` and receive a fresh API key for that user without authenticating.

Proof:

- I created a throwaway user in dev.
- I inserted an `authorized` device-code row through the anon Supabase client.
- I called `/api/auth/device-claim` with that device code.
- The route returned `200` and minted an API key for the throwaway user.

Fix:

- Remove anonymous table access entirely for `device_codes`.
- Restrict reads and writes to `service_role` only.
- Keep polling and creation behind the existing Next.js API routes.
- Consider a dedicated RPC for polling status if you want DB-level access without full row visibility.

## High

### 2. Guest endpoint/request RLS allows anonymous global enumeration and direct endpoint creation

- Severity: High
- Rule IDs: least-privilege RLS, exposure of user data through public APIs
- Locations:
  - [supabase/migrations/00001_initial_schema.sql](/home/sauer/cc/webhooks-cc/supabase/migrations/00001_initial_schema.sql#L206)
  - [supabase/migrations/00001_initial_schema.sql](/home/sauer/cc/webhooks-cc/supabase/migrations/00001_initial_schema.sql#L225)
  - [apps/web/lib/go-dashboard.ts](/home/sauer/cc/webhooks-cc/apps/web/lib/go-dashboard.ts#L88)

Evidence:

```sql
create policy endpoints_select on public.endpoints
  for select using (
    is_ephemeral = true
    or user_id = auth.uid()
  );

create policy endpoints_insert on public.endpoints
  for insert with check (
    user_id is null
    or user_id = auth.uid()
  );

create policy requests_select on public.requests
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.endpoints e
      where e.id = endpoint_id and e.is_ephemeral = true
    )
  );
```

Impact:

- Any anonymous caller with the public anon key can list all ephemeral endpoints and all requests attached to them through Supabase REST.
- Anonymous callers can also insert ownerless endpoints directly, bypassing the `/api/go/endpoint` rate limits and the intended 12-hour TTL flow.
- That turns the public anon key into a global guest-data reader plus a storage-abuse entrypoint.

Proof:

- Using the anon Supabase client in dev, I successfully listed live ephemeral endpoint slugs and their captured requests.
- Using the anon Supabase client in dev, I successfully inserted a new endpoint row with `user_id = null`, `is_ephemeral = false`, and `expires_at = null`.

Fix:

- Do not expose guest endpoint/request tables directly through generic RLS.
- Move guest reads behind narrow server routes keyed by the stored demo slug.
- Tighten `endpoints_insert` so anonymous callers cannot insert directly, or at minimum require `is_ephemeral = true` and a bounded `expires_at`.
- Tighten `requests_select` so anonymous access is scoped to a server-mediated slug check rather than “all ephemeral rows.”

### 3. Account and billing mutation routes accept API keys

- Severity: High
- Rule IDs: privilege separation, token scope minimization
- Locations:
  - [apps/web/lib/api-auth.ts](/home/sauer/cc/webhooks-cc/apps/web/lib/api-auth.ts#L68)
  - [apps/web/app/api/account/route.ts](/home/sauer/cc/webhooks-cc/apps/web/app/api/account/route.ts#L4)
  - [apps/web/app/api/billing/checkout/route.ts](/home/sauer/cc/webhooks-cc/apps/web/app/api/billing/checkout/route.ts#L5)
  - [apps/web/app/api/billing/cancel/route.ts](/home/sauer/cc/webhooks-cc/apps/web/app/api/billing/cancel/route.ts#L5)
  - [apps/web/app/api/billing/resubscribe/route.ts](/home/sauer/cc/webhooks-cc/apps/web/app/api/billing/resubscribe/route.ts#L5)

Evidence:

```ts
export async function validateBearerTokenWithPlan(
  token: string
): Promise<ApiKeyValidation | null> {
  if (token.startsWith("whcc_")) {
    return await validateApiKeyWithMetadata(token);
  }
  return await validateSupabaseSessionWithPlan(token);
}
```

```ts
export async function DELETE(request: Request) {
  const auth = await authenticateRequest(request);
  ...
  await deleteAccountForUser(auth.userId);
}
```

Impact:

- A long-lived API key is enough to delete the entire account.
- The same token class can also start checkout, cancel a subscription, or reverse a scheduled cancellation.
- That is a scope escalation from “API access to endpoints/requests” into “full account administration.”

Proof:

- I created a throwaway user and API key in dev.
- I called `DELETE /api/account` with only that API key in `Authorization`.
- The route returned `200`, and the throwaway user was deleted.

Fix:

- Split auth helpers by token type.
- Require a Supabase session token for account/billing mutations.
- Reserve API keys for CLI/SDK resource operations only.

## Notes

- I also reviewed a few lower-confidence areas like OAuth callback redirect handling and draft blog previews. I did not include them here because the three findings above were the clearest high-impact regressions I could prove against the migrated branch.
