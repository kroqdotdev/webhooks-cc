# Email

Every endpoint on an account receives mail at `<slug>@mailhooks.cc` and
`<slug>+<tag>@mailhooks.cc` for any tag. Sandbox and guest endpoints get no
email. An email is a captured request (`kind: "email"`) and counts against
the same quota. Messages over 10 MB are refused. `mailhooks.cc` only
receives; it never sends.

## Signup, magic-link and code emails

1. Use `<slug>+<run-id>@mailhooks.cc` in the form, so parallel runs find
   their own mail.
2. `wait_for_email` with `endpointSlug` and that `tag` (and `subject` or
   `from` if useful). It returns the email with its one-time `code` and main
   `link` already found.
3. `list_emails` and `get_email` read what arrived; `send_test_email` delivers
   a sample with a code and a link, to check a flow without a real sender.

From the CLI: `whk wait <slug> --kind email --since now`.

## Named fields

For other values (an order number, an amount, a token in an odd place),
`update_endpoint` with `emailFields`: each a `name`, where it reads (`from`:
subject, text, html, from, to, or header with `header`) and an RE2 `pattern`
whose first group is the value. `get_email` returns them as `fields`, and the
reply without its quoted part as `replyText`. Try fields on a captured email
first with `preview_email_fields` (or `whk fields preview <slug>`).

## Layouts: different senders, line items, attachments

When one endpoint gets several kinds of mail, give it `layouts` (with
`update_endpoint`). The first layout whose `match` conditions hold applies
its `fields`, `lineItems` (an RE2 pattern with named groups over the text, or
a spreadsheet attachment's columns) and `parseAttachments` (CSV, TSV, XLSX,
XLS, ODS, PDF text, text). The result is `parsed` on the email, and
deliveries wait for it.

- `preview_layouts` with draft `layouts` and a `requestId` shows what matches
  and what it finds, without saving or using pages.
- `list_layout_templates` and `add_layout_template` add ready-made layouts
  (Shopify, WooCommerce, Etsy orders, payments, bookings and more); CLI
  `whk layouts templates` and `whk layouts add-template`.
- Free and Pro match 2 layouts per endpoint, Business 50. Attachment parsing
  uses parsed pages (Free 20 a month, Pro 100, Business 2,000); past them,
  attachments arrive unparsed.

## AI setup

`ai_setup` proposes fields, a layout, or a repaired field from 1 to 5 of the
endpoint's emails. It sends those emails to Anthropic, so it is an approval:
show the link, then `wait_for_approval` returns the proposals, each checked
against every email. Apply them with `update_endpoint`. `ai_setup_status`
says whether it is offered and how many assists are left. CLI: `whk ai setup`.

## An inbound email handler (Postmark, SendGrid, Mailgun, CloudMailin)

Send real mail to the endpoint (`send_test_email` or the app's own flow),
then `render_email` with the `requestId`, the provider as `format`, and
`targetUrl` set to the local handler (local server only). For Mailgun, pass
the test signing key as `mailgunSigningKey`. `render_email` leaves
attachments out. For continuous delivery, run
`whk tunnel <port> --email-format postmark` (or another provider) or add a
destination in that provider's format.

## Your own domain (Business)

`add_domain` returns the TXT and MX records to publish, `verify_domain`
checks them, `route_domain` sends local parts to endpoints with a catch-all,
`list_domains` shows the state, and `remove_domain` is an approval. CLI:
`whk domains`. These tools are in the domains group.
