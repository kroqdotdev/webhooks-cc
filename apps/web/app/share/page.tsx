import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, howToSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { StartFreeCTA } from "@/components/landing/start-free-cta";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { CodeSample } from "@/components/share/code-sample";
import { ENTITLEMENTS, type Entitlements } from "@/lib/entitlements";
import { sessionText } from "@/lib/tunnels/plan-text";
import {
  getAllShareFrameworkPages,
  SHARE_FRAMEWORK_GROUPS,
  shareCommand,
} from "@/lib/share-framework-pages";
import { Card } from "@/components/ui/card";

const PATH = "/share";

export const metadata = createPageMetadata({
  title: "Share Localhost at a Public URL With One Command",
  description:
    "whk share 3000 puts your local dev server at an HTTPS link on sharehooks.cc. Hot reload and WebSockets work, your dev server sees Host: localhost, and it is free to start. Setup guides for Next.js, Vite, Rails, Django, Laravel and more.",
  path: PATH,
  keywords: [
    "share localhost",
    "expose localhost to the internet",
    "localhost tunnel",
    "public url for localhost",
    "share dev server",
    "ngrok alternative",
    "localhost to public url",
    "expose local server",
    "invalid host header",
    "whk share",
  ],
});

const SESSION_OUTPUT = `$ whk share 3000

  ● Sharing
  Link:          https://sample-preview-1234.sharehooks.cc
  Forwarding to: localhost:3000`;

const STEPS = [
  {
    name: "Install the CLI",
    text: "One line on macOS and Linux. The installation page has Windows binaries and the other ways to install.",
    code: "curl -fsSL https://webhooks.cc/install.sh | sh",
  },
  {
    name: "Log in once",
    text: "Opens your browser to confirm a code. Sharing needs an account with a confirmed email address; a free one will do.",
    code: "whk auth login",
  },
  {
    name: "Start your dev server, then share its port",
    text: "The CLI prints the link and draws it as a QR code for your phone. Press Ctrl-C to stop sharing. If your connection drops, the CLI reconnects and the link stays the same.",
    code: "whk share 3000",
  },
];

/** What a request looks like when it reaches the local server (apps/edge-rs/src/main.rs). */
const SEEN = [
  {
    title: "Host is localhost",
    text: "Your server gets Host: localhost:3000, as if you had opened it yourself, so a dev server's host check has nothing to refuse. The public name travels in X-Forwarded-Host, with X-Forwarded-Proto: https and the visitor's address in X-Forwarded-For.",
  },
  {
    title: "WebSockets and streams pass",
    text: "Hot reload sockets, your own WebSockets and server-sent events go through the same link. A socket's Origin is sent as your local origin, which is what dev servers expect from their own pages.",
  },
  {
    title: "Redirects come back to the link",
    text: "A redirect your app sends to http://localhost:3000/... is rewritten to the public address, so a login flow does not strand a visitor on their own localhost.",
  },
  {
    title: "Cookies stay on the link",
    text: "Cookies your app sets without a Domain work as usual. One set for another domain (Domain=localhost, for one) is dropped, since the visitor's browser is on the sharehooks.cc name.",
  },
];

const REFUSED = [
  "Web pages only: HTML, CSS, JavaScript, JSON, XML, images, fonts, WebAssembly and text",
  "No videos, audio, documents, archives or downloads; no response over 50 MB",
  "Plain HTTP on the local port; a local HTTPS server is refused",
  "50 requests a second per share, with room for a page load's burst of a few hundred",
];

function planRow(
  name: string,
  e: Readonly<Entitlements>,
  per: "account" | "member"
): [string, string, string, string, string, string] {
  const each = per === "member" ? " per member" : "";
  const names =
    e.reservedNames === 0
      ? "Random names only"
      : per === "member"
        ? `${e.reservedNames} per seat, the team's`
        : String(e.reservedNames);
  return [
    name,
    `${e.shareSlots}${each}`,
    names,
    sessionText(e.shareSessionMinutes),
    `${e.shareDataGb} GB${each}`,
    e.sharePasswords ? "Yes" : "No",
  ];
}

const PLAN_ROWS = [
  planRow("Free", ENTITLEMENTS.free, "account"),
  planRow("Pro", ENTITLEMENTS.pro, "account"),
  planRow("Business", ENTITLEMENTS.business, "account"),
  planRow("Teams", ENTITLEMENTS.team, "member"),
  planRow("Team Business", ENTITLEMENTS.team_business, "member"),
];

