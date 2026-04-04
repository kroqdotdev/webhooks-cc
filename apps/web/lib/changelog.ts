export type ChangelogTrack = "web" | "cli" | "sdk" | "mcp";

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  track: ChangelogTrack;
  items: string[];
}

export const TRACK_LABELS: Record<ChangelogTrack, string> = {
  web: "Web App",
  cli: "CLI",
  sdk: "SDK",
  mcp: "MCP",
};

export const APP_VERSION = "0.17.1";
export const CLI_VERSION = "1.0.0";
export const SDK_VERSION = "1.2.1";
export const MCP_VERSION = "1.1.0";

export const CHANGELOG: ChangelogEntry[] = [
  // ─── Web App ────────────────────────────────────────────────────────
  {
    version: "0.17.1",
    date: "2026-04-05",
    title: "Consolidated Provider Logic",
    track: "web",
    items: [
      "Unified webhook provider lists, signing, and payload generation via SDK — single source of truth",
      "Added standard-webhooks provider to Send Webhook dialog (fixes drift from SDK/MCP)",
      "Shared mock response validation across endpoint routes using SDK constants",
    ],
  },
  {
    version: "0.17.0",
    date: "2026-04-04",
    title: "Redis-Backed Rate Limiting",
    track: "web",
    items: [
      "Distributed rate limiting via Redis sliding window for all API routes",
      "Receiver notification deduplication backed by Redis",
      "Graceful fallback to in-memory rate limiting when Redis is unavailable",
    ],
  },
  {
    version: "0.16.0",
    date: "2026-04-04",
    title: "Raw Body Fidelity & Search Performance",
    track: "web",
    items: [
      "Raw body storage for non-UTF-8 payloads preserves byte-exact fidelity",
      "Trigram-indexed full-text search across request path, body, and headers",
      "Improved SSE streaming with raw body support",
      "SDK version drift fix and accurate Retry-After headers",
    ],
  },
  {
    version: "0.15.0",
    date: "2026-04-03",
    title: "Notification Webhooks",
    track: "web",
    items: [
      "Configure a notification URL on any endpoint to receive POST alerts when webhooks are captured",
      "Supports Slack, Discord, Microsoft Teams, and any webhook-compatible service",
      "Notification URL management in endpoint settings and via API/SDK/MCP",
      "New docs page for notification webhooks",
    ],
  },
  {
    version: "0.14.1",
    date: "2026-04-02",
    title: "API Key Deletion Confirmation",
    track: "web",
    items: ["Added confirmation dialog before deleting API keys to prevent accidental revocation"],
  },
  {
    version: "0.14.0",
    date: "2026-03-29",
    title: "API Explorer & Rate Limiting",
    track: "web",
    items: [
      "Interactive API explorer at /api-explorer powered by Scalar",
      "OpenAPI 3.1.0 specification at /openapi.yaml",
      "Improved rate limiting with sliding window and informational headers",
      "SDK error messages now include rate limit details and Retry-After hints",
    ],
  },
  {
    version: "0.13.1",
    date: "2026-03-28",
    title: "Pricing Copy Updates",
    track: "web",
    items: [
      "Updated pricing copy across comparison pages and docs",
      "Teams highlighted as Pro-exclusive feature",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-03-28",
    title: "Teams",
    track: "web",
    items: [
      "Create and manage teams with invite-based membership",
      "Share endpoints with team members",
      "Team roles: owner and member with scoped permissions",
      "Endpoint switcher shows personal and team endpoints",
      "Teams documentation page",
    ],
  },
  {
    version: "0.12.1",
    date: "2026-03-27",
    title: "Comparison Pages Expansion",
    track: "web",
    items: [
      "New comparison pages: Hookdeck, localtunnel, RequestBin, Smee",
      "Redesigned Beeceptor, ngrok, and Webhook.site comparison pages",
      "Shared comparison CTA component",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-03-26",
    title: "Request Debugging Tools",
    track: "web",
    items: [
      "Pin requests to keep them visible across endpoint switches",
      "Add notes to captured requests (stored locally)",
      "Side-by-side request diff comparison",
      "Visual request timeline view",
      "Interactive dashboard guide",
      "Dashboard features documentation page",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-03-26",
    title: "Dashboard Improvements",
    track: "web",
    items: [
      "Keyboard shortcuts for dashboard navigation",
      "Collapsible JSON tree viewer for request bodies",
      "JSON to TypeScript type generation",
      "Resizable split pane in request viewer",
      "Richer request list rows with method badges and size",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-03-26",
    title: "Case-Insensitive Slugs",
    track: "web",
    items: [
      "Endpoint slugs are now case-insensitive (e.g. /w/AbC and /w/abc resolve to the same endpoint)",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-03-25",
    title: "Conversion Funnel & Live Preview",
    track: "web",
    items: [
      "Live webhook preview on landing page",
      "Getting started guide for new users",
      "Claim ephemeral endpoints after signing in",
      "Site stats social proof on landing page",
      "Pricing CTA and docs CTA components",
      "Redesigned hero and navigation",
    ],
  },
  {
    version: "0.9.3",
    date: "2026-03-21",
    title: "Docs Expansion",
    track: "web",
    items: [
      "REST API reference documentation page",
      "Plans & limits documentation page",
      "Webhook.site vs webhooks.cc comparison page",
      "Docs navigation restructure and consistency improvements",
    ],
  },
  {
    version: "0.9.2",
    date: "2026-03-20",
    title: "Changelog & Version Display",
    track: "web",
    items: [
      "Public changelog page at /changelog with track filtering",
      "Version display on account page",
      "Deep health check endpoint for AppSignal uptime monitoring",
      "Forward user IP on test webhook sends",
      "Status page link in footer",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-03-20",
    title: "Provider Templates & Mock Response Delay",
    track: "web",
    items: [
      "Add SendGrid, Clerk, Discord, Vercel, GitLab provider templates (12 total)",
      "Configurable response delay for mock responses (0-30s)",
      "Comprehensive analytics tracking for request and endpoint operations",
      "New provider template reference documentation page",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-03-16",
    title: "AppSignal & Next.js 16 Proxy",
    track: "web",
    items: [
      "Replace Sentry with AppSignal for EU data residency compliance",
      "OpenTelemetry tracing pipeline for Rust receiver",
      "Migrate Next.js middleware.ts to proxy.ts (Next.js 16)",
      "Proxy test webhook sends through server-side API route",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-03-10",
    title: "Docs Overhaul",
    track: "web",
    items: [
      "14 new documentation pages with MDX pipeline",
      "Standard Webhooks provider and sendTo method",
      "Dynamic blog system with API publishing",
      "PostHog analytics integration",
      "Receiver file logging with daily rotation",
      "Adjusted tier quotas (guest 25/12hrs, free 50/day, pro 100K/month)",
    ],
  },
  {
    version: "0.7.4",
    date: "2026-02-27",
    title: "SEO & Navigation Refresh",
    track: "web",
    items: ["Refresh site metadata and navigation layout", "Fix sitemap response content"],
  },
  {
    version: "0.7.3",
    date: "2026-02-22",
    title: "Webhook Templates & Retention",
    track: "web",
    items: [
      "Signed webhook templates (Stripe, GitHub, Shopify, Twilio, Slack, Paddle, Linear)",
      "Request retention policy improvements",
      "Homepage comparison section",
    ],
  },
  {
    version: "0.7.2",
    date: "2026-02-17",
    title: "SEO & Search",
    track: "web",
    items: [
      "Structured data (JSON-LD), FAQ section, breadcrumbs",
      "Add llms.txt for AI discovery",
      "Full-text search across request body, headers, and path",
      "Paginated request history with retention policies",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-02-10",
    title: "Rust Receiver & CLI TUI",
    track: "web",
    items: [
      "Rewrite webhook receiver from Go to Rust (Axum + sqlx + Tokio)",
      "Optimize database with stored procedures (capture_webhook())",
      "Guest live dashboard for unauthenticated users",
      "Strict quota enforcement for all endpoint types",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-02-06",
    title: "Production Hardening",
    track: "web",
    items: [
      "Six phases of production hardening (abuse protection, CSP, rate limiting)",
      "Integration test suite (42 test cases)",
      "SEO metadata, sitemap improvements, crawler exclusions",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-02-05",
    title: "Security & Docs",
    track: "web",
    items: [
      "Security hardening across backend, API routes, and CLI",
      "Floating navbar, sidebar, and docs improvements",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-02-04",
    title: "Public Pages",
    track: "web",
    items: [
      "Installation page with copy-paste commands",
      "Privacy policy and terms of service pages",
      "XML sitemap generation",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-02-02",
    title: "Billing & Polish",
    track: "web",
    items: [
      "Polar.sh subscription management (free/pro tiers)",
      "Request batching and endpoint caching for high-throughput",
      "Dashboard UI improvements (empty states, layout fixes)",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-01-30",
    title: "CI/CD & Code Quality",
    track: "web",
    items: [
      "CI pipeline with lint, typecheck, build, and test stages",
      "Dependabot and CodeQL security scanning",
      "Input validation, CSP, and rate limiting",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-01-28",
    title: "Initial Release",
    track: "web",
    items: [
      "Dashboard with webhook capture and real-time inspection",
      "GitHub and Google OAuth authentication",
      "Basic endpoint CRUD and request viewer",
    ],
  },

  // ─── CLI ────────────────────────────────────────────────────────────
  {
    version: "1.0.0",
    date: "2026-04-01",
    title: "Rust Rewrite",
    track: "cli",
    items: [
      "Complete rewrite from Go to Rust for faster startup and smaller binaries",
      "Full feature parity: tunnel, listen, auth, endpoints, requests, replay, send, update",
      "Interactive TUI with ratatui (search, endpoint detail, request viewer)",
      "Request search and filtering in TUI",
      "Send webhooks with provider template signing from TUI",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-03-28",
    title: "Teams Support",
    track: "cli",
    items: [
      "Endpoint list shows owned and team-shared endpoints",
      "TeamShare metadata in endpoint responses",
    ],
  },
  {
    version: "0.5.3",
    date: "2026-03-14",
    title: "Tunnel Base Path & TUI Fixes",
    track: "cli",
    items: [
      "Support base path in tunnel target (e.g. whk tunnel 8080/api/webhooks)",
      "Fix TUI tunnel input swallowing shortcut-bound keys",
    ],
  },
  {
    version: "0.5.2",
    date: "2026-03-14",
    title: "Custom Headers",
    track: "cli",
    items: ["Add -H/--header flag for injecting custom headers in tunnel forwarding"],
  },
  {
    version: "0.5.1",
    date: "2026-02-19",
    title: "Replay & Ephemeral",
    track: "cli",
    items: [
      "Add whk replay command to resend captured requests",
      "Add --ephemeral flag for auto-deleting tunnel endpoints",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-02-10",
    title: "TUI Mode",
    track: "cli",
    items: [
      "Interactive TUI with menu, auth, endpoint listing, and request detail views",
      "Real-time SSE subscriptions in TUI",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-02-06",
    title: "Device Auth",
    track: "cli",
    items: [
      "Browser-based device authentication flow",
      "whk update self-update with SHA256 verification",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-02-05",
    title: "Cosign Signing",
    track: "cli",
    items: ["Cosign keyless signing for release binaries"],
  },
  {
    version: "0.2.0",
    date: "2026-02-04",
    title: "Initial Release",
    track: "cli",
    items: [
      "whk tunnel for forwarding webhooks to localhost",
      "whk listen for streaming requests to terminal",
      "whk create, list, delete for endpoint management",
    ],
  },

  // ─── SDK ────────────────────────────────────────────────────────────
  {
    version: "1.2.1",
    date: "2026-03-29",
    title: "Rate Limit Metadata",
    track: "sdk",
    items: [
      "RateLimitError now includes limit, remaining, and reset fields",
      "New RateLimitMeta type export",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-03-28",
    title: "Teams Support",
    track: "sdk",
    items: [
      "TeamShare type for endpoint team metadata",
      "Endpoint type includes sharedWith and fromTeam fields",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-03-20",
    title: "New Provider Templates",
    track: "sdk",
    items: [
      "Add SendGrid, Clerk, Discord, Vercel, GitLab provider templates",
      "Detection helpers: isSendGridWebhook, isClerkWebhook, isVercelWebhook, isGitLabWebhook",
      "Signature verification: verifyClerkSignature, verifyVercelSignature, verifyGitLabSignature",
      "Mock response delay field",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-03-14",
    title: "Proxy & Delay",
    track: "sdk",
    items: ["Mock response delay field support", "Minor type and documentation fixes"],
  },
  {
    version: "1.0.0",
    date: "2026-03-10",
    title: "Stable API",
    track: "sdk",
    items: [
      "WebhookFlowBuilder for multi-step test scenarios",
      "Request export (JSON, HAR) and clear methods",
      "Full-text search and count queries",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-03-08",
    title: "Build Request & Fixes",
    track: "sdk",
    items: [
      "buildRequest method for constructing signed webhook requests",
      "Fix raw secret detection for Standard Webhooks",
      "Request diffing (diffRequests)",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-03-08",
    title: "Standard Webhooks & sendTo",
    track: "sdk",
    items: [
      "Standard Webhooks provider and sendTo method",
      "matchContentType, matchQueryParam, matchBodySubset matchers",
      "Provider template sending with signed headers",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-02-22",
    title: "Signature Verification",
    track: "sdk",
    items: [
      "verifySignature for Stripe, GitHub, Shopify, Twilio, Slack, Paddle, Linear",
      "Webhook templates with realistic payloads",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-02-14",
    title: "SSE Streaming",
    track: "sdk",
    items: [
      "subscribe() SSE async iterator for real-time streaming",
      "describe() introspection for AI agents",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-02-06",
    title: "Matchers & Helpers",
    track: "sdk",
    items: [
      "Composable request matchers (matchMethod, matchHeader, matchBodyPath, matchAll, matchAny)",
      "Provider detection helpers (isStripeWebhook, isGitHubWebhook, etc.)",
      "parseJsonBody, parseFormBody, extractJsonField helpers",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-02-05",
    title: "Initial Release",
    track: "sdk",
    items: [
      "Endpoint CRUD (create, get, list, delete, update)",
      "Request list, waitFor with timeout and polling",
      "Replay captured requests to any URL",
      "Human-readable duration strings (30s, 5m)",
    ],
  },

  // ─── MCP ────────────────────────────────────────────────────────────
  {
    version: "1.1.0",
    date: "2026-03-20",
    title: "New Provider Templates",
    track: "mcp",
    items: [
      "Add SendGrid, Clerk, Discord, Vercel, GitLab to template and verify providers",
      "Mock response delay support",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-03-14",
    title: "Delay & Fixes",
    track: "mcp",
    items: ["Mock response delay support in update_endpoint tool", "Minor schema fixes"],
  },
  {
    version: "1.0.0",
    date: "2026-03-10",
    title: "Stable API",
    track: "mcp",
    items: [
      "Standard Webhooks provider support",
      "Batch endpoint create/delete tools",
      "Request export, search, and clear tools",
      "Setup commands for Cursor, VS Code, Windsurf, Claude Desktop, Codex",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-03-08",
    title: "Signature & Templates",
    track: "mcp",
    items: [
      "verify_signature tool for 9 providers",
      "send_webhook with provider template signing",
      "compare_requests and extract_from_request tools",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-02-22",
    title: "Webhook Templates",
    track: "mcp",
    items: ["Provider template support in send_webhook", "list_provider_templates tool"],
  },
  {
    version: "0.1.0",
    date: "2026-02-14",
    title: "Initial Release",
    track: "mcp",
    items: [
      "11 tools: create/list/get/update/delete endpoints, list/get requests, send/wait/replay, describe",
      "stdio transport via @modelcontextprotocol/sdk",
      "Setup CLI for Cursor, VS Code, Windsurf, Claude Desktop",
    ],
  },
];
