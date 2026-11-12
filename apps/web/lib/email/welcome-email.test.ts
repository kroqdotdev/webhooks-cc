import { describe, expect, it } from "vitest";
import { GITHUB_REPO_URL as REPO_URL } from "@/lib/github";
import { buildWelcomeEmail } from "./welcome-email";

const webhooks = buildWelcomeEmail({
  to: "dev@example.com",
  site: "webhooks",
  appUrl: "https://webhooks.cc",
});
const mailhooks = buildWelcomeEmail({
  to: "dev@example.com",
  site: "mailhooks",
  appUrl: "https://mailhooks.cc",
});

describe("buildWelcomeEmail", () => {
  it("addresses the account and names its site in the subject", () => {
    expect(webhooks.to).toBe("dev@example.com");
    expect(webhooks.subject).toBe("Getting started with webhooks.cc");
    expect(mailhooks.subject).toBe("Getting started with mailhooks.cc");
  });

  it("links the dashboard, docs and support on the account's own site", () => {
    for (const path of ["/dashboard", "/docs", "/docs/mcp", "/docs/sdk/testing", "/support"]) {
      expect(webhooks.text).toContain(`https://webhooks.cc${path}\n`);
      expect(webhooks.html).toContain(`href="https://webhooks.cc${path}"`);
      expect(mailhooks.text).toContain(`https://mailhooks.cc${path}\n`);
      expect(mailhooks.html).toContain(`href="https://mailhooks.cc${path}"`);
    }
  });

  it("keeps every page link of a mailhooks.cc account on mailhooks.cc", () => {
    const hrefs = [...(mailhooks.html ?? "").matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((href) => href !== REPO_URL);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith("https://mailhooks.cc/")).toBe(true);
  });

  it("asks for a star on GitHub, naming the account's site", () => {
    expect(webhooks.text).toContain("webhooks.cc is open source.");
    expect(mailhooks.text).toContain("mailhooks.cc is open source.");
    for (const message of [webhooks, mailhooks]) {
      expect(message.text).toContain(`${REPO_URL}\n`);
      expect(message.html).toContain(`href="${REPO_URL}">Star it on GitHub</a>`);
    }
  });

  it("gives the commands as the docs have them, on either site", () => {
    for (const message of [webhooks, mailhooks]) {
      expect(message.text).toContain("curl -fsSL https://webhooks.cc/install.sh | sh");
      expect(message.text).toContain("whk auth login");
      expect(message.text).toContain("whk tunnel 3000");
      expect(message.text).toContain(
        "claude mcp add -s user --transport http webhooks-cc https://webhooks.cc/mcp"
      );
      expect(message.text).toContain(
        '{ "mcpServers": { "webhooks-cc": { "url": "https://webhooks.cc/mcp" } } }'
      );
      expect(message.text).toContain("npm install @webhooks-cc/sdk");
      expect(message.html).toContain("whk tunnel 3000");
      expect(message.html).toContain("npm install @webhooks-cc/sdk");
    }
  });

  it("leads with webhooks on webhooks.cc and with email on mailhooks.cc", () => {
    expect(webhooks.text.split("\n")[0]).toContain("point a webhook sender at its URL");
    expect(webhooks.text).toContain("forward webhooks to localhost");
    expect(webhooks.text).toContain("https://webhooks.cc/docs/cli/tunnel");
    expect(mailhooks.text.split("\n")[0]).toContain("has its own email address");
    expect(mailhooks.text).toContain("forward emails and webhooks to localhost");
    expect(mailhooks.text).toContain("https://mailhooks.cc/docs/email-capture");
  });

  it("escapes what the HTML variant carries", () => {
    expect(webhooks.html).toContain("&lt;slug&gt;@mailhooks.cc");
    expect(webhooks.html).not.toContain("<slug>");
    expect(webhooks.html).toContain("{ &quot;mcpServers&quot;:");

    const odd = buildWelcomeEmail({
      to: "dev@example.com",
      site: "webhooks",
      appUrl: `https://example.test/"><script>alert(1)</script>`,
    });
    expect(odd.html).not.toContain("<script>");
    expect(odd.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("points to support rather than a reply, and says it is sent once", () => {
    for (const message of [webhooks, mailhooks]) {
      expect(message.text).toContain("Replies to this email are not read");
      expect(message.text).toContain("We send this once, to new accounts.");
      expect(message.headers).toEqual({
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
      });
    }
  });

  it("carries no tracking, no images and no em dashes", () => {
    for (const body of [webhooks.text, webhooks.html, mailhooks.text, mailhooks.html]) {
      expect(body).not.toContain("<img");
      expect(body).not.toContain(String.fromCharCode(0x2014));
      expect(body).not.toMatch(/utm_|whk share/);
    }
  });
});
