# GoTrue configuration for email/password auth

The web app's email/password sign-in (login page form, `/auth/confirm`,
`/auth/reset-password`, the password panel on `/account`) needs nothing in the app's own env. Everything that
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
      GOTRUE_MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION: https://webhooks.cc/email-templates/password-changed.html
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: Confirm your webhooks.cc account
      GOTRUE_MAILER_SUBJECTS_RECOVERY: Reset your webhooks.cc password
      GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION: Your webhooks.cc password was changed
      GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true"
      GOTRUE_HOOK_BEFORE_USER_CREATED_URI: pg-functions://postgres/public/hook_before_user_created
      GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD: "true"
      GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED: "true"
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
      GOTRUE_MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION: http://host.docker.internal:3000/email-templates/password-changed.html
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: Confirm your webhooks.cc account
      GOTRUE_MAILER_SUBJECTS_RECOVERY: Reset your webhooks.cc password
      GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION: Your webhooks.cc password was changed
      GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true"
      GOTRUE_HOOK_BEFORE_USER_CREATED_URI: pg-functions://postgres/public/hook_before_user_created
      GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD: "true"
      GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED: "true"
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

### Before-user-created hook

The two `GOTRUE_HOOK_BEFORE_USER_CREATED_*` lines make GoTrue call
`public.hook_before_user_created()` (migration `00052`) before it creates any
user through signup, OAuth (GitHub, Google), magic link or OTP, invite, or
anonymous sign-in. It refuses addresses at the capture domain
(`mailhooks.cc` and its subdomains) with a 403: mail there can be read
through webhooks.cc itself, so such an address would let one endpoint
confirm any number of accounts. The admin API (`auth.admin.createUser`) does
not call the hook; agent registration, its only user here, checks the
domain in the app. Existing users and email changes are not affected.

**Apply migration 00052 before adding these lines.** While the function is
missing, GoTrue fails every signup with a 500. Before enabling, check that
`supabase_auth_admin` can reach the function:

```sql
select has_schema_privilege('supabase_auth_admin', 'public', 'USAGE'),
       has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'EXECUTE');
-- expect: t | t
```

Recreate only `auth` (`docker compose up -d --no-deps auth`) and watch its
log: a malformed hook URI stops GoTrue from starting at all, which takes
down every sign-in, not only signups. To roll back, remove the two lines
(or set `..._ENABLED` to `"false"`) and recreate `auth` again; never drop the
function while the hook is on.

### Current password on password change

`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` makes GoTrue refuse
a new password from a password session unless the request carries the
correct `current_password` (`current_password_required`,
`current_password_invalid`). The account page's password panel sends it,
but the check has to live in GoTrue: `PUT /auth/v1/user` is reachable with
any session's access token, so a check in the app could be skipped.

**Do not deploy a web release with the panel to an instance until its
`auth` container runs GoTrue v2.189.0 or later with this setting on.**
v2.187.0 added the setting and v2.189.0 extended the email-link exemption
to PKCE recovery sessions; older versions, and any version without the
line, ignore `current_password`, so the holder of a password session could
change the password without knowing it. Neither case warns. After
recreating `auth`, check both:

```bash
docker inspect supabase-auth --format '{{.Config.Image}}'   # v2.189.0 or later
docker exec supabase-auth env | grep REQUIRE_CURRENT_PASSWORD   # =true
```

Sessions that began with an email link (recovery, signup confirmation,
magic link or OTP, which `/auth/confirm` and the agent claim produce) are
exempt for their whole lifetime, token refreshes included. That is what
keeps `/auth/reset-password` and the panel's "Email me a reset link"
working, and it means the check only binds sessions that began with a
password sign-in. Accounts created by agent registration rely on it too:
`admin.createUser` without a password gets a random one from GoTrue that
nobody knows, so they sign in with email codes, and the panel lets them
leave the field empty. Every successful change ends the account's other
sessions.

### Password-changed email

`GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED` makes GoTrue email the
account after every password change made through `PUT /auth/v1/user` (the
account page's panel and `/auth/reset-password`), so an owner hears about a
change they did not make. It goes out from `SMTP_ADMIN_EMAIL`
(`noreply@webhooks.cc`) like the other auth mail, with the
`password-changed.html` template. GoTrue gives the template `{{ .Email }}`,
`{{ .SiteURL }}` and `{{ .Data }}`; leave `.Data` unused, because it is user
metadata the user can write. It needs GoTrue v2.190.0 or later, a higher
floor than the current-password check: earlier versions do not pass
`.SiteURL` to this template, so its links would come out without a host. The template has no link that signs anyone in,
and it points out that API keys, CLI logins and connected agents outlive a
password change and a reset, which end only browser sessions. The send
happens inside the request but never fails it: an SMTP error or the
instance-wide `RATE_LIMIT_EMAIL_SENT` budget (30 an hour unless set) only
logs a warning. That budget is shared with confirmation and reset email, and
a run of `tests/integration/supabase-email-auth.test.ts` spends about five of
it, so raise it in the dev `.env` if repeated runs start failing at the SMTP
step. It is not subject to `SMTP_MAX_FREQUENCY`, so it still arrives right
after a reset email. Every change is also recorded in `public.audit_events` by a trigger
on `auth.users` (migration 00061), whichever path made it.

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

GoTrue caches fetched templates in an in-process worker. If the template
host was unreachable when auth started, run `docker restart supabase-auth`
so the next email picks them up; a failed fetch otherwise sticks to the
default template until the worker refreshes. When the template files in
`apps/web/public/email-templates/` change, deploy the web app **first**
(on prod; the dev server serves `public/` live) and only
then restart auth, otherwise GoTrue re-caches the previous build's templates.

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

# the capture domain is refused before any user or email is created
curl -s -H "apikey: <anon>" -H "Content-Type: application/json" \
  -d '{"email":"cfg-check@mailhooks.cc","password":"a-valid-password"}' <api url>/auth/v1/signup
# expect: {"code":403,"error_code":"unknown","msg":"Addresses at mailhooks.cc cannot be used for an account. ..."}

# the hook ran (one line per signup attempt)
docker logs supabase-auth --since 5m | grep run_hook
```

Delete the `cfg-check` auth user afterwards (Studio, or
`DELETE <api url>/auth/v1/admin/users/<id>` with the service role key).

Not configured on purpose: CAPTCHA, MFA, magic links, email change, and
rate-limit tuning. GoTrue's built-in email rate limits plus
`SMTP_MAX_FREQUENCY` (one email per minute per address by default) are the
current backstop against signup-form abuse.
