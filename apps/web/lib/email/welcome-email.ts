import { SITES, type SiteKey } from "@/lib/site";
import type { EmailMessage } from "./mailer";

/** No reply is read at the sending address, so auto-responders stay quiet. */
const AUTOMATIC = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };

/**
 * The remote MCP server and the installer live on webhooks.cc for both sites
 * (the OAuth issuer stays there), so these never follow the account's site.
 */
const MCP_URL = "https://webhooks.cc/mcp";
const CLI_INSTALL = "curl -fsSL https://webhooks.cc/install.sh | sh";
const CLAUDE_CODE_MCP = `claude mcp add -s user --transport http webhooks-cc ${MCP_URL}`;
const CURSOR_MCP = `{ "mcpServers": { "webhooks-cc": { "url": "${MCP_URL}" } } }`;
const SDK_INSTALL = "npm install @webhooks-cc/sdk";
/** The code behind both sites lives in one repository. */
export const REPO_URL = "https://github.com/kroqdotdev/webhooks-cc";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pre(lines: string[]): string {
  return (
    `<pre style="background:#f4f5f7;padding:10px 12px;font-size:13px;overflow-x:auto">` +
    `${lines.map(escapeHtml).join("\n")}</pre>`
  );
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/**
 * Builds the one email a new account gets: its dashboard, the three ways in
 * (CLI, MCP server, SDK) with the commands from the docs, a link to the
 * repository (the one link that leaves the account's site), and where to ask.
 * An account whose site is mailhooks.cc reads about email first. Pure (no
 * I/O) so it is unit-testable; the caller sends it through sendEmail(). The
 * commands must match /installation and the docs: change them together.
 */
export function buildWelcomeEmail(params: {
  to: string;
  /** The site the account signed in on; decides the name and what leads. */
  site: SiteKey;
  /** That site's origin, where the links go (sessions are per host). */
  appUrl: string;
}): EmailMessage {
  const { to, site, appUrl } = params;
  const name = SITES[site].name;
  const mail = site === "mailhooks";
  const dashboard = `${appUrl}/dashboard`;
  const docs = `${appUrl}/docs`;
  const firstDoc = mail ? `${appUrl}/docs/email-capture` : `${appUrl}/docs/cli/tunnel`;
  const sdkDoc = `${appUrl}/docs/sdk/testing`;
  const mcpDoc = `${appUrl}/docs/mcp`;
  const support = `${appUrl}/support`;

  const intro = mail
    ? [
        `Your ${name} account is ready. Every endpoint you create has its own email address,`,
        `<slug>@mailhooks.cc. Mail sent to it shows up in your dashboard as it arrives, with`,
        `its one-time codes and links picked out, and each endpoint has an HTTP URL for`,
        `webhooks as well.`,
      ]
    : [
        `Your ${name} account is ready. Create an endpoint, point a webhook sender at its URL,`,
        `and every request shows up in your dashboard as it arrives. Each endpoint also has an`,
        `email address, <slug>@mailhooks.cc, for testing the mail your app sends.`,
      ];

  const cliTitle = mail
    ? "From the terminal: forward emails and webhooks to localhost"
    : "From the terminal: forward webhooks to localhost";
  const cliNote = mail
    ? "whk tunnel creates an endpoint, prints its URL and email address, and posts each email " +
      "and request it receives to localhost:3000."
    : "whk tunnel creates an endpoint, prints its URL, and forwards every request it receives " +
      "to localhost:3000.";
  const cliCommands = [CLI_INSTALL, "whk auth login", "whk tunnel 3000"];

  const mcpTitle = "From your coding agent: the MCP server";
  const mcpNote =
    "You approve the connection once in your browser. There is no key to paste. Other clients:";

  const sdkTitle = "In your tests: the SDK";
  const sdkNote = mail
    ? "Create an endpoint, have your app send its email to the endpoint's address, and wait " +
      "for it to arrive. Python (pip install webhooks-cc) and Go " +
      "(go get webhooks.cc/go) work the same way."
    : "Create an endpoint, trigger your code, and wait for the webhook to arrive. Python " +
      "(pip install webhooks-cc) and Go (go get webhooks.cc/go) work the same way.";

  const star =
    `${name} is open source. If it saves you time, a star on GitHub helps other ` +
    "developers find it.";

  const help =
    "Stuck? Open a ticket and we will help. Replies to this email are not read, because it " +
    "is sent from an address without an inbox.";
  const footer = "We send this once, to new accounts.";

  return {
    to,
    subject: `Getting started with ${name}`,
    headers: AUTOMATIC,
    text: [
      ...intro,
      ``,
      `Your dashboard:`,
      dashboard,
      ``,
      `Three ways to use it from where you already work:`,
      ``,
      `1. ${cliTitle}`,
      ``,
      ...cliCommands.map((command) => `   ${command}`),
      ``,
      `   ${cliNote}`,
      `   ${firstDoc}`,
      ``,
      `2. ${mcpTitle}`,
      ``,
      `   Claude Code:`,
      `   ${CLAUDE_CODE_MCP}`,
      ``,
      `   Cursor, in .cursor/mcp.json:`,
      `   ${CURSOR_MCP}`,
      ``,
      `   ${mcpNote}`,
      `   ${mcpDoc}`,
      ``,
      `3. ${sdkTitle}`,
      ``,
      `   ${SDK_INSTALL}`,
      ``,
      `   ${sdkNote}`,
      `   ${sdkDoc}`,
      ``,
      `Docs:`,
      docs,
      ``,
      star,
      REPO_URL,
      ``,
      help,
      support,
      ``,
      footer,
    ].join("\n"),
    html: [
      `<p>${escapeHtml(intro.join(" "))}</p>`,
      `<p>${link(dashboard, "Open your dashboard")}</p>`,
      `<p>Three ways to use it from where you already work:</p>`,
      `<p><strong>1. ${escapeHtml(cliTitle)}</strong></p>`,
      pre(cliCommands),
      `<p>${escapeHtml(cliNote)} ${link(firstDoc, mail ? "Email capture" : "Tunneling")}</p>`,
      `<p><strong>2. ${escapeHtml(mcpTitle)}</strong></p>`,
      `<p>Claude Code:</p>`,
      pre([CLAUDE_CODE_MCP]),
      `<p>Cursor, in <code>.cursor/mcp.json</code>:</p>`,
      pre([CURSOR_MCP]),
      `<p>${escapeHtml(mcpNote)} ${link(mcpDoc, "MCP server docs")}</p>`,
      `<p><strong>3. ${escapeHtml(sdkTitle)}</strong></p>`,
      pre([SDK_INSTALL]),
      `<p>${escapeHtml(sdkNote)} ${link(sdkDoc, "Testing with the SDK")}</p>`,
      `<p>${link(docs, "Read the docs")}</p>`,
      `<p>${escapeHtml(star)} ${link(REPO_URL, "Star it on GitHub")}</p>`,
      `<p>${escapeHtml(help)} ${link(support, "Open a ticket")}</p>`,
      `<p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>`,
    ].join("\n"),
  };
}
