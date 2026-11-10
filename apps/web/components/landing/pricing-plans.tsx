import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { PaidPlanCTA, PricingCTA } from "@/components/landing/pricing-cta";

/**
 * webhooks.cc's plan cards and the Teams strip, shown on the landing page's
 * pricing section and on /pricing. mailhooks.cc has its own wording of the
 * same plans (app/mailhooks/pricing).
 */

const FREE_FEATURES = [
  "50 requests/day",
  "7-day data retention",
  "Unlimited endpoints",
  "20 parsed attachment pages/month",
  "Email capture & destinations",
  "CLI, SDK & MCP access",
  "Mock responses & replay",
];

const PRO_FEATURES = [
  "100,000 requests/month",
  "31-day data retention",
  "100 parsed attachment pages/month",
  "Extra requests in 25,000 blocks",
];

const BUSINESS_FEATURES = [
  "250,000 requests/month",
  "90-day data retention",
  "2,000 parsed attachment pages/month",
  "Up to 50 layouts, 250 AI assists/30 days",
  "1 custom inbound domain, extra ones $3/mo",
  "File drops to SFTP, FTP/FTPS & S3",
];

function FeatureList({ features }: { features: readonly string[] }) {
  return (
    <ul className="space-y-3 mb-8 flex-1">
      {features.map((feature) => (
        <li key={feature} className="flex items-start gap-3">
          <Check className="h-5 w-5 text-primary-ink flex-shrink-0 mt-0.5" aria-hidden />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

interface PricingPlansProps {
  /** The plan names' heading level: h3 under the landing page's section h2, h2 under /pricing's h1. */
  headingLevel?: "h2" | "h3";
}

export function PricingPlans({ headingLevel = "h3" }: PricingPlansProps) {
  const Heading = headingLevel;
  return (
    <>
      {/* Personal plans */}
      {/* Equal-height cards: the buttons line up along the bottom. */}
      <div className="grid md:grid-cols-3 gap-6">
        {/* Free Plan */}
        <div className="ui-card flex flex-col">
          <div className="mb-6">
            <Heading className="font-bold text-2xl mb-2">Free</Heading>
            <p className="text-5xl font-bold">
              $0
              <span className="text-lg font-normal text-muted-foreground"> forever</span>
            </p>
          </div>
          <FeatureList features={FREE_FEATURES} />
          <div className="mt-auto">
            <PricingCTA quietWhenSignedIn />
          </div>
        </div>

        {/* Pro Plan */}
        <div className="ui-card border-primary relative flex flex-col">
          <div className="absolute -top-3 right-4 bg-secondary text-secondary-foreground px-2 py-0.5 text-xs font-bold caps border-strong border-line rounded-sm shadow-raised-sm">
            Popular
          </div>
          <div className="mb-6">
            <Heading className="font-bold text-2xl mb-2">Pro</Heading>
            <p className="text-5xl font-bold">
              $8
              <span className="text-lg font-normal text-muted-foreground"> a month</span>
            </p>
          </div>
          <p className="text-sm font-semibold mb-3">Everything in Free, plus:</p>
          <FeatureList features={PRO_FEATURES} />
          {/* One action per paid plan: everyone starts free and upgrades under Account. */}
          <PaidPlanCTA plan="Pro" primary />
        </div>

        {/* Business Plan */}
        <div className="ui-card flex flex-col">
          <div className="mb-6">
            <Heading className="font-bold text-2xl mb-2">Business</Heading>
            <p className="text-5xl font-bold">
              $29
              <span className="text-lg font-normal text-muted-foreground"> a month</span>
            </p>
            <p className="text-sm text-muted-foreground mt-2">or $290 a year</p>
          </div>
          <p className="text-sm font-semibold mb-3">Everything in Pro, plus:</p>
          <FeatureList features={BUSINESS_FEATURES} />
          {/* One action per paid plan: everyone starts free and upgrades under Account. */}
          <PaidPlanCTA plan="Business" />
        </div>
      </div>

      {/* Teams: one strip with both team plans; the details live on /for-teams. */}
      <div className="ui-card ui-card-static mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <Heading className="font-bold text-2xl mb-2">Teams</Heading>
          <p className="text-muted-foreground mb-4">
            Share endpoints with the people you work with: everyone sees the same webhooks the
            moment they arrive. A team has its own subscription, billed per seat from 2 seats.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            <li className="flex items-start gap-3">
              <Check className="h-5 w-5 text-primary-ink flex-shrink-0 mt-0.5" aria-hidden />
              <span>
                <span className="font-bold">Teams, $12 a seat a month:</span> 100,000 pooled
                requests per seat, 31-day retention
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Check className="h-5 w-5 text-primary-ink flex-shrink-0 mt-0.5" aria-hidden />
              <span>
                <span className="font-bold">Team Business, $35 a seat a month:</span>{" "}
                Business&apos;s limits per seat, 90-day retention
              </span>
            </li>
          </ul>
        </div>
        <Link href="/for-teams" className="ui-btn-outline text-center block">
          How Teams works
          <ArrowRight className="inline-block ml-2 h-5 w-5" aria-hidden />
        </Link>
      </div>
    </>
  );
}
