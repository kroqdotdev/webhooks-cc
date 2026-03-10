// -------------------------------------------------------------------
// Shared navigation config for docs sidebar, breadcrumbs, prev/next.
// Single source of truth for page ordering.
// -------------------------------------------------------------------

export interface NavItem {
  title: string;
  href: string;
  depth?: number; // 1 = indented sub-item in sidebar
  isNew?: boolean; // shows "NEW" badge in sidebar
}

export interface NavSection {
  title: string;
  id: string; // localStorage key for collapse state
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Getting Started",
    id: "getting-started",
    items: [
      { title: "Quick Start", href: "/docs" },
      { title: "Installation", href: "/installation" },
      { title: "Core Concepts", href: "/docs/core-concepts", isNew: true },
    ],
  },
  {
    title: "Dashboard",
    id: "dashboard",
    items: [
      { title: "Endpoints", href: "/docs/endpoints" },
      { title: "Test Webhooks", href: "/docs/endpoints/test-webhooks", depth: 1 },
      { title: "Requests", href: "/docs/requests" },
      { title: "Mock Responses", href: "/docs/mock-responses" },
    ],
  },
  {
    title: "CLI",
    id: "cli",
    items: [
      { title: "Overview", href: "/docs/cli" },
      { title: "Commands", href: "/docs/cli/commands" },
      { title: "Tunneling", href: "/docs/cli/tunnel" },
    ],
  },
  {
    title: "SDK",
    id: "sdk",
    items: [
      { title: "Overview", href: "/docs/sdk" },
      { title: "API Reference", href: "/docs/sdk/api" },
      { title: "Matchers & Helpers", href: "/docs/sdk/matchers", isNew: true },
      { title: "Signature Verification", href: "/docs/sdk/signatures", isNew: true },
      { title: "Testing", href: "/docs/sdk/testing" },
      { title: "Standard Webhooks", href: "/docs/sdk/testing/standard-webhooks", depth: 1 },
      { title: "Stripe + Vitest", href: "/docs/sdk/testing/stripe-vitest", depth: 1 },
      { title: "GitHub + Jest", href: "/docs/sdk/testing/github-jest", depth: 1 },
      {
        title: "Shopify + Vitest",
        href: "/docs/sdk/testing/shopify-vitest",
        depth: 1,
        isNew: true,
      },
      { title: "Playwright E2E", href: "/docs/sdk/testing/playwright-e2e", depth: 1 },
      { title: "Polar + Playwright", href: "/docs/sdk/testing/polar-playwright", depth: 1 },
    ],
  },
  {
    title: "MCP",
    id: "mcp",
    items: [
      { title: "MCP Server", href: "/docs/mcp" },
      { title: "Tool Reference", href: "/docs/mcp/tools", isNew: true },
      { title: "Agent Workflows", href: "/docs/mcp/workflows", isNew: true },
    ],
  },
  {
    title: "Guides",
    id: "guides",
    items: [
      { title: "Test Webhooks Locally", href: "/docs/guides/test-webhooks-locally", isNew: true },
      { title: "Test Stripe Webhooks", href: "/docs/guides/test-stripe-webhooks", isNew: true },
      { title: "Test GitHub Webhooks", href: "/docs/guides/test-github-webhooks", isNew: true },
      { title: "Test Shopify Webhooks", href: "/docs/guides/test-shopify-webhooks", isNew: true },
      { title: "Verify Signatures", href: "/docs/guides/verify-webhook-signatures", isNew: true },
      {
        title: "Webhook Testing in CI/CD",
        href: "/docs/guides/webhook-testing-ci-cd",
        isNew: true,
      },
      { title: "ngrok vs webhooks.cc", href: "/docs/guides/ngrok-vs-webhooks-cc", isNew: true },
      { title: "Webhook Testing Tools", href: "/docs/guides/webhook-testing-tools", isNew: true },
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
  return labels;
}