const NAMES_SAMPLE = `whk names reserve acme          # keep acme.sharehooks.cc
whk share 3000 --name acme      # the same link every time
whk share 3000 --password       # ask visitors for a password
whk names password acme         # or put one on the name itself`;

const TUNNEL_ROWS = [
  [
    "For",
    "People opening your site in a browser",
    "A webhook sender waiting for your app's answer",
  ],
  ["Command", "whk share 3000", "whk tunnel 3000 --live"],
  [
    "Public address",
    "https://<name>.sharehooks.cc, the whole port",
    "https://go.webhooks.cc/w/<slug>, a webhooks.cc endpoint",
  ],
  [
    "What is kept",
    "The last requests while the share runs: method, path and status",
    "Every request and your app's response, in the dashboard, CLI, SDKs and MCP server",
  ],
  [
    "Answers passed on",
    "Web pages up to 50 MB, with WebSockets",
    "API answers up to 1 MB: JSON, XML, text or form data",
  ],
  ["Counts against", "The plan's shared data for the month", "The plan's request quota"],
] as const;

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "How do I share localhost with a public URL?",
    answer:
      "Install the whk CLI, run whk auth login once, start your dev server and run whk share with its port, such as whk share 3000. The CLI prints an HTTPS link on sharehooks.cc that sends every visitor to your local port until you press Ctrl-C.",
  },
  {
    question: "Is there a free way to expose localhost to the internet?",
    answer: `Yes. Sharing is on every webhooks.cc plan, Free included: ${ENTITLEMENTS.free.shareSlots} share at a time, ${sessionText(ENTITLEMENTS.free.shareSessionMinutes)} per session and ${ENTITLEMENTS.free.shareDataGb} GB of data a month. A free link gets a random name ending in -free and shows visitors a short notice page once a week per browser. There is no separate subscription for sharing.`,
  },
  {
    question: "Why is there no Invalid Host header or Blocked request error?",
    answer:
      "Those come from dev servers that refuse a Host they do not know, which is what most tunnels send. whk share sends your server Host: localhost with its port and carries the public name in X-Forwarded-Host, so webpack-dev-server, Vite and others see their own address. Frameworks that read X-Forwarded-Host or compare a form's Origin still need one setting; the framework guides name it.",
  },
  {
    question: "Does hot reload work through the link?",
    answer:
      "Yes, when the dev server's reload socket uses the same port as the page, which is the default in Next.js, Nuxt, Vite, SvelteKit, Astro and Angular. WebSockets pass through the link, so a page someone has open updates as you edit. A share is one port: a dev server that serves assets or its reload socket from a second port needs that changed, and the framework guides say where.",
  },
  {
    question: "Can I keep the same URL between sessions?",
    answer: `On Pro, Business and team plans. Reserve a name with whk names reserve acme and share with whk share 3000 --name acme; the link is acme.sharehooks.cc every time. Pro keeps ${ENTITLEMENTS.pro.reservedNames} names and Business ${ENTITLEMENTS.business.reservedNames}. Free shares get a new random name each session.`,
  },
  {
    question: "Is whk share an ngrok alternative?",
    answer:
      "For showing a local web app to someone, yes: one command, an HTTPS link, WebSockets and hot reload, with reserved names and passwords on paid plans. It is not a general tunnel: it carries web pages over HTTP, with no TCP tunnels, no domains of your own, and no downloads or video. The ngrok comparison lists both side by side.",
  },
  {
    question: "Can a webhook provider call my local server through the link?",
    answer:
      "Use whk tunnel for that instead. It gives the provider a webhooks.cc endpoint URL that stays the same, keeps every request so you can inspect and replay it, and forwards it to your local port; with --live the provider gets your local app's own answer.",
  },
  {
    question: "Is it safe to share a dev server?",
    answer:
      "Anyone with the link can use the site while the share runs, so share what you would show. Nothing is opened on your machine: the CLI makes one outbound connection and only the port you named is reachable. On paid plans a password keeps strangers out, and whk shares stop ends a share from another terminal. Debug consoles that run code, such as Werkzeug's, are refused by the link.",
  },
];

