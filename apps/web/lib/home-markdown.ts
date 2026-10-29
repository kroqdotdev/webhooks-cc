/**
 * The markdown twin of the home page, for agents (proxy.ts serves it for
 * Accept: text/markdown on / and at /index.md). The page itself is a live
 * dashboard, so this is a short overview that points to the documents that
 * carry the detail (llms.txt, auth.md, the docs) rather than repeating them.
 * Pure; `appUrl` is NEXT_PUBLIC_APP_URL.
 */
export function buildHomeMarkdown(appUrl: string): string {
  return `---
title: "webhooks.cc: webhook and email testing for developers and AI agents"
description: "Capture and inspect webhooks and email in real time. Forward to localhost with the CLI, test in CI with the SDKs, and give coding agents the MCP server."
canonical: ${appUrl}/
---

# webhooks.cc

> Webhook and email testing for developers and AI agents. Capture, inspect, forward and test webhooks with a dashboard, a CLI, SDKs for TypeScript, Python and Go, and an MCP server.

Every endpoint has a capture URL, \`https://go.webhooks.cc/w/<slug>\`, that records any HTTP request sent to it, and endpoints on an account also receive email at \`<slug>@mailhooks.cc\`. Inspect captures in real time, answer senders with mock responses, send correctly signed test webhooks for Stripe, GitHub, Shopify and many more providers, forward deliveries to localhost or another server, and assert on captures in tests.

## Quick start for people

1. Open ${appUrl} to get a temporary endpoint without signing up, or sign up free for permanent endpoints, email capture, the CLI, the SDKs and the MCP server.
2. Send it a request:

   \`\`\`bash
   curl -X POST https://go.webhooks.cc/w/<slug> \\
     -H "Content-Type: application/json" \\
     -d '{"event": "payment.success", "amount": 4999}'
   \`\`\`

3. Watch it arrive in the dashboard, or forward live deliveries to your local server with the CLI (\`brew install kroqdotdev/tap/whk\`, then \`whk tunnel 3000\`).

More: [Quick start](${appUrl}/docs), [installation](${appUrl}/installation), [plans and limits](${appUrl}/docs/plans-limits).

## Quick start for agents

- **Remote MCP server (start here):** \`${appUrl}/mcp\` (streamable HTTP). Any client that can add a remote MCP server, Claude Code, Cursor, VS Code and Codex as well as claude.ai and ChatGPT, connects with one OAuth approval in the browser, with no key or code. In Claude Code: \`claude mcp add -s user --transport http webhooks-cc ${appUrl}/mcp\`, then \`/mcp\` to sign in. [Setup for each client](${appUrl}/docs/mcp#remote-server). A client that sends headers can use \`Authorization: Bearer whcc_...\` instead.
- **No account, or nobody to approve:** read [auth.md](${appUrl}/auth.md). An agent registers itself, gets a short-lived access token and a sandbox of temporary capture endpoints, and a person can later connect it to their account. Do not use the home page's guest endpoint; it is for people in a browser.
- **Local MCP server:** \`npx -y @webhooks-cc/mcp\`, for sends to localhost, the keyless sandbox, or CI with \`WHK_API_KEY\` set. [Setup for each client](${appUrl}/docs/mcp#local-server).
- **Agent skill:** tells a coding agent when to reach for these tools. \`npx skills add kroqdotdev/webhooks-cc\`, or in Claude Code \`/plugin install webhooks-cc --marketplace kroqdotdev/webhooks-cc\`. Index: [agent-skills/index.json](${appUrl}/.well-known/agent-skills/index.json).
- **REST API:** bearer tokens with the \`whcc_\` prefix on everything under \`${appUrl}/api/\`. [OpenAPI description](${appUrl}/openapi.yaml), [API catalog](${appUrl}/.well-known/api-catalog), [docs](${appUrl}/docs/api).
- **SDKs:** \`npm install @webhooks-cc/sdk\`, \`pip install webhooks-cc\`, \`go get webhooks.cc/go\`.

## Links

- Documentation: ${appUrl}/docs (markdown: ${appUrl}/docs.md; any docs page as markdown at its URL plus \`.md\`)
- Overview for language models: ${appUrl}/llms.txt
- Agent registration: ${appUrl}/auth.md
- OpenAPI: ${appUrl}/openapi.yaml
- API catalog (RFC 9727): ${appUrl}/.well-known/api-catalog
- Agent skills: ${appUrl}/.well-known/agent-skills/index.json
- MCP server: ${appUrl}/mcp
- Source code: https://github.com/kroqdotdev/webhooks-cc
`;
}
