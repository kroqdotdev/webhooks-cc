import { MAX_EXTRA_DOMAINS, MONTHLY_DOMAIN_CENTS } from "@/lib/capacity";
import { ENTITLEMENTS } from "@/lib/entitlements";
import type { FAQItem, HowToStep } from "@/lib/schemas";

/**
 * mailhooks.cc's feature pages (app/mailhooks/<page>): one per feature, each
 * with its own title, description, steps, limits and questions. The sitemap,
 * the footer, the home page and each page's "More" links read this list;
 * lib/site.ts and next.config.ts name the paths themselves, and their tests
 * check them against it. Plan numbers come from lib/entitlements.ts and
 * lib/capacity.ts; the rest is what the docs page each one links says.
 */
export interface MailhooksFeature {
  /** The page's path on mailhooks.cc. */
  path: string;
  /** Its name in links and the footer. */
  name: string;
  /** One line for the link cards on other pages. */
  summary: string;
  /** The document title; the layout adds "| mailhooks.cc". */
  title: string;
  description: string;
  keywords: string[];
  /** Which plans have it, above the heading. */
  plans: string;
  heading: string;
  intro: string;
  /** One line beside the sign-up button. */
  planNote: string;
  steps: HowToStep[];
  limits: string[];
  faq: FAQItem[];
  /** The docs page (on webhooks.cc) that covers it in full. */
  docs: { path: string; label: string };
  /** When the page last changed, for the sitemap. */
  updated: string;
}

const free = ENTITLEMENTS.free;
const pro = ENTITLEMENTS.pro;
const business = ENTITLEMENTS.business;
const teamBusiness = ENTITLEMENTS.team_business;

const count = (value: number) => value.toLocaleString("en-US");
const domainPrice = `$${MONTHLY_DOMAIN_CENTS / 100} a month`;
const maxDomains = business.customDomains + MAX_EXTRA_DOMAINS;
const assists = `${count(free.aiAssists)} AI assists every 30 days on Free, ${count(pro.aiAssists)} on Pro and Teams, ${count(business.aiAssists)} on Business and Team Business`;

const UPDATED = "2026-10-31";

