import type { FAQItem } from "@/lib/schemas";

/**
 * The "X vs Y" pages under /compare: two other tools compared with each
 * other, followed by a short section on where webhooks.cc fits. Each is a
 * folder of its own (app/compare/ngrok-vs-hookdeck) that renders
 * PairComparisonPage with one entry from here.
 *
 * Every fact about another product comes from that vendor's own site, read on
 * the day in PAIR_FACTS_CHECKED. Leave out what cannot be checked there.
 * Titles lead with "X vs Y" so a pair page never competes with the
 * /compare/<tool> page of either tool, which targets "<tool> alternative".
 */
export const PAIR_FACTS_CHECKED = "November 2026";

export interface ComparePairTool {
  /** The name as the tool writes it. */
  name: string;
  /** Our own comparison with this tool, when there is one. */
  compareHref?: string;
  /** What the tool is and what it is for. */
  about: string;
  /** "Pick <name> when": one line each. */
  pick: readonly string[];
}

export interface ComparePair {
  /** The last part of the path: /compare/<slug>. */
  slug: string;
  a: ComparePairTool;
  b: ComparePairTool;
  /** The page title; starts with "<a> vs <b>". */
  title: string;
  description: string;
  keywords: readonly string[];
  /** The paragraph under the heading. */
  intro: string;
  /** Feature and price rows: label, tool a, tool b. */
  rows: readonly (readonly [string, string, string])[];
  /** Where the rows were read, shown under the table. */
  sources: string;
  /** Where webhooks.cc fits, one paragraph each. */
  fit: readonly string[];
  /** Links under the fit section: our own comparisons, docs, /share. */
  fitLinks: readonly { label: string; href: string }[];
  faq: readonly FAQItem[];
  /** The closing card's heading, when the default (webhooks) does not fit. */
  ctaHeading?: string;
}

const NGROK_ABOUT =
  "ngrok gives a local port a public URL. The free plan comes with one assigned ngrok-free.app domain that stays the same when you restart the agent, HTTP endpoints, and TCP once a card is verified. The sender talks to your app through the tunnel, so it gets your app's own response, and the agent has to be running when the request arrives. Requests show in the local inspector at localhost:4040 and in the dashboard's Traffic Inspector, where they can be replayed.";

const WEBHOOK_SITE_ABOUT =
  "Webhook.site gives you a unique URL, an email address and a DNS name the moment you open it, with no signup, and shows everything sent to them in the browser. A free URL expires after 1 week and stops at 50 requests. Its CLI, whcli forward, passes requests on to localhost and can return your server's response to the caller. Paid accounts add Custom Actions (workflows that run on each request), schedules and URLs that do not expire.";

const HOOKDECK_ABOUT =
  "Hookdeck's Event Gateway sits between the sender and your server. It accepts each request on a Source URL, logs it as an event, and delivers it to a destination with retries: up to 50 automatic ones per event, and manual ones as often as you like. For local work, hookdeck listen forwards events to a port on your machine, and Hookdeck Inspect gives you a test URL with no account. Hookdeck describes the two together as a free alternative to ngrok for webhooks.";

const NGROK_PRICES = "Free; Hobbyist $10/mo; Pay-as-you-go $20/mo plus usage";
const WEBHOOK_SITE_PRICES = "Basic $9/mo, Pro $19/mo, Enterprise $69/mo";

