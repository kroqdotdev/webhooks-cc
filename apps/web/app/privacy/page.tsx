import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Privacy Policy",
  description:
    "How webhooks.cc handles personal data: who runs the service, what we collect and why, where it is stored in the EU, how long we keep it, and your rights under the GDPR.",
  path: "/privacy",
});

const linkClass = "text-primary hover:underline font-bold";

function SupportEmail() {
  return (
    <a href="mailto:support@webhooks.cc" className={linkClass}>
      support@webhooks.cc
    </a>
  );
}

export default function PrivacyPage() {
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
        <h1 className="text-3xl md:text-4xl font-bold mb-4">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: October 5, 2026</p>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            webhooks.cc is a webhook inspection and testing tool. This policy explains what personal
            data we collect, why, where it is stored, how long we keep it, and the rights you have
            under the EU General Data Protection Regulation (GDPR).
          </p>
        </div>

        {/* Who We Are */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Who We Are</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              webhooks.cc is run by enkelt.design, a personally owned Danish business (personligt
              ejet mindre virksomhed) owned and operated by Mads Sauer. enkelt.design is the data
              controller for the personal data described in this policy.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="font-bold text-foreground">Business</dt>
              <dd>enkelt.design</dd>
              <dt className="font-bold text-foreground">CVR</dt>
              <dd>45871290</dd>
              <dt className="font-bold text-foreground">Address</dt>
              <dd>Lille Bygade 13, 2635 Ishøj, Denmark</dd>
              <dt className="font-bold text-foreground">Email</dt>
              <dd>
                <SupportEmail />
              </dd>
            </dl>
          </div>
        </section>

        {/* Where Your Data Is Stored */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Where Your Data Is Stored</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Our servers are in the European Union. The database that holds accounts, endpoints,
              captured requests, teams, and billing records runs on a server we rent from Hetzner
              Online GmbH in Falkenstein, Germany, and Hetzner keeps the backups of that server in
              Falkenstein too. Supabase, the database and sign-in software we use, runs on that same
              server; Supabase Inc. does not receive your data.
            </p>
            <p>
              The emails we send leave from our own mail server in Copenhagen, Denmark, and are
              delivered through Amazon SES in Frankfurt, Germany. Product analytics are stored in
              PostHog&apos;s EU region in Frankfurt.
            </p>
            <p>
              All traffic to webhooks.cc, including every webhook sent to an endpoint, passes
              through Cloudflare, which protects the site against attacks. Cloudflare decrypts and
              re-encrypts each request at the data center nearest to whoever sent it, which can be
              outside the EU. A few of the services we use are run by companies based in the United
              States; see{" "}
              <a href="#international-transfers" className={linkClass}>
                International Transfers
              </a>{" "}
              below and our{" "}
              <Link href="/subprocessors" className={linkClass}>
                list of subprocessors
              </Link>
              .
            </p>
          </div>
        </section>

        {/* What We Collect */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">What We Collect</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">Account info.</span> When you sign in with
              GitHub or Google, we receive your email address, display name, and profile picture
              from the OAuth provider. When you sign up with an email address and password, we
              receive the email address you provide; the password is stored only as a salted hash by
              our authentication system (Supabase GoTrue).
            </p>
            <p>
              <span className="font-bold text-foreground">Teams.</span> If you create or join a
              team, we store the team name, its members and their roles, and the email addresses of
              people invited to it.
            </p>
            <p>
              <span className="font-bold text-foreground">Webhook data.</span> We store the requests
              sent to your endpoints: HTTP method, path, headers, query parameters, request body,
              and sender IP address. Captured requests can contain personal data about other people,
              depending on what your senders include; see{" "}
              <a href="#webhook-contents" className={linkClass}>
                Webhook Contents
              </a>
              .
            </p>
            <p>
              <span className="font-bold text-foreground">Notifications.</span> If you set a
              notification URL on an endpoint, each captured request sends its method, path, sender
              IP address, time, and the start of its body to that URL. You choose the destination.
            </p>
            <p>
              <span className="font-bold text-foreground">API keys.</span> We store API keys only as
              a hash, together with the name you give them, when they were created, and when they
              were last used.
            </p>
            <p>
              <span className="font-bold text-foreground">Billing identifiers.</span> If you
              subscribe to a paid plan, we store your Polar customer ID and subscription ID. Your
              payment details are collected by Polar; we never see or store payment card details.
            </p>
            <p>
              <span className="font-bold text-foreground">Audit and sign-in records.</span> When you
              change account, team, billing, API key, or endpoint settings, we record what changed,
              when, and your browser&apos;s user agent. Our sign-in system records sign-ups,
              sign-ins, and password resets together with your email address.
            </p>
            <p>
              <span className="font-bold text-foreground">Usage counts.</span> We count captured
              requests per endpoint per day. The counts contain no request contents.
            </p>
            <p>
              <span className="font-bold text-foreground">Server logs.</span> Our servers write
              technical logs, which can include IP addresses, so we can diagnose problems and stop
              abuse. Error reports and performance measurements go to AppSignal; they never include
              the contents of captured webhooks.
            </p>
            <p>
              <span className="font-bold text-foreground">Analytics.</span> See{" "}
              <a href="#analytics" className={linkClass}>
                Analytics
              </a>{" "}
              below.
            </p>
          </div>
        </section>

        {/* Why We Use It */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Why We Use It</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">
                To provide the service you signed up for
              </span>{" "}
              (GDPR Art.&nbsp;6(1)(b), performance of a contract): signing you in, capturing and
              showing your webhooks, teams, notifications, billing, and service emails such as
              sign-up confirmations, team invites, and quota notices.
            </p>
            <p>
              <span className="font-bold text-foreground">
                To keep the service secure and working
              </span>{" "}
              (GDPR Art.&nbsp;6(1)(f), legitimate interest): rate limiting, abuse prevention, audit
              records, error monitoring, and server logs.
            </p>
            <p>
              <span className="font-bold text-foreground">To improve the product</span> (GDPR
              Art.&nbsp;6(1)(f), legitimate interest): the analytics described below.
            </p>
            <p>We do not sell your data or use it for advertising.</p>
          </div>
        </section>

        {/* Webhook Contents */}
        <section id="webhook-contents" className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Webhook Contents</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              You decide what is sent to your endpoints. If captured requests contain personal data
              about other people, you are responsible for having a lawful basis to send it to us. We
              process that data only to provide the service to you: we store it, show it to you and
              your team, deliver the notifications you set up, and delete it on schedule. We do not
              use it for anything else.
            </p>
            <p>
              If your organization needs a data processing agreement (DPA) under GDPR
              Article&nbsp;28, email <SupportEmail />. We review each request individually and reply
              with what we can offer.
            </p>
          </div>
        </section>

        {/* Third-Party Services */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Third-Party Services</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>We use these companies to run webhooks.cc:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Hetzner hosts our servers and backups in Germany</li>
              <li>Cloudflare protects and delivers all traffic to webhooks.cc</li>
              <li>Webdock hosts our mail server in Denmark</li>
              <li>Amazon SES delivers our emails from Germany</li>
              <li>PostHog provides product analytics from its EU region</li>
              <li>AppSignal provides error and performance monitoring</li>
              <li>Polar sells our paid plans as merchant of record and processes payments</li>
            </ul>
            <p>
              Our{" "}
              <Link href="/subprocessors" className={linkClass}>
                list of subprocessors
              </Link>{" "}
              shows what each one receives and where. If you sign in with GitHub or Google, that
              provider handles the sign-in under its own privacy policy. We do not use advertising
              networks.
            </p>
          </div>
        </section>

        {/* International Transfers */}
        <section id="international-transfers" className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">International Transfers</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Cloudflare, PostHog, and Polar are companies based in the United States, as are GitHub
              and Google if you use them to sign in. Where your personal data reaches a company
              outside the EU or EEA, the transfer is covered by the EU-US Data Privacy Framework,
              the European Commission&apos;s Standard Contractual Clauses, or both. Our list of
              subprocessors shows which applies to each company.
            </p>
          </div>
        </section>

        {/* Analytics */}
        <section id="analytics" className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Analytics</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              We use{" "}
              <a
                href="https://posthog.com"
                className={linkClass}
                target="_blank"
                rel="noopener noreferrer"
              >
                PostHog
              </a>{" "}
              to understand how people use webhooks.cc. PostHog keeps a random anonymous identifier
              in your browser&apos;s localStorage to recognize returning visitors on webhooks.cc. It
              does not use cookies and does not track you across other sites.
            </p>
            <p>
              <span className="font-bold text-foreground">What we collect.</span> Page views, time
              on page, clicks on links and buttons, page load performance, referrer URL, UTM
              campaign parameters, and which of our two visual styles you see. For signed-in users
              we associate these events with your account and send your email address and plan with
              them. Like any web request, sending them reveals your IP address to PostHog.
            </p>
            <p>
              <span className="font-bold text-foreground">What we do not collect.</span> We do not
              record your sessions, fingerprint your browser, track you across sites, or build
              advertising profiles.
            </p>
            <p>
              <span className="font-bold text-foreground">Legal basis.</span> We process this data
              under legitimate interest (GDPR Art.&nbsp;6(1)(f)) to improve our service. You can
              object by emailing us, or opt out by using a standard content blocker that blocks
              PostHog.
            </p>
            <p>
              <span className="font-bold text-foreground">Data location.</span> Analytics events are
              sent through our own address, f.webhooks.cc, to PostHog&apos;s EU region and stored
              there. See PostHog&apos;s{" "}
              <a
                href="https://posthog.com/privacy"
                className={linkClass}
                target="_blank"
                rel="noopener noreferrer"
              >
                privacy policy
              </a>
              .
            </p>
          </div>
        </section>

        {/* Data Retention */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Data Retention</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">Free plan:</span> Captured requests are
              deleted 7 days after they are received.
            </p>
            <p>
              <span className="font-bold text-foreground">Pro plan:</span> Captured requests are
              deleted 31 days after they are received.
            </p>
            <p>
              <span className="font-bold text-foreground">Team-shared endpoints:</span> Requests
              billed to a team&apos;s subscription are retained for 31 days regardless of the
              endpoint owner&apos;s plan.
            </p>
            <p>
              <span className="font-bold text-foreground">Guest endpoints:</span> Endpoints created
              without an account, and their requests, are deleted 12 hours after they are created.
            </p>
            <p>
              <span className="font-bold text-foreground">Account data:</span> Your account,
              endpoints, teams, and API keys are kept until you delete them or your account.
            </p>
            <p>
              <span className="font-bold text-foreground">Audit and sign-in records:</span> Deleted
              after one year.
            </p>
            <p>
              <span className="font-bold text-foreground">Usage counts:</span> Kept after the
              requests themselves are deleted, so usage history stays available. When you delete
              your account they are no longer linked to you.
            </p>
            <p>
              <span className="font-bold text-foreground">Server logs:</span> Kept in size-limited
              files that are overwritten automatically as new entries arrive.
            </p>
            <p>
              <span className="font-bold text-foreground">Backups:</span> Hetzner keeps seven daily
              backups of our server and deletes the oldest each time it makes a new one, so data you
              delete leaves the backups after about a week.
            </p>
            <p>
              <span className="font-bold text-foreground">Billing records:</span> Polar keeps the
              records of your purchases as the law requires of a seller.
            </p>
          </div>
        </section>

        {/* Cookies & Storage */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Cookies & Storage</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">Cookies.</span> Supabase sets the cookies
              that keep you signed in. When you create an account we also set a short-lived cookie (
              <code className="text-xs bg-muted px-1 py-0.5 rounded">whk_signup</code>, at most one
              hour) so our analytics can count the new account; it is deleted as soon as it has been
              read. We do not use tracking cookies.
            </p>
            <p>
              <span className="font-bold text-foreground">localStorage.</span> Your theme and visual
              style, which style you were assigned to if you are part of our design experiment,
              dashboard layout preferences, and PostHog&apos;s anonymous identifier.
            </p>
          </div>
        </section>

        {/* Your Rights */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Your Rights</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Under the GDPR you can ask us for a copy of your personal data, ask us to correct or
              delete it, ask us to restrict how we use it, receive it in a portable format, and
              object to processing based on legitimate interest, including analytics. Email{" "}
              <SupportEmail /> and we will reply within one month.
            </p>
            <p>
              You can also delete your endpoints and their captured requests at any time from the
              dashboard, and your whole account from your{" "}
              <Link href="/account" className={linkClass}>
                account page
              </Link>
              .
            </p>
            <p>
              If you think we handle your data unlawfully, you can complain to the Danish Data
              Protection Agency,{" "}
              <a
                href="https://www.datatilsynet.dk"
                className={linkClass}
                target="_blank"
                rel="noopener noreferrer"
              >
                Datatilsynet
              </a>
              , or to the data protection authority in the EU country where you live or work.
            </p>
          </div>
        </section>

        {/* Changes */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Changes</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>We update the date at the top of this page whenever this policy changes.</p>
          </div>
        </section>

        {/* Contact */}
        <section className="border-t-strong border-line pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Contact</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Questions about this policy or your data? Email <SupportEmail />.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
