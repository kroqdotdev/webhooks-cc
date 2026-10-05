import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Subprocessors",
  description:
    "The companies that process personal data for webhooks.cc: what each one does, what data it receives, where it processes it, and how transfers outside the EU are covered.",
  path: "/subprocessors",
});

const linkClass = "text-primary hover:underline font-bold";

interface Subprocessor {
  name: string;
  entity: string;
  purpose: string;
  data: string;
  location: string;
  safeguard?: string;
}

const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Hetzner",
    entity: "Hetzner Online GmbH, Germany",
    purpose: "Hosts the server that runs webhooks.cc, its database, and its backups.",
    data: "All data described in our privacy policy, including captured webhooks.",
    location: "Falkenstein, Germany. Backups stay in Falkenstein, in a separate data center.",
  },
  {
    name: "Cloudflare",
    entity: "Cloudflare, Inc., United States",
    purpose:
      "DNS, attack protection, and secure delivery for every webhooks.cc address, and the relay that sends endpoint notifications.",
    data: "All traffic in transit, including the webhooks sent to your endpoints and the notifications sent from them, and visitor IP addresses.",
    location:
      "Cloudflare's global network: requests are handled at the data center nearest the sender, and logs and metadata are kept in the United States and Europe",
    safeguard: "EU-US Data Privacy Framework and Standard Contractual Clauses",
  },
  {
    name: "Webdock",
    entity: "Webdock.io ApS, Denmark",
    purpose: "Hosts the mail server that sends our emails.",
    data: "Recipient email addresses and the contents of the emails we send.",
    location: "Copenhagen, Denmark",
  },
  {
    name: "Amazon SES",
    entity: "Amazon Web Services EMEA SARL, Luxembourg",
    purpose: "Delivers the emails our mail server sends.",
    data: "Recipient email addresses and the contents of the emails we send.",
    location: "Frankfurt, Germany (AWS region eu-central-1)",
  },
  {
    name: "PostHog",
    entity: "PostHog, Inc., United States",
    purpose: "Product analytics.",
    data: "Page views, clicks, page load performance, an anonymous browser identifier, IP addresses, and the account ID, email address, and plan of signed-in users.",
    location: "Stored in PostHog's EU region in Frankfurt, Germany",
    safeguard: "EU-US Data Privacy Framework and Standard Contractual Clauses",
  },
  {
    name: "AppSignal",
    entity: "AppSignal B.V., Netherlands",
    purpose: "Error and performance monitoring.",
    data: "Error reports, request paths and timings, and server metrics. Never the contents of captured webhooks.",
    location: "European Union (the Netherlands, Ireland, and Germany)",
  },
];

export default function SubprocessorsPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b-strong border-line shrink-0 bg-background sticky top-0 z-50">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-bold text-lg">
              webhooks.cc
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 md:px-10">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">Subprocessors</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: October 5, 2026</p>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            enkelt.design, the business behind webhooks.cc, uses the companies below to run the
            service. Each one processes personal data on our behalf, only for the purpose listed.
            Our{" "}
            <Link href="/privacy" className={linkClass}>
              privacy policy
            </Link>{" "}
            explains what we collect and why.
          </p>
        </div>

        {SUBPROCESSORS.map((sub) => (
          <section key={sub.name} className="border-t-strong border-line pt-8 mt-8">
            <h2 className="text-xl font-bold mb-3">{sub.name}</h2>
            <dl className="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <dt className="font-bold text-foreground">Company</dt>
              <dd className="mb-2 sm:mb-0">{sub.entity}</dd>
              <dt className="font-bold text-foreground">Purpose</dt>
              <dd className="mb-2 sm:mb-0">{sub.purpose}</dd>
              <dt className="font-bold text-foreground">Data</dt>
              <dd className="mb-2 sm:mb-0">{sub.data}</dd>
              <dt className="font-bold text-foreground">Location</dt>
              <dd className="mb-2 sm:mb-0">{sub.location}</dd>
              {sub.safeguard && (
                <>
                  <dt className="font-bold text-foreground">Transfer basis</dt>
                  <dd>{sub.safeguard}</dd>
                </>
              )}
            </dl>
          </section>
        ))}

        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Payments</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Paid plans are sold by Polar Software, Inc. (United States) as merchant of record: you
              buy the subscription from Polar, which handles checkout, payment through Stripe,
              invoices, and sales tax as a separate controller under its{" "}
              <a
                href="https://polar.sh/legal/privacy-policy"
                className={linkClass}
                target="_blank"
                rel="noopener noreferrer"
              >
                own privacy policy
              </a>
              . To set up a checkout we send Polar your email address, name, and account ID, or for
              a team subscription the team&apos;s name and ID and the owner&apos;s email address.
              Polar stores this data in the United States, and the transfer is covered by the
              European Commission&apos;s Standard Contractual Clauses.
            </p>
          </div>
        </section>

        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Sign-In Providers</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              If you choose to sign in with GitHub or Google, that company handles the sign-in as a
              separate controller under its own privacy policy and shares your email address, name,
              and profile picture with us. They are not our subprocessors and receive nothing else
              from webhooks.cc.
            </p>
          </div>
        </section>

        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Software We Run Ourselves</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Supabase (database and sign-in), Redis (rate limiting), and Caddy (web server) are
              open-source software running on our own server at Hetzner. The companies behind them
              receive no data from webhooks.cc.
            </p>
          </div>
        </section>

        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Changes</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              We update this list when we add or replace a subprocessor. Questions? Email{" "}
              <a href="mailto:support@webhooks.cc" className={linkClass}>
                support@webhooks.cc
              </a>
              .
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
