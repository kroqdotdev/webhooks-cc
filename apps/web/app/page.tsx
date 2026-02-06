import Link from "next/link";
import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { AuthAwareDemo } from "@/components/landing/auth-aware-demo";
import { HeroCTA } from "@/components/landing/hero-cta";
import { Zap, Eye, Terminal, ArrowRight, Check } from "lucide-react";
import { GitHubCard } from "@/components/landing/github-card";
import { InstallCards } from "@/components/landing/install-cards";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Inspect Webhooks Instantly",
  description:
    "Capture webhooks in real time, inspect headers and payloads, and forward requests to localhost with webhooks.cc.",
  path: "/",
});

interface GitHubRepoResponse {
  stargazers_count: number;
}

async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/lohsefar/webhooks-cc", {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GitHubRepoResponse;
    return typeof data?.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const stars = await getStarCount();
  const softwareApplicationJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "webhooks.cc",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    url: "https://webhooks.cc",
    description:
      "Capture webhooks in real time, inspect requests, and forward to localhost for development.",
  };

  return (
    <main className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
      />

      {/* Navigation */}
      <FloatingNavbar />

      {/* Hero */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-8">
            <div className="max-w-3xl">
              <div className="inline-block neo-btn-secondary text-sm py-1 px-3 mb-6">
                Developer Tools
              </div>
              <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-[1.1]">
                Inspect webhooks{" "}
                <span className="bg-primary text-primary-foreground px-2">instantly</span>
              </h1>
              <p className="text-xl md:text-2xl text-muted-foreground mb-8 max-w-2xl leading-relaxed">
                Get a unique URL in one click. See incoming requests in real-time. Forward to
                localhost for development.{" "}
                <span className="text-foreground font-semibold">No signup required.</span>
              </p>
              <HeroCTA />
            </div>

            {/* GitHub */}
            <GitHubCard stars={stars} />
          </div>

          {/* Install */}
          <InstallCards />

          {/* Code preview */}
          <div className="mt-6 neo-code overflow-x-auto">
            <pre className="text-sm md:text-base">
              <code>
                <span className="text-muted-foreground">
                  # Create an endpoint and start capturing webhooks
                </span>
                {"\n"}
                <span className="text-primary">$</span> curl -X POST https://go.webhooks.cc/w/abc123
                \{"\n"}
                {"  "}-H{" "}
                <span className="text-code-string">&quot;Content-Type: application/json&quot;</span>{" "}
                \{"\n"}
                {"  "}-d{" "}
                <span className="text-code-string">
                  &apos;{`{"event": "payment.success", "amount": 4999}`}&apos;
                </span>
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4 bg-muted">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Everything you need to debug webhooks
          </h2>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Stop guessing what your webhooks look like. Inspect every detail in real-time.
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            <div className="neo-card transition-neo cursor-pointer">
              <div className="w-12 h-12 border-2 border-foreground bg-primary flex items-center justify-center mb-4 shadow-neo-sm">
                <Eye className="h-6 w-6 text-primary-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Real-time inspection</h3>
              <p className="text-muted-foreground">
                See requests as they arrive. Headers, body, query params - all formatted and
                searchable.
              </p>
            </div>

            <div className="neo-card transition-neo cursor-pointer">
              <div className="w-12 h-12 border-2 border-foreground bg-secondary flex items-center justify-center mb-4 shadow-neo-sm">
                <Zap className="h-6 w-6 text-secondary-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Mock responses</h3>
              <p className="text-muted-foreground">
                Configure what your endpoint returns. Set status codes, headers, and body content.
              </p>
            </div>

            <div className="neo-card transition-neo cursor-pointer">
              <div className="w-12 h-12 border-2 border-foreground bg-accent flex items-center justify-center mb-4 shadow-neo-sm">
                <Terminal className="h-6 w-6 text-accent-foreground" />
              </div>
              <h3 className="font-bold text-xl mb-2">Local forwarding</h3>
              <p className="text-muted-foreground">
                Forward webhooks to localhost with our CLI. Test integrations without deploying.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Live Demo - hidden for authenticated users */}
      <AuthAwareDemo />

      {/* Pricing */}
      <section className="py-20 px-4 bg-muted">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Simple pricing</h2>
            <p className="text-xl text-muted-foreground">Start free, upgrade when you need more</p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* Free Plan */}
            <div className="neo-card">
              <div className="mb-6">
                <h3 className="font-bold text-2xl mb-2">Free</h3>
                <p className="text-5xl font-bold">
                  $0
                  <span className="text-lg font-normal text-muted-foreground">/forever</span>
                </p>
              </div>
              <ul className="space-y-3 mb-8">
                {[
                  "200 requests/day",
                  "24-hour data retention",
                  "Unlimited endpoints",
                  "CLI & SDK access",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <Check className="h-5 w-5 text-primary flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link href="/login" className="neo-btn-outline w-full text-center block">
                Get started
              </Link>
            </div>

            {/* Pro Plan */}
            <div className="neo-card border-primary relative">
              <div className="absolute -top-3 -right-3 bg-secondary text-secondary-foreground px-3 py-1 text-sm font-bold border-2 border-foreground shadow-neo-sm">
                Popular
              </div>
              <div className="mb-6">
                <h3 className="font-bold text-2xl mb-2">Pro</h3>
                <p className="text-5xl font-bold">
                  $8
                  <span className="text-lg font-normal text-muted-foreground">/month</span>
                </p>
              </div>
              <ul className="space-y-3 mb-8">
                {[
                  "500,000 requests/month",
                  "30-day data retention",
                  "Unlimited endpoints",
                  "CLI & SDK access",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <Check className="h-5 w-5 text-primary flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link href="/login" className="neo-btn-primary w-full text-center block">
                Upgrade to Pro
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="neo-card bg-foreground text-background text-center py-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Start debugging webhooks today</h2>
            <p className="text-xl opacity-80 mb-8 max-w-xl mx-auto">
              Join thousands of developers who trust webhooks.cc for their webhook testing needs.
            </p>
            <a href="#demo" className="neo-btn bg-background text-foreground">
              Try it free
              <ArrowRight className="inline-block ml-2 h-5 w-5" />
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-2 border-foreground py-12 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <h4 className="font-bold text-lg mb-4">webhooks.cc</h4>
              <p className="text-muted-foreground text-sm">
                The fastest way to debug webhooks. Built for developers.
              </p>
            </div>
            <div>
              <h4 className="font-bold mb-4">Product</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/docs" className="text-muted-foreground hover:text-foreground">
                    Documentation
                  </Link>
                </li>
                <li>
                  <Link
                    href="/installation"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Installation
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="text-muted-foreground hover:text-foreground">
                    Dashboard
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4">Resources</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/docs/cli" className="text-muted-foreground hover:text-foreground">
                    CLI Reference
                  </Link>
                </li>
                <li>
                  <Link href="/docs/sdk" className="text-muted-foreground hover:text-foreground">
                    SDK Reference
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link href="/privacy" className="text-muted-foreground hover:text-foreground">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-muted-foreground hover:text-foreground">
                    Terms of Service
                  </Link>
                </li>
                <li>
                  <Link href="/support" className="text-muted-foreground hover:text-foreground">
                    Support
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t-2 border-foreground mt-12 pt-8 text-center text-muted-foreground text-sm">
            <p>&copy; {new Date().getFullYear()} webhooks.cc. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
