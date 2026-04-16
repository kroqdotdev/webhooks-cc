import Link from "next/link";
import {
  Reply,
  ShieldCheck,
  Terminal,
  TestTube2,
  Bot,
  CheckSquare,
  type LucideIcon,
} from "lucide-react";

type Feature = {
  title: string;
  description: string;
  href: string;
  cta: string;
  Icon: LucideIcon;
  iconBg: string;
  iconFg: string;
};

const LEFT_FEATURES: Feature[] = [
  {
    title: "Mock webhook responses",
    description:
      "Custom status, headers, and JSON body per endpoint. Conditional rules match on method, path, or body — no deploy.",
    href: "/docs/mock-responses",
    cta: "Mock responses docs",
    Icon: Reply,
    iconBg: "bg-primary",
    iconFg: "text-primary-foreground",
  },
  {
    title: "Forward to localhost",
    description:
      "Run whk tunnel to pipe webhooks to any local port. No ngrok, no port forwarding, no public IP.",
    href: "/docs/cli/tunnel",
    cta: "CLI tunnel guide",
    Icon: Terminal,
    iconBg: "bg-accent",
    iconFg: "text-accent-foreground",
  },
  {
    title: "AI-native debugging",
    description:
      "MCP server lets Claude Code, Cursor, and Codex create endpoints, send tests, and inspect requests.",
    href: "/docs/mcp",
    cta: "MCP server docs",
    Icon: Bot,
    iconBg: "bg-foreground",
    iconFg: "text-background",
  },
];

const RIGHT_FEATURES: Feature[] = [
  {
    title: "Signed webhook testing",
    description:
      "Verify Stripe, GitHub, Shopify, Twilio, Slack, Paddle, and Linear signatures end-to-end with real templates.",
    href: "/docs/guides/verify-webhook-signatures",
    cta: "Signature verification guide",
    Icon: ShieldCheck,
    iconBg: "bg-secondary",
    iconFg: "text-secondary-foreground",
  },
  {
    title: "Assert webhooks in CI",
    description:
      "TypeScript SDK waits for matching requests with composable matchers. Works in Vitest, Jest, and Playwright.",
    href: "/docs/sdk/testing",
    cta: "SDK testing guide",
    Icon: TestTube2,
    iconBg: "bg-muted",
    iconFg: "text-foreground",
  },
  {
    title: "Search, replay, export",
    description:
      "Full-text search across requests. Replay to any URL. Export JSON or CSV. Real-time updates via SSE.",
    href: "/docs/requests",
    cta: "Requests docs",
    Icon: CheckSquare,
    iconBg: "bg-primary",
    iconFg: "text-primary-foreground",
  },
];

const ALL_FEATURES: Feature[] = [...LEFT_FEATURES, ...RIGHT_FEATURES];

function SideCard({ feature }: { feature: Feature }) {
  return (
    <Link href={feature.href} className="neo-card block p-4 no-underline group">
      <div className="flex items-start gap-3">
        <div
          className={`shrink-0 w-9 h-9 border-2 border-foreground ${feature.iconBg} flex items-center justify-center shadow-neo-sm`}
        >
          <feature.Icon className={`h-4 w-4 ${feature.iconFg}`} />
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-sm mb-1 leading-tight group-hover:underline">
            {feature.title}
          </h3>
          <p className="text-xs text-muted-foreground leading-snug mb-2">{feature.description}</p>
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground group-hover:text-foreground">
            {feature.cta} →
          </p>
        </div>
      </div>
    </Link>
  );
}

export function GoSideFeatures({ side }: { side: "left" | "right" }) {
  const items = side === "left" ? LEFT_FEATURES : RIGHT_FEATURES;
  return (
    <aside
      aria-label={side === "left" ? "Developer tools" : "Testing features"}
      className="flex flex-col gap-3 w-full max-w-xs"
    >
      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1">
        {side === "left" ? "Build with webhooks.cc" : "Test with webhooks.cc"}
      </p>
      {items.map((feature) => (
        <SideCard key={feature.href} feature={feature} />
      ))}
    </aside>
  );
}

export function GoMobileFeatures() {
  return (
    <section
      aria-label="Explore more webhooks.cc features"
      className="xl:hidden mt-8 pt-6 border-t-2 border-foreground"
    >
      <h2 className="text-lg font-bold mb-4">Beyond the free endpoint</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ALL_FEATURES.map((feature) => (
          <SideCard key={feature.href} feature={feature} />
        ))}
      </div>
    </section>
  );
}