export const COMPARE_PAIRS: readonly ComparePair[] = [
  {
    slug: "ngrok-vs-hookdeck",
    title: "ngrok vs Hookdeck for Webhook Forwarding and Testing (2026)",
    description:
      "ngrok vs Hookdeck compared for webhooks: a tunnel to localhost against an event gateway with retries. Free plans, limits, prices, and when to pick which.",
    keywords: [
      "ngrok vs hookdeck",
      "hookdeck vs ngrok",
      "hookdeck vs ngrok for webhook forwarding",
      "ngrok vs hookdeck for webhooks",
      "hookdeck cli vs ngrok",
      "webhook forwarding to localhost",
    ],
    intro:
      "ngrok and Hookdeck both get a webhook from the internet to a server on your laptop, and they are built for different jobs. ngrok is a tunnel: a local port gets a public address and traffic passes straight through. Hookdeck is an event gateway: it receives the webhook on its own URL, stores it, and delivers it to your server or, through its CLI, to localhost.",
    a: {
      name: "ngrok",
      compareHref: "/compare/ngrok",
      about: NGROK_ABOUT,
      pick: [
        "The sender has to get your local app's own response",
        "You expose more than webhooks: a website, an API or a TCP service",
        "You want one address that stays the same on a free plan",
        "You need your own domain or sign-in rules in front of the endpoint",
      ],
    },
    b: {
      name: "Hookdeck",
      compareHref: "/compare/hookdeck",
      about: HOOKDECK_ABOUT,
      pick: [
        "Webhooks should be kept while your machine is off and delivered later",
        "You want retries, queueing and rate limits between the sender and your server",
        "The setup you test with should carry on into production",
        "Several people need the event log: users are unlimited from the Team plan",
      ],
    },
    rows: [
      [
        "What it is",
        "A tunnel from a public URL to a local port",
        "An event gateway that receives, stores and delivers webhooks",
      ],
      ["Forward webhooks to localhost", "ngrok http 3000", "hookdeck listen 3000"],
      [
        "Who answers the sender",
        "Your local app, through the tunnel",
        "Hookdeck accepts the request; your app gets it as a delivery",
      ],
      [
        "A webhook sent while nothing is listening",
        "The agent must be running to receive it",
        "Stored; retry or replay it once a listener is connected",
      ],
      [
        "Request history",
        "Traffic Inspector: 24 hours on Free, 72 hours on paid plans",
        "Event log: 3 days on Developer, 7 on Team, 30 on Growth",
      ],
      [
        "Replay",
        "From the inspector",
        "Retry any event by hand; failed events retry automatically, up to 50 times",
      ],
      [
        "Free plan",
        "1 GB of data and 20,000 HTTP requests a month, up to 3 endpoints, 1 user",
        "10,000 events a month, 3-day retention, 1 user",
      ],
      [
        "Paid plans",
        "Hobbyist $10/mo; Pay-as-you-go $20/mo plus usage",
        "Team from $39/mo; Growth from $499/mo; events metered past 10,000",
      ],
      [
        "Rate limits",
        "4,000 HTTP requests a minute on Free, 20,000 on paid plans",
        "5 events a second per destination included; more is queued, not dropped",
      ],
      ["Protocols", "HTTP, TCP, and TLS on Pay-as-you-go", "HTTP requests"],
      ["Team members", "3 included on Pay-as-you-go, then $5 per user", "Unlimited on Team and up"],
      ["MCP server", "Yes", "Yes: local, through the CLI, read-only to begin with"],
    ],
    sources:
      "ngrok as listed on ngrok.com/pricing and in its docs, Hookdeck as listed on hookdeck.com/pricing and in its docs",
    fit: [
      "webhooks.cc is built for the part both tools treat as a side job: testing. An endpoint captures every webhook and keeps it (7 days on Free, 31 on Pro), whether or not anything runs on your machine. whk tunnel forwards each one to localhost, and whk tunnel --live makes the sender wait for your local app's answer, the way a tunnel does.",
      "The SDKs for TypeScript, Python and Go wait for a webhook and assert on it in CI, and whk share puts a local site at a public link. It is not a production gateway like Hookdeck, and it has no TCP tunnels like ngrok.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs ngrok", href: "/compare/ngrok" },
      { label: "webhooks.cc vs Hookdeck", href: "/compare/hookdeck" },
      { label: "Live tunnels", href: "/docs/live-tunnel" },
      { label: "Share localhost", href: "/share" },
    ],
    faq: [
      {
        question: "ngrok vs Hookdeck: which should I use for webhook forwarding?",
        answer:
          "Use ngrok when the sender needs your app's response at once, or when you expose more than webhooks. Use Hookdeck when webhooks should be stored, retried and delivered later, in development and in production. ngrok passes each request straight to your local port; Hookdeck accepts it on its own URL and delivers it as an event.",
      },
      {
        question: "Is Hookdeck a replacement for ngrok?",
        answer:
          "For receiving webhooks on localhost, Hookdeck says so itself: its docs describe the Hookdeck CLI with Hookdeck Inspect as a free alternative to ngrok for webhooks. It is not a general tunnel, so for showing a local website to someone, or for TCP, ngrok is the tool.",
      },
      {
        question: "Which has the larger free plan for webhooks?",
        answer:
          "ngrok's free plan allows 20,000 HTTP requests and 1 GB of data a month on up to 3 endpoints, and keeps traffic in its inspector for 24 hours. Hookdeck's Developer plan allows 10,000 events a month and keeps them for 3 days. Both are for one user. Figures from each pricing page in November 2026.",
      },
      {
        question: "What happens to a webhook sent while my laptop is closed?",
        answer:
          "With ngrok the agent has to be running for the request to reach anything. Hookdeck still stores the request when no CLI listener is attached; once you start a listener you retry or replay it by hand. A webhooks.cc endpoint captures it either way, and you replay it to localhost when you are back.",
      },
    ],
  },
  {
    slug: "ngrok-vs-webhook-site",
    title: "ngrok vs Webhook.site: Tunnel or Request Inspector? (2026)",
    description:
      "ngrok vs Webhook.site for receiving webhooks: a tunnel to your local server against a hosted URL that shows every request. Free limits, prices, and when to pick which.",
    keywords: [
      "ngrok vs webhook.site",
      "webhook.site vs ngrok",
      "ngrok vs webhook.site for localhost",
      "webhook.site or ngrok",
      "receive webhooks on localhost",
      "webhook request inspector",
    ],
    intro:
      "ngrok carries a request to your local server. Webhook.site shows you the request: it hands you a URL and lists everything sent there. Which one to reach for when a provider asks for a webhook URL depends mostly on whether you have a handler to send it to yet.",
    a: {
      name: "ngrok",
      compareHref: "/compare/ngrok",
      about: NGROK_ABOUT,
      pick: [
        "You already have a handler and want real requests to reach it",
        "The sender needs your app's response",
        "You are sharing a website or a TCP service, not only webhooks",
        "You want the address to stay the same on a free plan",
      ],
    },
    b: {
      name: "Webhook.site",
      compareHref: "/compare/webhook-site",
      about: WEBHOOK_SITE_ABOUT,
      pick: [
        "You want to see what a provider sends before writing any code",
        "Nothing is running locally yet",
        "You need an email address or a DNS name that records what reaches it",
        "You want to transform or forward requests without a server of your own, on a paid plan",
      ],
    },
    rows: [
      [
        "What it is",
        "A tunnel from a public URL to a local port",
        "A hosted URL that captures and shows requests",
      ],
      ["Needs a local server", "Yes", "No, the URL answers on its own"],
      ["Account", "Yes, free signup", "None for a free URL"],
      ["Forward to localhost", "ngrok http 3000", "whcli forward"],
      [
        "Who answers the sender",
        "Your local app, through the tunnel",
        "Webhook.site, or your server's response when whcli forwards it",
      ],
      [
        "Request history",
        "Traffic Inspector: 24 hours on Free, 72 hours on paid plans",
        "50 requests on a free URL; 1,000 to 100,000 per URL on paid plans",
      ],
      [
        "Free plan",
        "One assigned domain, 1 GB of data and 20,000 HTTP requests a month",
        "URLs expire after 1 week and take 50 requests",
      ],
      ["Paid plans", NGROK_PRICES, WEBHOOK_SITE_PRICES],
      ["Email capture", "No", "Yes, an address for every URL"],
      [
        "Acting on a request",
        "Traffic Policy rules at the endpoint",
        "Custom Actions, on paid plans",
      ],
      ["Your own domain", "Pay-as-you-go", "Enterprise"],
      ["Protocols", "HTTP, TCP, and TLS on Pay-as-you-go", "HTTP requests, email and DNS lookups"],
      ["Team members", "3 included on Pay-as-you-go, then $5 per user", "Enterprise, 10 included"],
    ],
    sources:
      "ngrok as listed on ngrok.com/pricing and in its docs, Webhook.site as listed on webhook.site/pricing and docs.webhook.site",
    fit: [
      "webhooks.cc does both halves in one tool. An endpoint is a hosted URL like Webhook.site's: it captures every request, and email at its own address, and keeps them with no tunnel running. whk tunnel then forwards them to localhost the way ngrok would, whk tunnel --live returns your app's answer to the sender, and whk share puts a local site at a public link.",
      "On top of that it has SDKs that wait for a webhook and assert on it in CI, signature checks for more than 30 providers, and an MCP server. The free plan takes 50 requests a day and keeps them for 7 days.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs ngrok", href: "/compare/ngrok" },
      { label: "webhooks.cc vs Webhook.site", href: "/compare/webhook-site" },
      { label: "CLI tunnel", href: "/docs/cli/tunnel" },
      { label: "Share localhost", href: "/share" },
    ],
    faq: [
      {
        question: "ngrok vs Webhook.site for receiving webhooks on localhost?",
        answer:
          "ngrok forwards traffic to your local port and shows it in an inspector at localhost:4040 while the agent runs. Webhook.site captures requests on a hosted URL and shows them in the browser; getting them to localhost takes its CLI, whcli forward. Pick ngrok when you have a handler to test, and Webhook.site when you first want to see what the provider sends.",
      },
      {
        question: "Is Webhook.site an alternative to ngrok?",
        answer:
          "For webhooks, partly: whcli forward sends requests from a Webhook.site URL to localhost and can return your server's response. It is not a general tunnel, so it does not share a local website or a TCP service the way ngrok does.",
      },
      {
        question: "Do I need an account for ngrok or Webhook.site?",
        answer:
          "Webhook.site gives you a URL without signing up; that URL expires after 1 week and takes 50 requests. ngrok's free plan is an account plan: the assigned domain is tied to your account.",
      },
      {
        question: "Which keeps webhook history longer?",
        answer:
          "ngrok's Traffic Inspector keeps traffic for 24 hours on the free plan and 72 hours on paid plans. Webhook.site keeps the most recent requests per URL: 50 on a free URL, and 1,000, 10,000 or 100,000 on Basic, Pro and Enterprise. Figures from each site in November 2026.",
      },
    ],
  },
  {
    slug: "hookdeck-vs-webhook-site",
    title: "Hookdeck vs Webhook.site for Webhook Testing (2026)",
    description:
      "Hookdeck vs Webhook.site for testing webhooks: an event gateway with a free inspector against a request inspector with workflows. Free limits and prices compared.",
    keywords: [
      "hookdeck vs webhook.site",
      "webhook.site vs hookdeck",
      "hookdeck vs webhook.site for testing",
      "hookdeck inspect vs webhook.site",
      "webhook testing tools compared",
    ],
    intro:
      "Hookdeck and Webhook.site both hand you a URL that records what a provider sends. Webhook.site is an inspector with workflows attached. Hookdeck is delivery infrastructure with an inspector attached. For a first look at a payload the free inspectors are close; the difference shows when the webhook has to go somewhere afterwards.",
    a: {
      name: "Hookdeck",
      compareHref: "/compare/hookdeck",
      about: HOOKDECK_ABOUT,
      pick: [
        "The webhook should end up at your server, with retries and a queue in between",
        "You want the same tool in development and in production",
        "You manage sources and destinations from a CLI or in CI",
        "A whole team needs the event log",
      ],
    },
    b: {
      name: "Webhook.site",
      compareHref: "/compare/webhook-site",
      about: WEBHOOK_SITE_ABOUT,
      pick: [
        "You want the quickest look at a request, with nothing to install",
        "You also need an email address or a DNS name that records what reaches it",
        "You want workflows on each request without writing a server",
        "You prefer a flat price to metered events",
      ],
    },
    rows: [
      [
        "What it is",
        "An event gateway that receives, stores and delivers webhooks",
        "A request inspector with workflows (Custom Actions)",
      ],
      ["Test URL with no account", "Yes, Hookdeck Inspect", "Yes"],
      ["Forward to localhost", "hookdeck listen", "whcli forward"],
      [
        "Retries",
        "Automatic, up to 50 per event, and by hand",
        "Replay of Custom Actions on past requests",
      ],
      [
        "Request history",
        "3 days on Developer, 7 on Team, 30 on Growth",
        "50 requests on a free URL; 1,000 to 100,000 per URL on paid plans",
      ],
      [
        "Free plan",
        "Developer: 10,000 events a month, 1 user",
        "URLs expire after 1 week and take 50 requests",
      ],
      ["Paid plans", "Team from $39/mo; Growth from $499/mo", WEBHOOK_SITE_PRICES],
      [
        "How it is priced",
        "Metered by events past 10,000 a month",
        "Flat: every paid plan accepts unlimited requests",
      ],
      [
        "Rate limiting deliveries",
        "Per-destination throughput; more is queued, not dropped",
        "Queue Profiles for Custom Actions",
      ],
      ["Team members", "Unlimited on Team and up", "Enterprise, 10 included"],
      ["Single sign-on", "Growth", "Enterprise (SAML 2.0)"],
    ],
    sources:
      "Hookdeck as listed on hookdeck.com/pricing and in its docs, Webhook.site as listed on webhook.site/pricing and docs.webhook.site",
    fit: [
      "webhooks.cc sits between the two, on the testing side. Like Webhook.site, an endpoint is an instant URL with a live list of requests and an email address of its own. Like Hookdeck, it sends what it captures on: up to 10 destinations per endpoint, each with a filter and a throttle, with failed deliveries retried for about a day.",
      "What neither has is the test itself: SDKs for TypeScript, Python and Go that wait for a webhook and assert on it in CI, and whk tunnel to bring each request to localhost. It is not a gateway for production traffic; for that, Hookdeck is the right kind of tool.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs Hookdeck", href: "/compare/hookdeck" },
      { label: "webhooks.cc vs Webhook.site", href: "/compare/webhook-site" },
      { label: "Forwarding and destinations", href: "/docs/forwarding" },
    ],
    faq: [
      {
        question: "Hookdeck vs Webhook.site for testing webhooks?",
        answer:
          "Both give you a test URL without an account: Hookdeck Inspect and a free Webhook.site URL. Webhook.site suits a quick look, and its free URL stops at 50 requests and expires after 1 week. Hookdeck suits testing the path a webhook takes in production, with hookdeck listen forwarding events to localhost and 10,000 events a month on its free Developer plan.",
      },
      {
        question: "Which is cheaper, Hookdeck or Webhook.site?",
        answer:
          "For one person inspecting requests, Webhook.site: Basic is $9 a month for one URL with unlimited requests, and Pro is $19 for 50 URLs. Hookdeck's paid plans start at $39 a month and are metered by events, and its free Developer plan covers 10,000 events a month. Prices from each pricing page in November 2026.",
      },
      {
        question: "Can Hookdeck or Webhook.site forward webhooks to localhost?",
        answer:
          "Both, through a CLI. hookdeck listen forwards events from a Hookdeck source to a local port. whcli forward does the same from a Webhook.site URL and can pass your server's response back.",
      },
    ],
  },
  {
    slug: "ngrok-vs-localtunnel",
    title: "ngrok vs LocalTunnel: Free Plans and Limits Compared (2026)",
    description:
      "ngrok vs LocalTunnel for exposing localhost: a commercial tunnel with a free plan and an inspector against a free, open-source npm package. Limits and prices compared.",
    keywords: [
      "ngrok vs localtunnel",
      "localtunnel vs ngrok",
      "localtunnel or ngrok",
      "ngrok free vs localtunnel",
      "expose localhost free",
      "localhost tunnel comparison",
    ],
    intro:
      "ngrok and LocalTunnel both put a local port on a public HTTPS URL with one command. LocalTunnel is a free, open-source npm package with no account. ngrok is a commercial service with a free plan, a request inspector, and paid plans above it.",
    a: {
      name: "ngrok",
      compareHref: "/compare/ngrok",
      about:
        NGROK_ABOUT +
        " On the free plan, browsers see an interstitial page first, once every 7 days per domain; API clients and webhook senders never do.",
      pick: [
        "The address should stay the same after a restart",
        "You want to inspect and replay the requests that came through",
        "You need TCP as well as HTTP",
        "You want a vendor with support and paid plans to grow into",
      ],
    },
    b: {
      name: "LocalTunnel",
      compareHref: "/compare/localtunnel",
      about:
        "LocalTunnel is an MIT-licensed npm package. npx localtunnel --port 8000 prints an https URL on loca.lt that works for as long as the command runs. You can ask for a name with --subdomain, and get it only if it is free. There is no account, no dashboard and no request inspector, and the client can be pointed at a server you run yourself. The latest release on npm, 2.0.2, is from September 2021.",
      pick: [
        "You want a throwaway link with no account",
        "You want open-source code, and the option of your own server",
        "You start tunnels from a Node script or a test",
        "A new URL each session is fine",
      ],
    },
    rows: [
      ["Start a tunnel", "ngrok http 8000", "npx localtunnel --port 8000"],
      ["Account", "Yes, free signup", "None"],
      ["Price", NGROK_PRICES, "Free"],
      [
        "Address",
        "One assigned ngrok-free.app domain, the same after a restart",
        "A random loca.lt name per session; --subdomain asks for one",
      ],
      [
        "Free usage limits",
        "1 GB of data and 20,000 HTTP requests a month, up to 3 endpoints",
        "None stated",
      ],
      ["Request inspector", "Yes: localhost:4040 and the Traffic Inspector, with replay", "None"],
      [
        "Protocols",
        "HTTP; TCP with card verification on Free; TLS on Pay-as-you-go",
        "HTTP and HTTPS",
      ],
      ["Your own domain", "Pay-as-you-go", "Through a server you host"],
      ["License", "Commercial service", "MIT"],
      ["Team members", "3 included on Pay-as-you-go, then $5 per user", "No accounts"],
    ],
    sources:
      "ngrok as listed on ngrok.com/pricing and in its docs, LocalTunnel as described on its site, its GitHub README and npm",
    fit: [
      "For webhooks, the weak spot of any tunnel is that the provider needs a URL that keeps working. A webhooks.cc endpoint has a fixed URL that captures every request and keeps it, and whk tunnel forwards each one to localhost when you are there to receive it, so nothing is lost while the tunnel is down.",
      "For showing a local site, whk share is included in every plan: a random name ending in -free for 2 hours at a time on Free, and reserved names with passwords on Pro at $8 a month. It serves web pages only, with no TCP.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs ngrok", href: "/compare/ngrok" },
      { label: "webhooks.cc vs LocalTunnel", href: "/compare/localtunnel" },
      { label: "Share localhost", href: "/share" },
    ],
    faq: [
      {
        question: "LocalTunnel vs ngrok: what is the difference?",
        answer:
          "Both expose a local port on a public URL. ngrok is a commercial service: a free plan with one assigned domain that survives restarts, a request inspector with replay, TCP tunnels, and paid plans from $10 a month. LocalTunnel is a free MIT-licensed npm package with a random URL per session, no account and no inspector.",
      },
      {
        question: "Is LocalTunnel still maintained?",
        answer:
          "The latest release on npm is 2.0.2, from September 2021. The GitHub repository's most recent commit, a README update, is from August 2025. Checked in November 2026.",
      },
      {
        question: "Which is better for webhooks, ngrok or LocalTunnel?",
        answer:
          "ngrok, mainly because of the address: its free domain stays the same, so the URL you gave the provider keeps working, and its inspector shows and replays what arrived. LocalTunnel hands out a new random name each session unless the subdomain you ask for is free, so the provider's settings have to be changed each time.",
      },
      {
        question: "Is LocalTunnel free?",
        answer:
          "Yes. It is an open-source npm package with no account and no paid plan. ngrok has a free plan too, limited to 1 GB of data and 20,000 HTTP requests a month.",
      },
    ],
  },
  {
    slug: "ngrok-vs-cloudflare-tunnel",
    title: "ngrok vs Cloudflare Tunnel: Free Limits and Domains (2026)",
    description:
      "ngrok vs Cloudflare Tunnel compared: an assigned domain and a request inspector against tunnels to your own domain on Cloudflare, plus no-account Quick Tunnels.",
    keywords: [
      "ngrok vs cloudflare tunnel",
      "cloudflare tunnel vs ngrok",
      "cloudflared vs ngrok",
      "trycloudflare vs ngrok",
      "cloudflare quick tunnel limits",
      "expose localhost cloudflare",
    ],
    intro:
      "Both connect a local service to the internet over an outbound connection, with nothing to open in a firewall. ngrok is built around a developer's machine: one command, an assigned domain and a request inspector. Cloudflare Tunnel is built around Cloudflare's network: cloudflared connects a server to your own domain there, with a no-account Quick Tunnel for testing.",
    a: {
      name: "ngrok",
      compareHref: "/compare/ngrok",
      about: NGROK_ABOUT,
      pick: [
        "You want a fixed address without owning a domain",
        "You are debugging webhooks and want to inspect and replay requests",
        "You want one command on a laptop, with no DNS to move",
        "You need sign-in rules (OAuth, SAML or OIDC) on a development link",
      ],
    },
    b: {
      name: "Cloudflare Tunnel",
      compareHref: "/compare/cloudflare-tunnel",
      about:
        "Cloudflare Tunnel runs cloudflared next to your service and maps hostnames on a domain you keep on Cloudflare to local addresses, with Cloudflare's CDN, WAF and DDoS protection in front. Cloudflare lists it as available on all plans, and cloudflared is open source under Apache 2.0. For a quick test, cloudflared tunnel --url http://localhost:8080 opens a Quick Tunnel on a random trycloudflare.com address with no account. Cloudflare says Quick Tunnels are for testing and development: no uptime guarantee, at most 200 requests in flight, and no Server-Sent Events.",
      pick: [
        "Your domain is already on Cloudflare",
        "The service should stay up: a server, a home lab, production",
        "You want a link right now with no account",
        "You need SSH or RDP, or Cloudflare's WAF in front",
      ],
    },
    rows: [
      ["Quick start", "ngrok http 8080", "cloudflared tunnel --url http://localhost:8080"],
      ["Account for a quick link", "Yes, free signup", "No (Quick Tunnel)"],
      [
        "Free address",
        "One assigned ngrok-free.app domain, the same after a restart",
        "A random trycloudflare.com name, new for every Quick Tunnel",
      ],
      [
        "Stable address",
        "The assigned domain; your own domain on Pay-as-you-go",
        "Your own domain on Cloudflare",
      ],
      [
        "Price",
        NGROK_PRICES,
        "Listed as available on all Cloudflare plans; Quick Tunnels need no account",
      ],
      [
        "Limits on the free route",
        "1 GB of data and 20,000 HTTP requests a month, up to 3 endpoints",
        "Quick Tunnels: 200 requests in flight, no Server-Sent Events, no uptime guarantee",
      ],
      [
        "Request inspector and replay",
        "Yes: localhost:4040 and the Traffic Inspector",
        "Not documented for Tunnel",
      ],
      [
        "Protocols",
        "HTTP; TCP with card verification on Free; TLS on Pay-as-you-go",
        "HTTP, HTTPS, TCP, SSH, RDP and more",
      ],
      [
        "Restricting who gets in",
        "OAuth, SAML or OIDC sign-in through Traffic Policy",
        "Email one-time PIN on Quick Tunnels; Cloudflare Access on a tunnel",
      ],
      [
        "In front of your service",
        "ngrok's gateway: Traffic Policy and endpoint pooling",
        "Cloudflare's CDN, WAF and DDoS protection",
      ],
    ],
    sources:
      "ngrok as listed on ngrok.com/pricing and in its docs, Cloudflare Tunnel as described on developers.cloudflare.com/tunnel",
    fit: [
      "Neither tunnel is a place where webhooks wait for you. A webhooks.cc endpoint has a fixed URL that captures every webhook and keeps it (7 days on Free, 31 on Pro), and whk tunnel forwards each one to localhost; with --live the sender gets your local app's answer, as it would through a tunnel.",
      "For a quick link to a local site, whk share needs no domain: a random name ending in -free for 2 hours at a time on Free, and reserved names with passwords on Pro at $8 a month. It serves web pages only. For TCP, SSH, or a service that should stay up on your own domain, ngrok and Cloudflare Tunnel are the right tools.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs ngrok", href: "/compare/ngrok" },
      { label: "webhooks.cc vs Cloudflare Tunnel", href: "/compare/cloudflare-tunnel" },
      { label: "Share localhost", href: "/share" },
    ],
    faq: [
      {
        question: "ngrok vs Cloudflare Tunnel: which is better for local development?",
        answer:
          "ngrok is the shorter path on a laptop: one command gives an address that stays the same, with an inspector for the requests. Cloudflare Tunnel fits when your domain is already on Cloudflare and you want the service on a hostname of your own; its Quick Tunnel covers a one-off link with no account, on an address that changes every time.",
      },
      {
        question: "Is Cloudflare Tunnel free?",
        answer:
          "Cloudflare's docs list Cloudflare Tunnel as available on all plans, and a Quick Tunnel needs no account at all. Publishing an application on a tunnel needs a Cloudflare account and a domain on Cloudflare.",
      },
      {
        question: "What are the limits of a Cloudflare Quick Tunnel?",
        answer:
          "Per Cloudflare's docs: no uptime guarantee, up to 200 requests in flight (more get a 429), no Server-Sent Events, and a hostname that changes each time you create one. They are meant for testing and development.",
      },
      {
        question: "Can I receive webhooks through Cloudflare Tunnel?",
        answer:
          "Yes, a tunnel passes HTTP requests to your local service. A Quick Tunnel's hostname changes each time, so the URL you gave the provider has to be updated; a hostname on your own domain stays. Cloudflare's Tunnel docs describe no request inspector or replay, so what arrived is whatever your app logged.",
      },
    ],
  },
  {
    slug: "webhook-site-vs-requestbin",
    title: "Webhook.site vs RequestBin (Pipedream) Compared (2026)",
    description:
      "Webhook.site vs RequestBin in 2026: Webhook.site is active, while RequestBin lives on Pipedream Workflows, which takes no signups and shuts down on March 31, 2027.",
    keywords: [
      "webhook.site vs requestbin",
      "requestbin vs webhook.site",
      "requestbin alternative",
      "requestbin shutting down",
      "pipedream requestbin",
      "request bin comparison",
    ],
    intro:
      "Webhook.site and RequestBin are the two names people know for a URL that shows what hits it. Only one is still a product you can sign up for. requestbin.com redirects to pipedream.com, and Pipedream is shutting down Workflows, the product that RequestBin became part of, on March 31, 2027.",
    a: {
      name: "Webhook.site",
      compareHref: "/compare/webhook-site",
      about: WEBHOOK_SITE_ABOUT,
      pick: [
        "You are choosing a request inspector today",
        "You want a URL with no signup, or one that never expires on a paid plan",
        "You need email or DNS lookups captured as well",
        "You want your data kept in Europe: its servers are in Germany",
      ],
    },
    b: {
      name: "RequestBin",
      compareHref: "/compare/requestbin",
      about:
        "RequestBin became part of Pipedream, where an HTTP trigger gives a workflow a URL that takes any request. Pipedream has put Workflows in maintenance mode: existing workflows keep running through March 31, 2027, signups and subscriptions are closed, and all Workflows data is to be deleted by April 30, 2027. Pipedream offers an export tool that downloads the structure of your workflows as JSON.",
      pick: [
        "You already run Pipedream workflows and need them until March 2027",
        "You are exporting those workflows before they are deleted",
      ],
    },
    rows: [
      ["Status", "Active", "Part of Pipedream Workflows, which shuts down on March 31, 2027"],
      ["New signups", "Open; a free URL needs none", "Closed"],
      [
        "What you get",
        "A URL, an email address and a DNS name that record what reaches them",
        "An HTTP trigger URL inside a Pipedream workflow",
      ],
      ["Free use", "URLs expire after 1 week and take 50 requests", "Not open to new users"],
      ["Paid plans", WEBHOOK_SITE_PRICES, "No new subscriptions"],
      [
        "Request history",
        "1,000 to 100,000 requests per URL on paid plans",
        "All Workflows data deleted by April 30, 2027",
      ],
      [
        "Acting on a request",
        "Custom Actions, on paid plans",
        "Workflow steps, until the shutdown",
      ],
      ["Forward to localhost", "whcli forward", "Not documented"],
    ],
    sources:
      "Webhook.site as listed on webhook.site/pricing and docs.webhook.site, RequestBin as described in Pipedream's docs (pipedream.com/docs/workflows)",
    fit: [
      "webhooks.cc is the same idea, kept up to date: open the site and you have a URL that shows every request, with no signup (25 requests, kept 12 hours). A free account takes 50 requests a day, keeps them for 7 days, and its endpoints never expire.",
      "It adds what a bin never had: whk tunnel to localhost, SDKs that assert on captured webhooks in CI, email capture, and destinations that send what arrives to your server, Slack, Discord, Google Sheets, Zapier or Make. It has no workflow code steps like Pipedream.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs Webhook.site", href: "/compare/webhook-site" },
      { label: "webhooks.cc vs RequestBin", href: "/compare/requestbin" },
      { label: "All comparisons", href: "/compare" },
    ],
    faq: [
      {
        question: "Is RequestBin still available?",
        answer:
          "Not to new users. requestbin.com redirects to pipedream.com, and Pipedream's docs say Workflows is in maintenance mode: no new signups or subscriptions, existing workflows run through March 31, 2027, and all Workflows data is deleted by April 30, 2027.",
      },
      {
        question: "Webhook.site vs RequestBin: which should I use?",
        answer:
          "Webhook.site, if you are starting now: it is active, gives you a URL without signing up, and has paid plans from $9 a month. RequestBin only makes sense for workflows you already run on Pipedream, and those end in March 2027.",
      },
      {
        question: "What happens to my RequestBin data?",
        answer:
          "Pipedream says all Workflows data, including credentials for connected accounts, will be permanently deleted by April 30, 2027. Its export tool downloads the structure of your workflows as JSON, one project at a time.",
      },
      {
        question: "What is a good RequestBin alternative?",
        answer:
          "For looking at requests, Webhook.site is the closest in spirit. For testing, webhooks.cc gives you the same instant URL plus a CLI tunnel to localhost, SDK assertions in CI and email capture, with a free plan of 50 requests a day.",
      },
    ],
  },
  {
    slug: "mailtrap-vs-mailosaur",
    title: "Mailtrap vs Mailosaur: Email Testing Tools Compared (2026)",
    description:
      "Mailtrap vs Mailosaur for email testing: a fake SMTP sandbox with HTML and spam checks against real test inboxes with SMS and login codes. Plans and prices compared.",
    keywords: [
      "mailtrap vs mailosaur",
      "mailosaur vs mailtrap",
      "mailtrap or mailosaur",
      "email testing tools compared",
      "mailtrap email sandbox pricing",
      "mailosaur pricing",
    ],
    intro:
      "Mailtrap and Mailosaur both catch the email your app sends so a person or a test can look at it. Mailtrap's Email Sandbox is a fake SMTP server for development and staging, sold next to its email sending products. Mailosaur is a testing service: inboxes with real addresses, plus SMS and authenticator codes, aimed at end-to-end tests.",
    a: {
      name: "Mailtrap",
      compareHref: "/compare/mailtrap",
      about:
        "Mailtrap Email Sandbox captures the mail a development or staging environment sends, so it never reaches real customers, and then checks it: an HTML check, spam analysis and a blacklist report are part of every plan, as are the API, a CLI and an MCP server. The free plan takes 50 test emails a month in one sandbox that keeps 10. The same company sells Email Live Sending for production mail.",
      pick: [
        "Staging mail must never reach real people",
        "You want the HTML and the spam score checked before you send",
        "You want testing and production sending from one vendor",
        "A free plan of 50 emails a month is enough",
      ],
    },
    b: {
      name: "Mailosaur",
      compareHref: "/compare/mailosaur",
      about:
        "Mailosaur gives each inbox a domain of its own with unlimited addresses, so every test run can use a fresh one. Its docs cover assertions on links, codes, attachments and spam results, with guides for Playwright, Cypress and Selenium, and an inbox can also act as a dummy SMTP server. SMS testing and email previews are add-ons on the Core plan. There is no free plan, only a 14-day trial.",
      pick: [
        "Each test run needs a fresh, real address",
        "You also test SMS or authenticator (TOTP) codes",
        "You want guides and SDK assertions for Playwright, Cypress or Selenium",
        "You receive thousands of test emails a day",
      ],
    },
    rows: [
      [
        "Built for",
        "Trapping and checking mail from development and staging",
        "End-to-end tests of email, SMS and login codes",
      ],
      [
        "How mail gets in",
        "Fake SMTP server; a sandbox email address from Basic",
        "Real addresses on each inbox's own domain, or SMTP",
      ],
      ["Free plan", "50 test emails a month, 1 sandbox, 1 user", "None; 14-day trial"],
      [
        "Paid plans",
        "Basic $17, Team $42, Business $123, Enterprise $498 a month",
        "Personal from $20/mo, Core from $50/mo, billed annually; Enterprise custom",
      ],
      [
        "Email volume",
        "500, 5,000 or 50,000 a month by plan; unlimited on Enterprise",
        "500 a day on Personal, 2,500 a day on Core",
      ],
      ["Addresses", "One per sandbox, from Basic", "Unlimited per inbox"],
      [
        "Checks on the message",
        "HTML check, spam analysis, blacklist report",
        "Spam checks; compatibility testing on Personal, accessibility testing on Core",
      ],
      [
        "Email client previews",
        "Device Previews add-on on paid plans, on request",
        "Email previews add-on on Core, from $25/mo",
      ],
      [
        "Beyond test email",
        "Production sending by API or SMTP",
        "SMS testing on Core, from $37.50/mo; authenticator (TOTP) codes",
      ],
      [
        "SDKs",
        "Node.js, Python, PHP, Ruby, Java, .NET, Go, Elixir",
        "Node.js, Java, Ruby, Python, .NET, PHP, Go",
      ],
      [
        "Forward to a real inbox",
        "From Basic: 100 to 10,000 forwarded emails a month",
        "Single emails on Personal; rules and auto-forwarding on Core",
      ],
      [
        "Users",
        "1 on Free, 3 on Basic, 5 on Team, 50 on Business",
        "1 on Personal (up to 3), 5 on Core",
      ],
      ["Single sign-on", "Enterprise", "Enterprise (SAML2 and OIDC)"],
    ],
    sources:
      "Mailtrap as listed on mailtrap.io/pricing (Email Sandbox, monthly billing) and docs.mailtrap.io, Mailosaur as listed on mailosaur.com/pricing and in its docs",
    fit: [
      "webhooks.cc takes Mailosaur's route, real addresses, at a lower price and with webhooks on the same endpoint. Every endpoint on an account has an address at {slug}@mailhooks.cc, a +tag gives each test run its own, and the SDKs for TypeScript, Python and Go wait for the email and return its one-time code or link.",
      "The free plan takes 50 emails a day; Pro is $8 a month for 100,000 emails or webhooks. It has no fake SMTP server, no SMS numbers and no email client screenshots, so for those Mailtrap or Mailosaur is the better fit.",
    ],
    fitLinks: [
      { label: "webhooks.cc vs Mailtrap", href: "/compare/mailtrap" },
      { label: "webhooks.cc vs Mailosaur", href: "/compare/mailosaur" },
      { label: "Email testing", href: "/email-testing" },
    ],
    faq: [
      {
        question: "Mailtrap vs Mailosaur: which is cheaper?",
        answer:
          "Mailtrap starts lower: Email Sandbox has a free plan of 50 test emails a month and paid plans from $17 a month for 500. Mailosaur has no free plan; Personal is from $20 a month billed annually and allows 500 emails a day. Per email, Mailosaur's plans carry far more volume. Prices from each pricing page in November 2026.",
      },
      {
        question: "Does Mailosaur have a free plan?",
        answer:
          "No. Mailosaur offers a 14-day free trial. Mailtrap's Email Sandbox has a free plan with 50 test emails a month, one sandbox and one user.",
      },
      {
        question: "Which is better for Playwright or Cypress tests?",
        answer:
          "Mailosaur is built for that: unlimited addresses per inbox, and docs for Playwright, Cypress and Selenium with assertions on links and codes. Mailtrap's sandbox is a fake SMTP server with an API for reading messages, which fits checking what staging sends more than driving a signup flow.",
      },
      {
        question: "What is the main difference between Mailtrap and Mailosaur?",
        answer:
          "Mailtrap Email Sandbox traps mail by replacing your app's SMTP settings and then analyses the message (HTML, spam score, blacklists). Mailosaur receives mail at real addresses and is organised around automated tests, with SMS and authenticator codes next to email.",
      },
    ],
    ctaHeading: "Start testing email in under a minute",
  },
];

/** The pair page at /compare/<slug>, or undefined. */
export function comparePair(slug: string): ComparePair | undefined {
  return COMPARE_PAIRS.find((pair) => pair.slug === slug);
}

/** The pair page at /compare/<slug>; a page file names a slug that must exist. */
export function requireComparePair(slug: string): ComparePair {
  const pair = comparePair(slug);
  if (!pair) throw new Error(`No pair comparison is defined for /compare/${slug}`);
  return pair;
}

/** "ngrok vs Hookdeck": the pair's name, as its heading and breadcrumb say it. */
export function comparePairName(pair: ComparePair): string {
  return `${pair.a.name} vs ${pair.b.name}`;
}

/** The pair pages that compare a given tool, by its own page (/compare/ngrok). */
export function comparePairsFor(compareHref: string): readonly ComparePair[] {
  return COMPARE_PAIRS.filter(
    (pair) => pair.a.compareHref === compareHref || pair.b.compareHref === compareHref
  );
}
