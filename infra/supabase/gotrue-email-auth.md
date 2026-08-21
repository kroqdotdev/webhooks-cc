# GoTrue configuration for email/password auth

The web app's email/password sign-in (login page form, `/auth/confirm`,
`/auth/reset-password`) needs nothing in the app's own env. Everything that
enables it lives on the self-hosted Supabase instance: real SMTP, a password
minimum length, and custom email templates that link back to the app instead
of GoTrue's `/auth/v1/verify` endpoint. This file is the operator reference
for reproducing that on any instance (dev or prod). No secrets here, only the
keys and their shape.

Verified against `supabase/gotrue:v2.186.0` started from the upstream
`docker/docker-compose.yml` of the self-hosted Supabase repo.

## 1. `.env` (the compose project's env file)

The upstream compose maps these into the `auth` container; only the SMTP
block needs changing from the stock values:

```bash
ENABLE_EMAIL_SIGNUP=true          # already true upstream
ENABLE_EMAIL_AUTOCONFIRM=false    # already false upstream; verification required
SITE_URL=<app origin>             # e.g. https://webhooks.cc (used as {{ .SiteURL }} in templates)

SMTP_ADMIN_EMAIL=noreply@webhooks.cc
SMTP_HOST=<smtp host>             # prod: the same SMTP host the web app uses (SMTP_HOST in .env.local)
SMTP_PORT=<smtp port>             # prod: 587 (STARTTLS)
SMTP_USER=<smtp user>             # prod: same as the web app's SMTP_USER; dev (Inbucket): empty
SMTP_PASS=<smtp pass>             # prod: same as the web app's SMTP_PASS; dev (Inbucket): empty
SMTP_SENDER_NAME=webhooks.cc
```

Deliverability on prod is already proven for this host/user pair: team invite
emails and agent OTP emails send through it from the web app.

## 2. `docker-compose.override.yml` (next to `docker-compose.yml`)

Docker Compose auto-loads `docker-compose.override.yml` only when the stack is
run with a plain `docker compose ...` invocation (no `-f`). Confirm that before
relying on it:

```bash
docker inspect supabase-auth --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
# expect: <dir>/docker-compose.yml   (a single plain file)
```

Production override (no `extra_hosts`, templates served by the live app):

```yaml
services:
  auth:
    environment:
      GOTRUE_PASSWORD_MIN_LENGTH: "8"
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: https://webhooks.cc/email-templates/confirm.html
      GOTRUE_MAILER_TEMPLATES_RECOVERY: https://webhooks.cc/email-templates/recovery.html
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: Confirm your webhooks.cc account
      GOTRUE_MAILER_SUBJECTS_RECOVERY: Reset your webhooks.cc password
```

Dev override (templates fetched from the Next dev server on the Docker host,
plus an Inbucket mail catcher):

```yaml
services:
  auth:
    environment:
      GOTRUE_PASSWORD_MIN_LENGTH: "8"
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: http://host.docker.internal:3000/email-templates/confirm.html
      GOTRUE_MAILER_TEMPLATES_RECOVERY: http://host.docker.internal:3000/email-templates/recovery.html
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: Confirm your webhooks.cc account
      GOTRUE_MAILER_SUBJECTS_RECOVERY: Reset your webhooks.cc password
    extra_hosts:
      - host.docker.internal:host-gateway

  mail:
    container_name: supabase-mail
    image: inbucket/inbucket:3.0.3
    restart: unless-stopped
    ports:
      - "2500:2500" # SMTP (matches SMTP_HOST=supabase-mail / SMTP_PORT=2500 in .env)
      - "9000:9000" # web UI: http://localhost:9000
```

Under colima, `host-gateway` resolves to the Mac host (192.168.5.2), so the
Next dev server must listen on all interfaces (the default for `next dev`).

The upstream repo also defines an Inbucket `mail` service in
`dev/docker-compose.dev.yml`. Do **not** attach that overlay with a bare
`up -d`: its `db` service replaces the named data volume with an anonymous one
("always use a fresh database when developing") and recreating `db` would wipe
the dev database. Defining `mail` in the override, as above, avoids the overlay
entirely.

## 3. Apply

```bash
cd <compose dir>
docker compose up -d auth          # add `mail` on dev
docker logs supabase-auth --since 2m   # clean start, no config errors
curl -s -H "apikey: <anon key>" <api url>/auth/v1/settings | jq '.external.email, .mailer_autoconfirm'
# expect: true / false
```

`up -d auth` recreates only the auth container; the rest of the stack is
untouched. Env changes in `.env` also need this recreate to take effect.

## 4. Template fetch and fallback behavior

GoTrue fetches the template URLs at send time (with an in-process cache
worker). If the fetch fails (app down, 404, connection refused) it logs
`templatemailer_template_body_http_error` and sends its **default** template
(and default subject) instead. The default link still goes through
`/auth/v1/verify` and confirms the address server-side, so signups never
break; the user just lands on the app without a session and signs in
manually. In other words, a template-hosting outage degrades the handoff
rather than blocking signups.

The app's templates (`apps/web/public/email-templates/*.html`) link to
`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=...`, which
the `/auth/confirm` route handler verifies server-side via `verifyOtp` and
then sets session cookies. That is the supported pattern for `@supabase/ssr`
(PKCE, cookie sessions): tokens never travel in a URL fragment and the link
works in any browser, not only the one that started the flow.

## 5. Checks after any change

```bash
# min length enforced at the instance (the login form mirrors it client-side)
curl -s -H "apikey: <anon>" -H "Content-Type: application/json" \
  -d '{"email":"cfg-check@webhooks-test.local","password":"short"}' <api url>/auth/v1/signup
# expect: {"code":422,"error_code":"weak_password",...}

# a real signup sends mail (dev: visible at http://localhost:9000, mailbox "cfg-check")
curl -s -H "apikey: <anon>" -H "Content-Type: application/json" \
  -d '{"email":"cfg-check@webhooks-test.local","password":"a-valid-password"}' <api url>/auth/v1/signup
```

Delete the `cfg-check` auth user afterwards (Studio, or
`DELETE <api url>/auth/v1/admin/users/<id>` with the service role key).

Not configured on purpose: CAPTCHA, MFA, magic links, email change, and
rate-limit tuning. GoTrue's built-in email rate limits plus
`SMTP_MAX_FREQUENCY` (one email per minute per address by default) are the
current backstop against signup-form abuse.
