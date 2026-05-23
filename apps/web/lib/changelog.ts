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

export const APP_VERSION = "0.20.2";
export const CLI_VERSION = "1.1.1";
export const SDK_VERSION = "1.5.0";
export const MCP_VERSION = "1.4.1";

export const CHANGELOG: ChangelogEntry[] = [
  // ─── Web App ────────────────────────────────────────────────────────
  {
    version: "0.20.2",
    date: "2026-05-23",
    title: "MCP v1.4.1 & CLI v1.1.1 Release",
    track: "web",
    items: [
      "MCP and CLI version bumps ship transitive dependency upgrades — zod 4 in MCP, tokio 1.52 and rustls-webpki refresh in the CLI",
    ],
  },
  {
    version: "0.20.1",
    date: "2026-05-15",
    title: "CI hardening & lint cleanup",
    track: "web",
    items: [
      "CI: Build Web App job now uses placeholder env values when Supabase secrets aren't available (e.g. Dependabot PRs), so dependency-update PRs get a meaningful build signal",
      "Resolved new strict react-hooks lint errors surfaced by an upcoming plugin bump, keeping the workspace lint-clean across plugin versions",
    ],
  },
  {
    version: "0.20.0",
    date: "2026-05-15",
    title: "Provider Auto-Detect & Typeform Support",
    track: "web",
    items: [
      "Dashboard auto-detects the webhook provider from headers and payload and renders a colored provider badge on each request",
      "Provider icons (Stripe, GitHub, Shopify, Twilio, Slack, Paddle, Linear, Clerk, Discord, Vercel, GitLab, Typeform, and more) across the request list and detail panes",
      "Typeform added to provider templates and signature verification — configure on any endpoint",
      "Hardened signing configuration invariants: partial or stale provider state is no longer possible, eliminating a class of silent verification failures",
      "Refreshed provider docs, ngrok and webhook.site comparison guides, signature verification guide, and MCP tools reference",
    ],
  },
  {
    version: "0.19.1",
    date: "2026-04-16",
    title: "Guest Dashboard SEO Overhaul",
    track: "web",
    items: [
      "Fixed layout bug on /go where hero copy rendered above the navbar",
      "Added feature cards flanking the Send Your First Webhook widget — mock responses, signature verification, CLI tunnel, SDK testing, MCP, and search/replay — visible without scrolling on xl+ screens",
      "Expanded server-rendered SEO content (14 internal doc links, 12 headings, 751 words, BreadcrumbList + FAQPage schemas, hreflang alternates)",
      "Promoted the page h1 to a visible subtitle inside the nav on md+ screens",
    ],
  },
  {
    version: "0.19.0",
    date: "2026-04-14",
    title: "Signature Verification",
    track: "web",
    items: [
      "Server-side webhook signature verification for 13 providers — configure once per endpoint, every request verified automatically",
      "New Signature tab in request detail: paste a secret for instant client-side verification, or view stored server-side results with detailed error diagnostics",
      "Verification badges (shield icons) in the request list and summary bar for at-a-glance valid/invalid status",
      "Signing configuration section in endpoint settings: provider dropdown, encrypted secret storage, provider-specific tips",
      "SDK: matchVerified() and matchUnverified() matchers for test assertions",
      "MCP: verify_signature returns stored results without needing a secret; create/update endpoints with signing config",
      "CLI: X-Signature-Verified headers on tunnel, verification status in listen output, --signing-provider/--signing-secret on create",
    ],
  },
  {
    version: "0.18.3",
    date: "2026-04-11",
    title: "Blog Resilience & Housekeeping",
    track: "web",
    items: [
      "Blog pages gracefully fall back when Supabase is unreachable instead of erroring",
      "Added SECURITY.md and CODE_OF_CONDUCT.md for open-source governance",
    ],
  },
  {
    version: "0.18.2",
    date: "2026-04-10",
    title: "SDK v1.3.0 & MCP v1.2.0 Release",
    track: "web",
    items: [
      "Updated llms.txt and llms-full.txt with conditional response rules documentation",
      "SDK and MCP version bumps for response rules and provider consolidation",
    ],
  },
  {
    version: "0.18.1",
    date: "2026-04-10",
    title: "Blog Page Redesign",
    track: "web",
    items: [
      "Redesigned blog index with clear visual hierarchy: featured post, two latest cards, and a scannable list for all posts",
      "Compact page header replacing the bulky hero section",
      "Fixed blog posts not appearing after publish due to stale Next.js fetch cache",
    ],
  },
  {
    version: "0.18.0",
    date: "2026-04-10",
    title: "Conditional Response Rules",
    track: "web",
    items: [
      "Define ordered response rules that match on method, path, headers, or body — first match wins",
      "Visual response rules editor in endpoint settings with drag-to-reorder",
      "Rules evaluated in the Rust receiver for low-latency conditional responses",
      "Full SDK, MCP, and API support for managing response rules",
    ],
  },
  {
    version: "0.17.4",
    date: "2026-04-08",
    title: "SEO & Accessibility Improvements",
    track: "web",
    items: [
      "Custom 404 page, OG image optimization (PNG→JPG), and improved sitemap generation",
      "Comprehensive structured data (JSON-LD) and meta tag improvements across all pages",
      "LLMs-full.txt for AI agent discoverability",
    ],
  },
  {
    version: "0.17.3",
    date: "2026-04-06",
    title: "Configurable Limits & Security Hardening",
    track: "web",
    items: [
      "Endpoint creation rate limits, ephemeral caps, and receiver body size now configurable via env vars",
      "Stored XSS regression test suite for endpoint names, mock responses, and request data",
    ],
  },
  {
    version: "0.17.2",
    date: "2026-04-06",
    title: "Teams Module Refactor",
    track: "web",
    items: [
      "Atomic team invite acceptance with member limit enforcement (max 25)",
      "Split teams module into focused sub-modules for better maintainability",
    ],
  },
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
    version: "1.1.1",
    date: "2026-05-23",
    title: "Dependency Maintenance",
    track: "cli",
    items: [
      "tokio 1.51 → 1.52, rustls-webpki refresh, axum 0.8.9, rand 0.8.6, clap 4.6.1, clap_complete 4.6.5, open 5.3.5 — picks up upstream security fixes",
      "Internal clippy 1.95 cleanups in the TUI event loop and update screen (no behavior change)",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-04-15",
    title: "Signature Verification",
    track: "cli",
    items: [
      "Tunnel forwards X-Signature-Verified, X-Signature-Provider, and X-Signature-Error headers",
      "Listen shows inline verification status (checkmark/cross) per request",
      "Create supports --signing-provider and --signing-secret flags (or WHK_SIGNING_SECRET env var)",
    ],
  },
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
    version: "1.5.0",
    date: "2026-05-15",
    title: "Typeform Provider & Webhook Auto-Detect",
    track: "sdk",
    items: [
      "Typeform provider templates (form_response, partial_response, payment) and verifyTypeformSignature",
      "detectWebhookInfo() and detectWebhookProvider() helpers for provider auto-detection from headers and body",
      "DetectedWebhookInfo type and isTypeformWebhook detection helper",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-04-15",
    title: "Signature Verification Matchers",
    track: "sdk",
    items: [
      "matchVerified() and matchUnverified() matchers for signature verification assertions",
      "signatureVerified, signatureError, and signingProvider fields on Request and Endpoint types",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-04-10",
    title: "Response Rules & Provider Consolidation",
    track: "sdk",
    items: [
      "ResponseRule and ResponseRuleCondition types for conditional mock responses",
      "validateResponseRules() and validation constants exported for shared use",
      "TEMPLATE_PROVIDERS, VERIFY_PROVIDERS, and buildTemplateSendOptions exports — single source of truth for provider logic",
      "Notification URL support in create/update endpoint options",
      "Raw body replay with byte-exact fidelity (base64-decoded bodyRaw)",
    ],
  },
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
    version: "1.4.1",
    date: "2026-05-23",
    title: "zod 4 Upgrade",
    track: "mcp",
    items: [
      "Upgrades the zod dependency from 3.x to 4.x with the matching tool-schema adaptation in src/tools.ts",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-05-15",
    title: "Typeform Provider Support",
    track: "mcp",
    items: [
      "Typeform exposed in list_provider_templates with templates, default event, and signature metadata",
      "Typeform usable in create_endpoint and update_endpoint signing config",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-04-15",
    title: "Signature Verification Tools",
    track: "mcp",
    items: [
      "Signing config (provider + secret) on create_endpoint and update_endpoint",
      "verify_signature tool returns stored server-side results with skipped detection",
      "Discord publicKey support for Ed25519 verification",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-04-10",
    title: "Response Rules & Notifications",
    track: "mcp",
    items: [
      "Response rules support in create_endpoint and update_endpoint tools",
      "Notification URL parameter for endpoint creation and updates",
      "Provider lists imported from SDK — single source of truth",
    ],
  },
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