export default function SharePage() {
  const frameworks = getAllShareFrameworkPages();

  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Share localhost", path: PATH },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <JsonLd
        data={howToSchema({
          name: "How to share localhost at a public URL",
          description:
            "Put a local dev server at a public HTTPS link with the whk CLI from webhooks.cc.",
          steps: STEPS.map((step) => ({ name: step.name, text: `${step.text} Run: ${step.code}` })),
          totalTime: "PT2M",
        })}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            Share localhost at a public URL
          </h1>
          <p className="text-xl text-muted-foreground mb-6">
            One command puts the site running on your machine at an HTTPS link, so a client, a
            teammate or your phone can open it while you keep editing. Nothing is opened on your
            machine, and it is free to start.
          </p>
          <div className="mb-6">
            <CodeSample code={SESSION_OUTPUT} copy="whk share 3000" />
          </div>
          <StartFreeCTA goCta={null} />
          <p className="text-sm text-muted-foreground mt-4">
            Every option is in the{" "}
            <Link href="/docs/share" className="text-primary font-bold hover:underline">
              whk share docs
            </Link>
            . Using a framework? Jump to{" "}
            <Link href="#frameworks" className="text-primary font-bold hover:underline">
              its guide
            </Link>
            .
          </p>
        </div>

        <section id="install" className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Install and first run</h2>
          <ol className="space-y-6">
            {STEPS.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <span className="w-9 h-9 border rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0 shadow-surface">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold mb-0.5">{step.name}</h3>
                  <p className="text-muted-foreground text-sm mb-3">{step.text}</p>
                  <CodeSample code={step.code} />
                </div>
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted-foreground mt-6">
            The target is a port on this machine: <code className="font-mono">3000</code>,{" "}
            <code className="font-mono">localhost:3000</code> or{" "}
            <code className="font-mono">127.0.0.1:3000</code>. Other ways to install are on the{" "}
            <Link href="/installation" className="text-primary font-bold hover:underline">
              installation page
            </Link>
            .
          </p>
        </section>

        <section id="what-your-server-sees" className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">What your dev server sees</h2>
          <p className="text-muted-foreground mb-6">
            Visitors&apos; requests travel down one outbound connection from the CLI to your port,
            and the answers go back the same way. On the way in, the link makes each request look
            local, which is why most dev servers need no setup at all.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {SEEN.map((item) => (
              <Card key={item.title}>
                <h3 className="font-bold mb-1.5">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.text}</p>
              </Card>
            ))}
          </div>
          <ul className="mt-6 space-y-2 text-sm text-muted-foreground list-disc pl-5">
            {REFUSED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section id="frameworks" className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Framework guides</h2>
          <p className="text-muted-foreground mb-6">
            The port to share, whether hot reload comes along, and the one setting a framework may
            still want when its pages are opened from a public name: a trusted origin for forms, a
            trusted proxy for links and cookies.
          </p>
          {SHARE_FRAMEWORK_GROUPS.map((group) => (
            <div key={group} className="mb-8 last:mb-0">
              <h3 className="font-bold text-lg mb-4">{group}</h3>
              <div className="grid sm:grid-cols-2 gap-4">
                {frameworks
                  .filter((framework) => framework.group === group)
                  .map((framework) => (
                    <Card
                      interactive
                      key={framework.slug}
                      className="block group"
                      render={<Link href={`/share/${framework.slug}`} />}
                    >
                      <div className="flex items-baseline justify-between gap-3 mb-1.5">
                        <h4 className="font-bold text-lg group-hover:text-primary transition-colors">
                          {framework.label}
                        </h4>
                        <code className="font-mono text-xs text-muted-foreground shrink-0">
                          {shareCommand(framework)}
                        </code>
                      </div>
                      <p className="text-sm text-muted-foreground">{framework.card}</p>
                    </Card>
                  ))}
              </div>
            </div>
          ))}
        </section>

        <section id="plans" className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">What each plan allows</h2>
          <p className="text-muted-foreground mb-6">
            Sharing comes with every plan; there is no separate subscription for it.
          </p>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  {[
                    "Plan",
                    "Shares at once",
                    "Reserved names",
                    "Session",
                    "Data a month",
                    "Passwords",
                  ].map((column) => (
                    <th key={column} scope="col" className="text-left py-2 pr-6 font-bold">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PLAN_ROWS.map((row) => (
                  <tr key={row[0]} className="border-b border-foreground/10 last:border-0">
                    {row.map((cell, i) => (
                      <td key={i} className={`py-2 pr-6 ${i === 0 ? "font-medium" : ""}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-sm text-muted-foreground mt-3">
            Data is what passes through your shares both ways, counted per calendar month. A Free
            link has a random name ending in <code className="font-mono">-free</code> and shows
            visitors a short notice page first, once a week per browser; paid links show it only
            during the plan&apos;s first 7 days. Your limits are the best of your own plan and any
            subscribed team you belong to. Prices and the rest of each plan are on the{" "}
            <Link href="/pricing" className="text-primary font-bold hover:underline">
              pricing page
            </Link>
            ; the full limits are in{" "}
            <Link
              href="/docs/plans-limits#sharing-localhost"
              className="text-primary font-bold hover:underline"
            >
              plans and limits
            </Link>
            .
          </p>
        </section>

        <section id="names" className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Reserved names and passwords</h2>
          <p className="text-muted-foreground mb-6">
            On Pro, Business and team plans, reserve a name once and share under it as often as you
            like, so the link you sent last week still works. A password puts a page in front of the
            site; a visitor who gets it right is remembered for 7 days.
          </p>
          <CodeSample code={NAMES_SAMPLE} />
          <p className="text-sm text-muted-foreground mt-3">
            Names use lowercase letters, digits and hyphens. A name reserved inside a team belongs
            to the team, and every member can share under it. See{" "}
            <Link href="/docs/share#names" className="text-primary font-bold hover:underline">
              names
            </Link>{" "}
            and{" "}
            <Link href="/docs/share#passwords" className="text-primary font-bold hover:underline">
              passwords
            </Link>{" "}
            in the docs.
          </p>
        </section>

        <section id="live-tunnel" className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">whk share or whk tunnel --live</h2>
          <p className="text-muted-foreground mb-6">
            Both reach a port on your machine from the internet, for different callers. A share
            serves your site to people. A{" "}
            <Link href="/docs/live-tunnel" className="text-primary font-bold hover:underline">
              live tunnel
            </Link>{" "}
            answers a webhook sender, such as a Slack slash command or Twilio, with your local
            app&apos;s response, and keeps the request.
          </p>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="text-left py-2 pr-6 font-bold">
                    <span className="sr-only">Difference</span>
                  </th>
                  <th scope="col" className="text-left py-2 pr-6 font-bold font-mono">
                    whk share
                  </th>
                  <th scope="col" className="text-left py-2 font-bold font-mono">
                    whk tunnel --live
                  </th>
                </tr>
              </thead>
              <tbody>
                {TUNNEL_ROWS.map(([label, share, live]) => (
                  <tr key={label} className="border-b border-foreground/10 last:border-0">
                    <th scope="row" className="text-left align-top py-2 pr-6 font-medium">
                      {label}
                    </th>
                    <td className="py-2 pr-6 align-top">{share}</td>
                    <td className="py-2 align-top">{live}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-sm text-muted-foreground mt-3">
            A plain <code className="font-mono">whk tunnel 3000</code> answers the sender at once
            and then replays each webhook to your port; see{" "}
            <Link href="/docs/cli/tunnel" className="text-primary font-bold hover:underline">
              the tunnel docs
            </Link>
            .
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Compared with other tunnels</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <Card interactive className="block group" render={<Link href="/compare/ngrok" />}>
              <h3 className="font-bold text-lg mb-1.5 group-hover:text-primary transition-colors">
                webhooks.cc vs ngrok
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                Free and paid links side by side: names, data, the browser notice, passwords, and
                where ngrok&apos;s TCP tunnels and own domains still win.
              </p>
              <span className="text-sm font-bold">
                Read the comparison
                <ArrowRight className="inline-block ml-1 h-4 w-4" />
              </span>
            </Card>
            <Card interactive className="block group" render={<Link href="/compare/localtunnel" />}>
              <h3 className="font-bold text-lg mb-1.5 group-hover:text-primary transition-colors">
                webhooks.cc vs LocalTunnel
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                The free open-source tunnel next to a maintained one with request history, replay
                and stable URLs.
              </p>
              <span className="text-sm font-bold">
                Read the comparison
                <ArrowRight className="inline-block ml-1 h-4 w-4" />
              </span>
            </Card>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Sharing localhost questions</h2>
          <FAQAccordion items={FAQ_ITEMS} />
        </section>

        <Card interactive className="bg-foreground text-background text-center py-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-3">Your first link in two minutes</h2>
          <p className="opacity-80 mb-6 max-w-md mx-auto">
            Sign up free, install the CLI and run whk share with your port.
          </p>
          <div className="flex justify-center">
            <PricingCTA inverted />
          </div>
          <p className="text-sm opacity-80 mt-6">No credit card</p>
        </Card>
      </div>
    </main>
  );
}
