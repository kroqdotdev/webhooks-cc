import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Privacy Policy",
  description:
    "Read the webhooks.cc privacy policy, including data collection, storage, retention, billing processors, and how webhook request data is handled.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b-2 border-foreground shrink-0 bg-background sticky top-0 z-50">
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
        <p className="text-sm text-muted-foreground mb-8">Last updated: March 19, 2026</p>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            webhooks.cc is a webhook inspection and testing tool. This policy describes what data we
            collect, why, and how we handle it.
          </p>
        </div>

        {/* What We Collect */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">What We Collect</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">Account info.</span> When you sign in with
              GitHub or Google, we receive your email address, display name, and profile picture
              from the OAuth provider.
            </p>
            <p>
              <span className="font-bold text-foreground">Webhook data.</span> We store the requests
              sent to your endpoints: HTTP method, path, headers, query parameters, request body,
              and sender IP address.
            </p>
            <p>
              <span className="font-bold text-foreground">Billing identifiers.</span> If you
              subscribe to a paid plan, we store your Polar customer ID and subscription ID. We do
              not store payment card details.
            </p>
          </div>
        </section>

        {/* How We Use It */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">How We Use It</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>We use your data for three purposes:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Authenticating your account</li>
              <li>Capturing and displaying webhook requests</li>
              <li>Managing subscription billing</li>
            </ul>
            <p>We do not sell your data or use it for advertising.</p>
          </div>
        </section>

        {/* Third-Party Services */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Third-Party Services</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">Supabase</span> hosts our database and
              handles authentication.
            </p>
            <p>
              <span className="font-bold text-foreground">Polar.sh</span> processes subscription
              payments.
            </p>
            <p>
              <span className="font-bold text-foreground">PostHog</span> provides privacy-friendly
              product analytics. See the Analytics section below for details.
            </p>
            <p>We do not use advertising networks.</p>
          </div>
        </section>

        {/* Analytics */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Analytics</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              We use{" "}
              <a
                href="https://posthog.com"
                className="text-primary hover:underline font-bold"
                target="_blank"
                rel="noopener noreferrer"
              >
                PostHog
              </a>{" "}
              to understand how people use webhooks.cc. PostHog is configured without cookies: no
              cookies are set and no cross-site tracking occurs. A random anonymous identifier is
              stored in your browser&apos;s localStorage to recognize returning visitors on
              webhooks.cc.
            </p>
            <p>
              <span className="font-bold text-foreground">What we collect.</span> Page views, button
              clicks, referrer URL, and UTM campaign parameters. For logged-in users we associate
              analytics events with your account to understand usage patterns.
            </p>
            <p>
              <span className="font-bold text-foreground">What we do not collect.</span> We do not
              fingerprint your browser, track you across sites, or build advertising profiles.
            </p>
            <p>
              <span className="font-bold text-foreground">Legal basis.</span> We process this data
              under legitimate interest (GDPR Art.&nbsp;6(1)(f)) to improve our service. You can opt
              out by using a standard content blocker that blocks PostHog.
            </p>
            <p>
              <span className="font-bold text-foreground">Data location.</span> By default,
              analytics data is processed and stored within the European Union by PostHog.
              Self-hosted deployments may override the analytics host via the{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">NEXT_PUBLIC_POSTHOG_HOST</code>{" "}
              environment variable. For the production deployment at webhooks.cc, data is sent to
              PostHog&apos;s EU endpoint. See PostHog&apos;s{" "}
              <a
                href="https://posthog.com/privacy"
                className="text-primary hover:underline font-bold"
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
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Data Retention</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-bold text-foreground">Free plan:</span> Captured requests are
              cleared on each billing period reset.
            </p>
            <p>
              <span className="font-bold text-foreground">Pro plan:</span> Requests are retained for
              30 days.
            </p>
            <p>
              Ephemeral (anonymous) endpoints and their requests are automatically deleted when they
              expire.
            </p>
          </div>
        </section>

        {/* Cookies & Storage */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Cookies & Storage</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Authentication is managed by Supabase and uses standard session mechanisms. We store
              your theme preference (light/dark) and a PostHog anonymous identifier in localStorage.
              We do not use tracking cookies.
            </p>
          </div>
        </section>

        {/* Your Data */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Your Data</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              You can delete your endpoints and their captured requests at any time from the
              dashboard. To delete your account entirely, visit your{" "}
              <Link href="/account" className="text-primary hover:underline font-bold">
                account page
              </Link>
              .
            </p>
          </div>
        </section>

        {/* Contact */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Contact</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Questions about this policy? Email{" "}
              <a
                href="mailto:support@webhooks.cc"
                className="text-primary hover:underline font-bold"
              >
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
