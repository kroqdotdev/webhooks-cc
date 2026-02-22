export interface BlogPostMeta {
  slug: string;
  href: string;
  title: string;
  description: string;
  category: string;
  readMinutes: number;
  publishedAt: string;
  updatedAt: string;
  tags: readonly string[];
}

export const BLOG_POSTS: readonly BlogPostMeta[] = [
  {
    slug: "test-stripe-webhooks-locally-2026",
    href: "/blog/test-stripe-webhooks-locally-2026",
    title: "How to test Stripe webhooks locally in 2026",
    description:
      "Set up a local Stripe webhook workflow with a stable public endpoint, live request inspection, replay, and signature verification on localhost.",
    category: "Local Development",
    readMinutes: 6,
    publishedAt: "2026-02-19",
    updatedAt: "2026-02-19",
    tags: ["Stripe", "CLI tunnel", "Signature verification"],
  },
  {
    slug: "webhook-testing-cicd-typescript",
    href: "/blog/webhook-testing-cicd-typescript",
    title: "Webhook testing in CI/CD with TypeScript",
    description:
      "Create deterministic webhook integration tests in CI with endpoint setup, strict request matching, assertions, and teardown using the TypeScript SDK.",
    category: "Testing",
    readMinutes: 7,
    publishedAt: "2026-02-19",
    updatedAt: "2026-02-19",
    tags: ["TypeScript", "CI/CD", "Integration tests"],
  },
  {
    slug: "ai-agents-debug-webhooks-mcp",
    href: "/blog/ai-agents-debug-webhooks-mcp",
    title: "Using AI agents to debug webhooks with MCP",
    description:
      "Connect your coding agent to webhooks.cc for endpoint creation, signed test sends, request inspection, and replay workflows through MCP.",
    category: "AI Workflows",
    readMinutes: 5,
    publishedAt: "2026-02-19",
    updatedAt: "2026-02-19",
    tags: ["MCP", "Codex", "Automation"],
  },
] as const;

export function getBlogPostBySlug(slug: string): BlogPostMeta | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function formatBlogDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}
