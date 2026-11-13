// -------------------------------------------------------------------
// Shared navigation config for docs sidebar, breadcrumbs, prev/next.
// Single source of truth for page ordering.
// -------------------------------------------------------------------

export interface NavItem {
  title: string;
  href: string;
  depth?: number; // 1 = indented sub-item in sidebar
  isNew?: boolean; // shows "NEW" badge in sidebar: pages added in about the last three weeks; drop it as they age
}

export interface NavSection {
  title: string;
  id: string; // localStorage key for collapse state
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Getting started",
    id: "getting-started",
    items: [
      { title: "Quick start", href: "/docs" },
      { title: "Installation", href: "/installation" },
      { title: "Core concepts", href: "/docs/core-concepts" },
      { title: "Plans & limits", href: "/docs/plans-limits" },
      { title: "REST API", href: "/docs/api" },
      { title: "AI agents", href: "/docs/agents" },
    ],
  },
  {
    title: "Dashboard",
    id: "dashboard",
    items: [
      { title: "Endpoints", href: "/docs/endpoints" },
      { title: "Test webhooks", href: "/docs/endpoints/test-webhooks", depth: 1 },
      {
        title: "Provider templates",
        href: "/docs/endpoints/provider-templates",
        depth: 1,
      },
      { title: "Requests", href: "/docs/requests" },
      { title: "Email capture", href: "/docs/email-capture" },
      { title: "Layouts", href: "/docs/layouts", depth: 1, isNew: true },
      { title: "Forwarding", href: "/docs/forwarding", depth: 1 },
      { title: "Zapier and Make", href: "/docs/zapier-make", depth: 1, isNew: true },
      { title: "Mock responses", href: "/docs/mock-responses" },
      { title: "Dashboard features", href: "/docs/dashboard-features" },
      { title: "Notification webhooks", href: "/docs/notification-webhooks" },
      { title: "Teams", href: "/docs/teams" },
      { title: "Support and security", href: "/docs/support", isNew: true },
    ],
  },
  {
    title: "CLI",
    id: "cli",
    items: [
      { title: "Overview", href: "/docs/cli" },
      { title: "Commands", href: "/docs/cli/commands" },
      { title: "Tunneling", href: "/docs/cli/tunnel" },
      { title: "Live tunnels", href: "/docs/live-tunnel", depth: 1, isNew: true },
      { title: "Share localhost", href: "/docs/share", isNew: true },
    ],
  },
  {
    title: "SDK",
    id: "sdk",
    items: [
      { title: "Overview", href: "/docs/sdk" },
      { title: "API reference", href: "/docs/sdk/api" },
      { title: "Matchers & helpers", href: "/docs/sdk/matchers" },
      { title: "Signature verification", href: "/docs/sdk/signatures" },
      { title: "Python", href: "/docs/sdk/python", isNew: true },
      { title: "Go", href: "/docs/sdk/go", isNew: true },
      { title: "Testing", href: "/docs/sdk/testing" },
      { title: "Standard Webhooks", href: "/docs/sdk/testing/standard-webhooks", depth: 1 },
      { title: "Stripe + Vitest", href: "/docs/sdk/testing/stripe-vitest", depth: 1 },
      { title: "GitHub + Jest", href: "/docs/sdk/testing/github-jest", depth: 1 },
      { title: "Shopify + Vitest", href: "/docs/sdk/testing/shopify-vitest", depth: 1 },
      { title: "Playwright E2E", href: "/docs/sdk/testing/playwright-e2e", depth: 1 },
      { title: "Polar + Playwright", href: "/docs/sdk/testing/polar-playwright", depth: 1 },
      { title: "Python + pytest", href: "/docs/sdk/testing/pytest", depth: 1, isNew: true },
      { title: "Go + go test", href: "/docs/sdk/testing/go", depth: 1, isNew: true },
    ],
  },
  {
    title: "MCP",
    id: "mcp",
    items: [
      { title: "MCP server", href: "/docs/mcp" },
      { title: "Tool reference", href: "/docs/mcp/tools" },
      { title: "Agent workflows", href: "/docs/mcp/workflows" },
      { title: "Agent skill", href: "/docs/mcp/skills", isNew: true },
    ],
  },
  {
    title: "Guides",
    id: "guides",
    items: [
      { title: "Test webhooks locally", href: "/docs/guides/test-webhooks-locally" },
      { title: "Test Stripe webhooks", href: "/docs/guides/test-stripe-webhooks" },
      { title: "Test GitHub webhooks", href: "/docs/guides/test-github-webhooks" },
      { title: "Test Shopify webhooks", href: "/docs/guides/test-shopify-webhooks" },
      { title: "Verify signatures", href: "/docs/guides/verify-webhook-signatures" },
      { title: "Webhook testing in CI/CD", href: "/docs/guides/webhook-testing-ci-cd" },
      {
        title: "Email testing in Playwright",
        href: "/docs/guides/test-signup-emails-playwright",
      },
    ],
  },
  {
    title: "Comparisons",
    id: "comparisons",
    items: [
      // The /compare pages, not the docs guides they replaced: those redirect
      // there now, and linking them from every docs page kept them indexed.
      { title: "Webhook testing tools", href: "/compare" },
      { title: "ngrok vs webhooks.cc", href: "/compare/ngrok" },
      { title: "Webhook.site vs webhooks.cc", href: "/compare/webhook-site" },
      {
        title: "Cloudflare Tunnel vs webhooks.cc",
        href: "/compare/cloudflare-tunnel",
        isNew: true,
      },
      { title: "Pinggy vs webhooks.cc", href: "/compare/pinggy", isNew: true },
      { title: "Stripe CLI vs webhooks.cc", href: "/compare/stripe-cli", isNew: true },
      { title: "Svix vs webhooks.cc", href: "/compare/svix", isNew: true },
      { title: "Mailtrap vs webhooks.cc", href: "/compare/mailtrap", isNew: true },
      { title: "Mailosaur vs webhooks.cc", href: "/compare/mailosaur", isNew: true },
      { title: "MailSlurp vs webhooks.cc", href: "/compare/mailslurp", isNew: true },
    ],
  },
];

// -------------------------------------------------------------------
// Derived data
// -------------------------------------------------------------------

/** Flat ordered list of all nav items (for prev/next computation) */
export function getFlatNavItems(): NavItem[] {
  return NAV_SECTIONS.flatMap((section) => section.items);
}

/** Get prev and next pages relative to the given href */
export function getPrevNext(href: string): {
  prev: (NavItem & { section: string }) | null;
  next: (NavItem & { section: string }) | null;
} {
  const flatWithSection = NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => ({ ...item, section: section.title }))
  );
  const index = flatWithSection.findIndex((item) => item.href === href);

  return {
    prev: index > 0 ? flatWithSection[index - 1] : null,
    next: index < flatWithSection.length - 1 ? flatWithSection[index + 1] : null,
  };
}

/** Map of href -> display label (for breadcrumbs) */
export function getBreadcrumbLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      labels[item.href] = item.title;
    }
  }
  // The docs root is the quick start, but as a parent in a trail it is just "Docs".
  labels["/docs"] = "Docs";
  return labels;
}
