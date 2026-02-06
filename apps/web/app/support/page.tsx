import Link from "next/link";
import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { BackButton } from "@/components/nav/back-button";
import { Mail, Bug, CreditCard, MessageSquare } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Support",
  description: "Get help with webhooks.cc — bug reports, billing, and general questions.",
  path: "/support",
});

export default function SupportPage() {
  return (
    <div className="min-h-screen">
      <FloatingNavbar>
        <BackButton />
      </FloatingNavbar>

      <main className="max-w-3xl mx-auto px-6 pt-28 pb-10 md:px-10">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">Support</h1>
        <p className="text-sm text-muted-foreground mb-12">
          Got a question, found a bug, or need help with billing? We&rsquo;re here to help.
        </p>

        <h2 className="sr-only">Contact options</h2>
        <div className="grid sm:grid-cols-2 gap-6 mb-12">
          <a href="mailto:support@webhooks.cc" className="neo-card transition-neo group">
            <div className="w-12 h-12 border-2 border-foreground bg-primary flex items-center justify-center mb-4 shadow-neo-sm">
              <Bug className="h-6 w-6 text-primary-foreground" />
            </div>
            <h3 className="font-bold text-lg mb-1">Bug Reports</h3>
            <p className="text-sm text-muted-foreground">
              Something broken? Let us know and we&rsquo;ll fix it.
            </p>
          </a>

          <a
            href="mailto:support@webhooks.cc?subject=Billing"
            className="neo-card transition-neo group"
          >
            <div className="w-12 h-12 border-2 border-foreground bg-secondary flex items-center justify-center mb-4 shadow-neo-sm">
              <CreditCard className="h-6 w-6 text-secondary-foreground" />
            </div>
            <h3 className="font-bold text-lg mb-1">Billing</h3>
            <p className="text-sm text-muted-foreground">
              Questions about your plan, invoices, or payments.
            </p>
          </a>

          <a
            href="mailto:support@webhooks.cc?subject=Question"
            className="neo-card transition-neo group"
          >
            <div className="w-12 h-12 border-2 border-foreground bg-accent flex items-center justify-center mb-4 shadow-neo-sm">
              <MessageSquare className="h-6 w-6 text-accent-foreground" />
            </div>
            <h3 className="font-bold text-lg mb-1">General Questions</h3>
            <p className="text-sm text-muted-foreground">
              Anything else — setup help, feature requests, or just saying hi.
            </p>
          </a>

          <a
            href="mailto:support@webhooks.cc"
            className="neo-card transition-neo group bg-foreground text-background"
          >
            <div className="w-12 h-12 border-2 border-background bg-background flex items-center justify-center mb-4">
              <Mail className="h-6 w-6 text-foreground" />
            </div>
            <h3 className="font-bold text-lg mb-1">Email Us Directly</h3>
            <p className="text-sm opacity-70">
              For anything at all, reach us at support@webhooks.cc
            </p>
          </a>
        </div>

        <section className="border-t-2 border-foreground pt-8">
          <h2 className="text-xl font-bold mb-3">Before You Write</h2>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Check the{" "}
              <Link href="/docs" className="text-primary hover:underline font-bold">
                documentation
              </Link>{" "}
              first — it covers setup, endpoints, the CLI, and the SDK. Most questions are answered
              there.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
