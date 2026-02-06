import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Terms of Service",
  description:
    "Read the webhooks.cc terms of service for acceptable use, billing, and legal terms.",
  path: "/terms",
});

export default function TermsPage() {
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
        <h1 className="text-3xl md:text-4xl font-bold mb-4">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-8">Last updated: February 4, 2026</p>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            By using webhooks.cc, you agree to these terms. If you disagree with any part, do not
            use the service.
          </p>
        </div>

        {/* The Service */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">The Service</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              webhooks.cc lets you capture, inspect, and forward HTTP webhook requests for
              development and testing purposes.
            </p>
          </div>
        </section>

        {/* Your Account */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Your Account</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              You authenticate via GitHub or Google OAuth. You are responsible for all activity
              under your account and for keeping your credentials secure.
            </p>
          </div>
        </section>

        {/* Acceptable Use */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Acceptable Use</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>You agree not to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Use the service for illegal activity</li>
              <li>Abuse or disrupt the service infrastructure</li>
              <li>Exceed rate limits or circumvent usage restrictions</li>
              <li>Use the service to harm, harass, or impersonate others</li>
            </ul>
            <p>We may suspend or terminate accounts that violate these rules.</p>
          </div>
        </section>

        {/* Webhook Data */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Webhook Data</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              You are responsible for the data sent to your endpoints. Do not send sensitive
              information&mdash;passwords, payment card numbers, or personal health
              data&mdash;through the service. See our{" "}
              <Link href="/privacy" className="text-primary hover:underline font-bold">
                Privacy Policy
              </Link>{" "}
              for details on data handling.
            </p>
          </div>
        </section>

        {/* Service Availability */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Service Availability</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              The service is provided &ldquo;as is&rdquo; without warranties of any kind. We do not
              guarantee uptime, and we may modify or discontinue features at any time.
            </p>
          </div>
        </section>

        {/* Changes */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Changes</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              We may update these terms. We will update the date at the top of this page when we do.
              Continued use of the service after changes constitutes acceptance of the revised
              terms.
            </p>
          </div>
        </section>

        {/* Contact */}
        <section className="border-t-2 border-foreground pt-8 mt-8">
          <h2 className="text-xl font-bold mb-3">Contact</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Questions about these terms? Email{" "}
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