export const MAILHOOKS_FEATURES: readonly MailhooksFeature[] = [
  {
    path: "/google-sheets",
    name: "Google Sheets",
    summary: "A row per email or per line item, in a spreadsheet you pick.",
    title: "Email to Google Sheets: a row per email or line item",
    description:
      "Add a Google Sheets row for every email an endpoint receives, or one per order line, with the columns you choose and the values your layouts read. On every plan, Free included.",
    keywords: [
      "email to google sheets",
      "parse email to google sheets",
      "save emails to google sheets",
      "order emails to spreadsheet",
      "email parser google sheets",
      "email line items to google sheets",
    ],
    plans: "Every plan, Free included",
    heading: "Email to Google Sheets, a row at a time",
    intro:
      "Connect a Google account and pick a spreadsheet, and every email the endpoint receives becomes a row: one per email, or one per line item when a layout reads the products of an order. Each column is a header and a value you choose, from the subject and the sender to the fields your layouts pick out.",
    planNote: "On every plan, Free included. Rows do not count against your quota.",
    steps: [
      {
        name: "Create an endpoint",
        text: "Sign up free and create an endpoint. Forward the emails you want in the sheet to its address, or give the address to the sender.",
      },
      {
        name: "Say what to read",
        text: "Name the fields you need, or add a layout (a ready-made one or your own) so the products of an order become line items.",
      },
      {
        name: "Add a Google Sheets destination",
        text: "In the endpoint's Settings, under Forwarding, pick Google Sheets and connect a Google account. webhooks.cc asks only for the spreadsheets it creates or that you pick for it (Google's drive.file permission), never the rest of your Drive.",
      },
      {
        name: "Choose the sheet and the columns",
        text: "Create a new spreadsheet with your columns as its header row, or choose one from Drive. Give each column a header and a value such as {{ subject }} or {{ fields.order }}, and pick one row per email or one per line item.",
      },
    ],
    limits: [
      "Every plan, Free included",
      "Up to 50 columns, each a header and a value",
      "A row per email, or per line item with {{ item.sku }} and the like",
      "Written as plain text: a value starting with = stays text",
      "Rows that arrive close together added in one call",
      "A row Google refuses is retried like any delivery",
      "Only spreadsheets webhooks.cc creates or you pick for it",
      "No extra quota: each email counted once when it arrived",
    ],
    faq: [
      {
        question: "Which values can a column hold?",
        answer:
          "Anything in the email's JSON, written with placeholders: {{ receivedAt }}, {{ from.address }}, {{ subject }}, a field you named as {{ fields.order }}, or a layout's result as {{ parsed.fields.total }}. On a row per line item, {{ item.sku }} and the like read the item's own values.",
      },
      {
        question: "Does it work for webhooks too?",
        answer:
          "Yes. A Google Sheets destination can take emails, HTTP requests or both. For a request, columns read placeholders such as {{ method }}, {{ path }} or a body field like {{ json.type }}.",
      },
      {
        question: "Will it change my header row?",
        answer:
          "No. Create it makes a new spreadsheet with your headers in row 1. For a spreadsheet you picked, Write these headers to row 1 puts them there when you click it; webhooks.cc never changes your header row on its own.",
      },
      {
        question: "What if I disconnect the Google account?",
        answer:
          "Rows Google refuses are retried like any delivery. Connect the account again, or give webhooks.cc its access again in Google, and the rows still waiting go through.",
      },
      {
        question: "Does each row count as a request?",
        answer:
          "No. Forwarding, Google Sheets included, does not use your quota: each email already counted once when it arrived.",
      },
    ],
    docs: { path: "/docs/forwarding#google-sheets", label: "Google Sheets in the forwarding docs" },
    updated: UPDATED,
  },
  {
    path: "/file-drops",
    name: "File drops",
    summary: "CSV, XML or JSON files on your SFTP, FTP or S3 server.",
    title: "Email to SFTP, FTP and S3: CSV, XML or JSON files",
    description:
      "Write each email, or each batch of them, as a CSV, XML or JSON file to your SFTP, FTP/FTPS or S3-compatible server, for imports that watch a folder. Part of Business.",
    keywords: [
      "email to sftp",
      "email to ftp",
      "email to s3",
      "email to csv file",
      "email to xml file",
      "save emails to sftp",
      "parse email to csv",
    ],
    plans: "Business and Team Business",
    heading: "Email to files on your own server",
    intro:
      "Some systems only read files: an ERP or accounting import, a warehouse system, a nightly job. A file drop writes what an endpoint receives as CSV, XML or JSON files to your SFTP, FTP/FTPS or S3-compatible server, a file per email or one per batch, so the system that watches the folder picks them up.",
    planNote:
      "Part of Business, $29 a month or $290 a year, and of Team Business for endpoints shared with the team.",
    steps: [
      {
        name: "Add a file drop",
        text: "In the endpoint's Settings, under Forwarding, pick File drop.",
      },
      {
        name: "Say where the files go",
        text: "SFTP with a password or a private key, FTPS (explicit TLS) or FTP with a password, or S3-compatible storage with a bucket and an access key that may write objects. Then the folder, or the key prefix on S3.",
      },
      {
        name: "Choose what each file holds",
        text: "CSV or XML with the columns you set, a row per email or per line item, or JSON: each email as signed JSON sends it, with its parsed fields and line items.",
      },
      {
        name: "A file per email, or per batch",
        text: "A batch holds everything that arrives within the minutes you set, 1 to 60, after its first email.",
      },
      {
        name: "Test the connection",
        text: "Save, then Test the connection: it logs in and writes webhooks-cc-test.txt to the folder.",
      },
    ],
    limits: [
      "Business, and Team Business for endpoints shared with the team",
      "SFTP, FTPS, FTP and S3-compatible storage",
      "CSV, XML or JSON; up to 50 columns in CSV and XML",
      "A file per email, or per batch of 1 to 60 minutes",
      "Written under a temporary name, then renamed",
      "SFTP host keys pinned on the first connection",
      "Connects from mx.mailhooks.cc, one address to allow",
      "Passwords and keys stored encrypted, never shown again",
    ],
    faq: [
      {
        question: "Which servers can it write to?",
        answer:
          "SFTP (a password, or an OpenSSH or PEM private key), FTPS with explicit TLS, plain FTP, and S3-compatible storage such as AWS, Cloudflare R2, Hetzner, MinIO or Backblaze. For a self-signed certificate on FTPS or on your own S3 server, enter its SHA-256 fingerprint and only that certificate is accepted.",
      },
      {
        question: "How are the files named?",
        answer:
          "After the time and the first request's id, such as orders-20261029-173326-3f2a9c1e.csv, with -batch for a batch and your prefix in front. Each file is written under a temporary name and renamed, so a system watching the folder never reads half a file, and a retry writes the same name again rather than a second file.",
      },
      {
        question: "What happens when my server is down?",
        answer:
          "A server that cannot be reached is retried like any delivery. One that refuses the login, or a folder that is not there, fails at once and is not retried.",
      },
      {
        question: "Is plain FTP safe?",
        answer:
          "Plain FTP sends the password and the files unencrypted, so use it only where nothing else is offered. SFTP and FTPS encrypt both.",
      },
      {
        question: "What if my server only accepts known addresses?",
        answer:
          "Drops connect from our mail server's address, mx.mailhooks.cc, so allow that one address.",
      },
      {
        question: "What happens if I leave Business?",
        answer:
          "The drop is kept, but skipped until the plan has file drops again. Its password or key stays encrypted and is never shown.",
      },
    ],
    docs: { path: "/docs/forwarding#file-drops", label: "File drops in the forwarding docs" },
    updated: UPDATED,
  },
  {
    path: "/custom-domains",
    name: "Your own domain",
    summary: "Mail to orders@inbound.acme.com, sent to the endpoints you choose.",
    title: "Receive email at your own domain, parsed to JSON",
    description: `Point a subdomain's MX record at mx.mailhooks.cc and send orders@ and invoices@ on it to endpoints of their own. One domain with Business, extra ones ${domainPrice}.`,
    keywords: [
      "custom inbound email domain",
      "receive email on custom domain",
      "email parser custom domain",
      "inbound email mx record",
      "catch-all email to json",
      "email to webhook custom domain",
    ],
    plans: "Business and Team Business",
    heading: "Receive mail at your own domain",
    intro:
      "Senders write to an address on a domain you own, such as orders@inbound.acme.com, instead of one at mailhooks.cc. Add the domain, prove it with a TXT record, point its MX at our mail host, and choose the endpoint for each address. From there it works as mailhooks.cc addresses do: layouts, destinations, alerts and replay.",
    planNote: `Business includes ${business.customDomains} domain and Team Business ${teamBusiness.customDomains} per team; each extra one is ${domainPrice}.`,
    steps: [
      {
        name: "Add the domain",
        text: "Under Account > Domains (a team's on the team's page, by its owner), enter a subdomain that receives no other mail, such as inbound.acme.com.",
      },
      {
        name: "Add two DNS records",
        text: "A TXT record at _mailhooks.inbound.acme.com with the token the page shows, and an MX record for inbound.acme.com that points at mx.mailhooks.cc.",
      },
      {
        name: "Check the records",
        text: "Check records looks them up; DNS changes can take a while to show. Once the domain is verified, its mail is accepted within a minute.",
      },
      {
        name: "Choose where its mail goes",
        text: "An address per endpoint, such as orders@ to one and invoices@ to another, and an endpoint for any other address, or refuse those.",
      },
    ],
    limits: [
      `Business includes ${business.customDomains} domain, Team Business ${teamBusiness.customDomains} per team`,
      `Extra domains ${domainPrice} each, renewed with the plan`,
      `Up to ${maxDomains} domains on an account`,
      "Proved by a TXT record, received through MX at mx.mailhooks.cc",
      "Checked every day; three failed checks in a row lapse a domain",
      "An endpoint per address, and a catch-all or a refusal for the rest",
      "Plus tags work: orders+test@ lands where orders@ does",
      "Each email counts once per endpoint, as at mailhooks.cc",
    ],
    faq: [
      {
        question: "Why a subdomain?",
        answer:
          "The MX record sends all of a domain's mail here, so use a subdomain that receives no other mail, such as inbound.acme.com, and keep your own mailboxes on the main domain.",
      },
      {
        question: "What if the records change?",
        answer:
          "They are checked again every day. After three failed checks in a row the domain lapses and its mail is refused until the records are back; check them again from the page.",
      },
      {
        question: "How are extra domains billed?",
        answer: `Each extra domain is ${domainPrice}, renewed with your plan. Domains added mid-period are charged in full and count at once; fewer apply at the renewal. Domains past what the plan allows stay listed, but mail to the most recently verified ones is refused.`,
      },
      {
        question: "What happens if I leave Business?",
        answer:
          "Its domains stop receiving mail, and extra domains end with the plan. The same goes for a team when its Team Business ends.",
      },
      {
        question: "Can another account take my domain?",
        answer:
          "Only by proving it: if another account adds its own TXT record and yours is gone, your hold on the domain lapses at once, because whoever controls its DNS decides where its mail goes.",
      },
      {
        question: "Can I sign up with an address on the domain?",
        answer:
          "No. An address at a verified domain cannot be used to sign up for an account, because its mail can be read here.",
      },
    ],
    docs: { path: "/docs/email-capture#your-own-domain", label: "Your own domain in the docs" },
    updated: UPDATED,
  },
  {
    path: "/ai-setup",
    name: "AI setup",
    summary: "Patterns for fields and layouts, drafted from emails you pick.",
    title: "AI setup for email layouts: patterns you can read",
    description:
      "Pick up to 5 emails and AI drafts the fields and the layout as RE2 patterns, each tried on every email you picked first. Only when you ask, and never on mail as it arrives.",
    keywords: [
      "ai email parser",
      "ai email parsing",
      "ai regex generator for emails",
      "extract fields from email with ai",
      "email parser setup",
      "fix email parser with ai",
    ],
    plans: "Every plan, with AI assists every 30 days",
    heading: "Let AI write the patterns, then read them yourself",
    intro:
      "Writing patterns is the slow part of reading email into fields. Pick a few of an endpoint's emails that look alike, say what you need, and AI proposes the fields, or a whole layout with the condition that picks its emails. Every pattern is RE2 you can read and change, and it is tried on each email you picked before you see it. The AI only writes patterns: it never reads your mail as it arrives.",
    planNote: `${assists}.`,
    steps: [
      {
        name: "Pick the emails",
        text: "Under the endpoint's Layouts, choose Draft a layout with AI, or Find a field with AI in an open layout, and pick up to 5 of its emails that look alike.",
      },
      {
        name: "Say what you need",
        text: "A field's name and what it is, or for a whole layout, which values matter if you want to say.",
      },
      {
        name: "Agree to send them",
        text: "Tick the box to send those emails to Anthropic, our AI provider: their subject, sender, recipients, text and headers, never attachments. Nothing is sent until you tick it.",
      },
      {
        name: "Check the proposal",
        text: "Propose shows each pattern with the value it found in every email you picked. A pattern that misses one of them, or does not compile, is never shown.",
      },
      {
        name: "Add it, then save",
        text: "Add field or Add this layout puts it in the editor. Nothing is saved until you save the layouts.",
      },
    ],
    limits: [
      "1 to 5 of the endpoint's own emails per ask",
      "Subject, sender, recipients, text and headers sent; never attachments",
      "Sent only once you tick the box, from a signed-in session, never an API key",
      "Every pattern compiled with RE2 and tried on each email",
      "Nothing saved until you save the layouts",
      "Never run over mail as it arrives",
      `${count(free.aiAssists)}, ${count(pro.aiAssists)} or ${count(business.aiAssists)} assists every 30 days, by plan`,
      "An ask that fails on our side or the AI's is not counted",
    ],
    faq: [
      {
        question: "Does the AI read every email I receive?",
        answer:
          "No. It sees only the emails you pick, and only when you ask. What it returns is a set of RE2 patterns; from then on those patterns read your mail on our servers, like patterns you wrote yourself, without the AI.",
      },
      {
        question: "Which AI provider is it, and what is sent?",
        answer:
          "Anthropic, listed among our subprocessors. Only the subject, sender, recipients, text and headers of the emails you picked are sent, never their attachments, and we do not keep what is sent.",
      },
      {
        question: "Can it fix a field that stopped matching?",
        answer:
          "Yes. When an alert says a field such as order stopped matching, Fix order with AI next to the alert proposes a corrected pattern from the latest emails, under the field's own name, and saves it when you accept it. Replay the emails afterwards to read them again.",
      },
      {
        question: "How are AI assists counted?",
        answer: `One per ask, over the last 30 days: ${assists}. Endpoints shared with a team count against the team's assists, others against their owner's. An ask that fails on our side or the AI service's is not counted.`,
      },
      {
        question: "Why RE2 patterns?",
        answer:
          "RE2 runs in time linear in the text and never backtracks, so no email, however odd, can make a pattern hang. Patterns from AI run on the same engine as the ones you write.",
      },
      {
        question: "Can I use it from the API?",
        answer:
          "No. AI setup works from a signed-in session in the dashboard, never with an API key, and sends nothing until you tick the box that agrees to it.",
      },
    ],
    docs: { path: "/docs/layouts#set-it-up-with-ai", label: "AI setup in the layouts docs" },
    updated: UPDATED,
  },
  {
    path: "/integrations",
    name: "Zapier and Make",
    summary: "Start a Zap or a Make scenario with each parsed email.",
    title: "Zapier and Make: parsed emails as a trigger",
    description:
      "Start a Zap or a Make scenario with every email an endpoint receives, with its fields and line items. The apps are in review; a catch hook works today on every plan.",
    keywords: [
      "email parser zapier",
      "email to zapier",
      "parse email zapier webhook",
      "email parser make.com",
      "make custom webhook email",
      "email to make scenario",
    ],
    plans: "Every plan, Free included",
    heading: "Parsed email in Zapier and Make",
    intro:
      "Send each email an endpoint receives to a Zap or a Make scenario, with the fields and line items your layouts read, and let it carry the order, booking or report on to your other tools. Our Zapier and Make apps are in review and not listed in their directories yet. Until they are, a catch hook in either one receives the same signed JSON today.",
    planNote: "On every plan, Free included. Deliveries do not count against your quota.",
    steps: [
      {
        name: "Create a hook",
        text: "In Zapier, start a Zap with Webhooks by Zapier and its Catch Hook trigger. In Make, add a Webhooks module with a custom webhook. Copy the URL it gives you.",
      },
      {
        name: "Add it as a destination",
        text: "In the endpoint's Settings, under Forwarding, add Your server with that URL. Under What it gets, leave only Emails ticked, so each email goes as signed JSON.",
      },
      {
        name: "Send a sample",
        text: "Send test delivery posts the newest email, or a sample, once, so Zapier or Make learns its fields.",
      },
      {
        name: "Map the fields and turn it on",
        text: "Each email arrives as email.received JSON with the email under data: data.subject, data.from.address, data.fields and, on an endpoint with layouts, data.parsed.",
      },
    ],
    limits: [
      "Every plan, Free included",
      "The same signed email.received JSON as any destination",
      "A URL that answers 410 Gone turns its destination off",
      "Up to 10 destinations per endpoint",
      "Apps: an instant New email trigger, two actions, a search",
      "Apps connect with an API key (whcc_...)",
      "Search: 60 per 10 minutes per account",
      "No extra quota: each email counted once when it arrived",
    ],
    faq: [
      {
        question: "Are the Zapier and Make apps available?",
        answer:
          "Not yet. Both are in review and not listed in the Zapier or Make directories. Until they are, point a JSON destination at a Webhooks by Zapier catch hook or a Make custom webhook: it receives the same signed email.received JSON the apps read.",
      },
      {
        question: "How will the apps work?",
        answer:
          "Connect them with an API key from Account > API keys. Turning a Zap or scenario on adds a destination to the endpoint you pick that sends each email to it as JSON, and turning it off removes that destination, so it shows in the endpoint's Forwarding list while it runs.",
      },
      {
        question: "What happens when I delete a Zap or scenario?",
        answer:
          "Its destination is removed. If that failed, Zapier or Make answers 410 Gone for the old hook, and webhooks.cc turns the destination off instead of retrying it. Any destination whose URL answers 410 is turned off the same way.",
      },
      {
        question: "Are the deliveries signed?",
        answer:
          "Yes, with Standard Webhooks headers (webhook-id, webhook-timestamp and webhook-signature), as every JSON destination is. Keep the hook's URL private all the same: anyone who has it can post to your Zap or scenario.",
      },
      {
        question: "Does it work with n8n or other tools?",
        answer:
          "Yes. Any tool that gives you a webhook URL can take the same JSON destination, or one in a JSON shape of your own with only the fields you pick.",
      },
      {
        question: "Do deliveries count against my quota?",
        answer:
          "No. Each email counted once when it arrived; sending it to Zapier, Make or anywhere else does not count again.",
      },
    ],
    docs: { path: "/docs/forwarding#signed-json", label: "Signed JSON in the forwarding docs" },
    updated: UPDATED,
  },
];

/** A feature page by its path. */
export function mailhooksFeature(path: string): MailhooksFeature {
  const feature = MAILHOOKS_FEATURES.find((f) => f.path === path);
  if (!feature) throw new Error(`No mailhooks.cc feature page at ${path}`);
  return feature;
}
