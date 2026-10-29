"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { SiteHeader } from "@/components/nav/site-header";
import { DocsSidebar } from "@/components/docs/sidebar";
import { DocsBreadcrumbs } from "@/components/docs/breadcrumbs";
import { SearchModal } from "@/components/docs/search-modal";
import { AgentSkillInstall } from "@/components/docs/agent-skill-install";

type Tab = "cli" | "sdk" | "mcp";
const TABS: Tab[] = ["cli", "sdk", "mcp"];

const REMOTE_MCP_URL = "https://webhooks.cc/mcp";
const KEY_PLACEHOLDER = "whcc_...";
const KEY_REGEX = /^whcc_[A-Za-z0-9_-]+$/;

function buildCursorUrl(apiKey: string) {
  const config = JSON.stringify({
    command: "npx",
    args: ["-y", "@webhooks-cc/mcp"],
    env: { WHK_API_KEY: apiKey },
  });
  // Use TextEncoder for Unicode safety (btoa only handles Latin-1)
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(config)));
  return `https://cursor.com/en/install-mcp?name=webhooks-cc&config=${encoded}`;
}

const VSCODE_URL =
  "https://insiders.vscode.dev/redirect/mcp/install?name=webhooks-cc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40webhooks-cc%2Fmcp%22%5D%2C%22env%22%3A%7B%22WHK_API_KEY%22%3A%22%24%7Binput%3Awhk_api_key%7D%22%7D%7D&inputs=%5B%7B%22id%22%3A%22whk_api_key%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22webhooks.cc%20API%20key%20%28get%20yours%20at%20webhooks.cc%2Faccount%29%22%2C%22password%22%3Atrue%7D%5D";

function CodeBlock({ children, copyText }: { children: string; copyText?: string }) {
  return (
    <div className="relative">
      <CopyButton text={copyText ?? children} />
      <pre className="ui-code text-sm overflow-x-auto whitespace-pre-wrap break-words pr-10">
        {children}
      </pre>
    </div>
  );
}

export default function InstallationPage() {
  const [tab, setTab] = useState<Tab>("cli");
  const [apiKey, setApiKey] = useState("");
  const trimmed = apiKey.trim();
  const key = trimmed && KEY_REGEX.test(trimmed) ? trimmed : KEY_PLACEHOLDER;
  const cursorUrl = useMemo(() => buildCursorUrl(key), [key]);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <div className="px-4">
        <div className="max-w-7xl mx-auto flex">
          <DocsSidebar />
          <main className="flex-1 min-w-0 px-6 py-10 md:px-10">
            <DocsBreadcrumbs />
            <article className="max-w-3xl">
              <h1 className="text-3xl md:text-4xl font-bold mb-4">Installation</h1>
              <p className="text-lg text-muted-foreground mb-8">
                Install the CLI, SDK, or MCP server for your AI coding agent.
              </p>

              {/* Tab switcher */}
              <div
                role="tablist"
                className="border-strong border-line rounded-md overflow-hidden flex mb-8"
              >
                {TABS.map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    aria-controls={`tabpanel-${t}`}
                    id={`tab-${t}`}
                    tabIndex={tab === t ? 0 : -1}
                    onClick={() => setTab(t)}
                    onKeyDown={(e) => {
                      const idx = TABS.indexOf(t);
                      let next: number | null = null;
                      if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
                      else if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
                      else if (e.key === "Home") next = 0;
                      else if (e.key === "End") next = TABS.length - 1;
                      if (next !== null) {
                        e.preventDefault();
                        setTab(TABS[next]);
                        document.getElementById(`tab-${TABS[next]}`)?.focus();
                      }
                    }}
                    className={cn(
                      "flex-1 px-4 py-2.5 text-sm font-bold caps clean:uppercase cursor-pointer transition-colors border-r-strong border-line last:border-r-0",
                      tab === t
                        ? "bg-selected text-selected-foreground"
                        : "bg-background hover:bg-muted"
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Every panel is rendered, so the page's HTML carries all three for
                  readers that do not run scripts; the inactive ones are hidden. */}
              <div
                role="tabpanel"
                hidden={tab !== "cli"}
                id="tabpanel-cli"
                aria-labelledby="tab-cli"
                className="space-y-6"
              >
                <section>
                  <h2 className="text-lg font-bold mb-3">Homebrew (macOS / Linux)</h2>
                  <CodeBlock>{`brew install kroqdotdev/tap/whk`}</CodeBlock>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">Shell script (macOS / Linux)</h2>
                  <CodeBlock>{`curl -fsSL https://webhooks.cc/install.sh | sh`}</CodeBlock>
                  <p className="text-sm text-muted-foreground mt-2">
                    Downloads the latest binary for your platform, verifies its checksum, and
                    installs it to <code className="font-mono font-bold">/usr/local/bin</code>, with
                    sudo when needed. Without root, for example in CI or an agent&apos;s sandbox,
                    pick a directory you can write to; it is created when missing:
                  </p>
                  <div className="mt-3">
                    <CodeBlock>{`curl -fsSL https://webhooks.cc/install.sh | WHK_INSTALL_DIR="$HOME/.local/bin" sh`}</CodeBlock>
                  </div>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">GitHub Releases</h2>
                  <p className="text-sm text-muted-foreground">
                    Download pre-built binaries for macOS, Linux, and Windows from{" "}
                    <a
                      href="https://github.com/kroqdotdev/webhooks-cc/releases"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline font-bold"
                    >
                      GitHub Releases
                    </a>
                    .
                  </p>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">Verify</h2>
                  <CodeBlock>{`whk --version`}</CodeBlock>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">Get started</h2>
                  <p className="text-sm text-muted-foreground mb-3">
                    Run <code className="font-mono font-bold">whk</code> to open the interactive TUI
                    with tunneling, live request streaming, and endpoint management:
                  </p>
                  <CodeBlock>{`whk`}</CodeBlock>
                  <p className="text-sm text-muted-foreground mt-4 mb-3">
                    Or use subcommands directly:
                  </p>
                  <CodeBlock copyText="whk auth login">{`whk auth login      # authenticate via browser
whk tunnel 3000     # forward webhooks to localhost:3000`}</CodeBlock>
                  <p className="text-sm text-muted-foreground mt-2">
                    See the{" "}
                    <Link href="/docs/cli" className="text-primary hover:underline font-bold">
                      CLI docs
                    </Link>{" "}
                    for the full command reference.
                  </p>
                </section>
              </div>

              <div
                role="tabpanel"
                hidden={tab !== "sdk"}
                id="tabpanel-sdk"
                aria-labelledby="tab-sdk"
                className="space-y-6"
              >
                <section>
                  <h2 className="text-lg font-bold mb-3">npm</h2>
                  <CodeBlock>{`npm install @webhooks-cc/sdk`}</CodeBlock>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">pnpm</h2>
                  <CodeBlock>{`pnpm add @webhooks-cc/sdk`}</CodeBlock>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">bun</h2>
                  <CodeBlock>{`bun add @webhooks-cc/sdk`}</CodeBlock>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">yarn</h2>
                  <CodeBlock>{`yarn add @webhooks-cc/sdk`}</CodeBlock>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">Quick start</h2>
                  <CodeBlock>
                    {`import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({
  apiKey: process.env.WHK_API_KEY,
});

const endpoint = await client.endpoints.create({
  name: "my-endpoint",
});

console.log(endpoint.url);`}
                  </CodeBlock>
                </section>

                <p className="text-sm text-muted-foreground">
                  Generate an API key from your{" "}
                  <Link href="/account/api-keys" className="text-primary hover:underline font-bold">
                    API keys page
                  </Link>
                  . See the{" "}
                  <Link href="/docs/sdk" className="text-primary hover:underline font-bold">
                    SDK docs
                  </Link>{" "}
                  for the full API reference.
                </p>

                <section>
                  <h2 className="text-lg font-bold mb-3">Python</h2>
                  <CodeBlock>{`pip install webhooks-cc`}</CodeBlock>
                  <p className="text-sm text-muted-foreground mt-3">
                    The same testing tools for Python, with pytest fixtures. See the{" "}
                    <Link
                      href="/docs/sdk/python"
                      className="text-primary hover:underline font-bold"
                    >
                      Python SDK docs
                    </Link>
                    .
                  </p>
                </section>

                <section>
                  <h2 className="text-lg font-bold mb-3">Go</h2>
                  <CodeBlock>{`go get webhooks.cc/go`}</CodeBlock>
                  <p className="text-sm text-muted-foreground mt-3">
                    The same testing tools for Go, with helpers for <code>testing.TB</code>. See the{" "}
                    <Link href="/docs/sdk/go" className="text-primary hover:underline font-bold">
                      Go SDK docs
                    </Link>
                    .
                  </p>
                </section>
              </div>

              <div
                role="tabpanel"
                hidden={tab !== "mcp"}
                id="tabpanel-mcp"
                aria-labelledby="tab-mcp"
                className="space-y-10"
              >
                <div className="space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold mb-2">Remote server (recommended)</h2>
                    <p className="text-sm text-muted-foreground">
                      No key to paste and nothing to install. Add{" "}
                      <code className="font-mono font-bold">{REMOTE_MCP_URL}</code> to your client.
                      The first time it connects, webhooks.cc opens in your browser: sign in, or
                      sign up, and click Connect. There is no code to type.
                    </p>
                  </div>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Claude Code</h3>
                    <CodeBlock>{`claude mcp add -s user --transport http webhooks-cc ${REMOTE_MCP_URL}`}</CodeBlock>
                    <p className="text-sm text-muted-foreground mt-2">
                      Then run <code className="font-mono font-bold">/mcp</code> in Claude Code and
                      pick webhooks-cc to sign in.
                    </p>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">OpenAI Codex</h3>
                    <CodeBlock>{`codex mcp add webhooks-cc --url ${REMOTE_MCP_URL}`}</CodeBlock>
                    <p className="text-sm text-muted-foreground mt-2">
                      Codex opens your browser to sign in. If it does not, run{" "}
                      <code className="font-mono font-bold">codex mcp login webhooks-cc</code>.
                    </p>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Cursor</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      In <code className="font-mono font-bold">.cursor/mcp.json</code>:
                    </p>
                    <CodeBlock>{`{ "mcpServers": { "webhooks-cc": { "url": "${REMOTE_MCP_URL}" } } }`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">VS Code</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      In <code className="font-mono font-bold">.vscode/mcp.json</code>:
                    </p>
                    <CodeBlock>{`{ "servers": { "webhooks-cc": { "type": "http", "url": "${REMOTE_MCP_URL}" } } }`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">claude.ai and Claude Desktop</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      In Settings, Connectors, add a custom connector with this URL. ChatGPT takes
                      the same URL as a custom connector, in developer mode.
                    </p>
                    <CodeBlock>{REMOTE_MCP_URL}</CodeBlock>
                  </section>

                  <p className="text-sm text-muted-foreground">
                    Disconnect it at any time under{" "}
                    <Link href="/account/agents" className="text-primary hover:underline font-bold">
                      Connected agents
                    </Link>
                    . The{" "}
                    <Link
                      href="/docs/mcp#remote-server"
                      className="text-primary hover:underline font-bold"
                    >
                      remote server docs
                    </Link>{" "}
                    cover other clients and what differs from the local server.
                  </p>
                </div>

                <div className="space-y-6 border-t-strong border-line pt-10">
                  <div>
                    <h2 className="text-2xl font-bold mb-2">Local server</h2>
                    <p className="text-sm text-muted-foreground">
                      Runs <code className="font-mono font-bold">@webhooks-cc/mcp</code> on your
                      machine. Use it when your agent must send to localhost (
                      <code className="font-mono font-bold">send_to</code>,{" "}
                      <code className="font-mono font-bold">replay_request</code>), to start in the
                      agent sandbox without an account, or in CI with an API key.
                    </p>
                  </div>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Your API key</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Paste your API key to fill it into every command below. It stays in your
                      browser only. Nothing is sent or stored.
                    </p>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="whcc_..."
                      className="w-full px-3 py-2 border-strong border-line rounded-md bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="webhooks.cc API key"
                    />
                    <p className="text-sm text-muted-foreground mt-2">
                      Get your key from your{" "}
                      <Link
                        href="/account/api-keys"
                        className="text-primary hover:underline font-bold"
                      >
                        API keys page
                      </Link>
                      .
                    </p>
                  </section>

                  <AgentSkillInstall />

                  <section>
                    <h3 className="text-lg font-bold mb-3">One-click install</h3>
                    <div className="space-y-3">
                      <div>
                        <a
                          href={cursorUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 px-4 py-2 border-strong border-line rounded-md bg-background font-bold text-sm shadow-raised-sm hover:translate-x-(--press) hover:translate-y-(--press) hover:shadow-none clean:hover:bg-muted transition-all"
                        >
                          Add to Cursor
                        </a>
                        <p className="text-sm text-muted-foreground mt-1.5">
                          {key !== KEY_PLACEHOLDER
                            ? "Your key is included in the link, so do not share this URL."
                            : "Paste your key above first. It gets baked into the install link."}
                        </p>
                      </div>
                      <div>
                        <a
                          href={VSCODE_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 px-4 py-2 border-strong border-line rounded-md bg-background font-bold text-sm shadow-raised-sm hover:translate-x-(--press) hover:translate-y-(--press) hover:shadow-none clean:hover:bg-muted transition-all"
                        >
                          Add to VS Code
                        </a>
                        <p className="text-sm text-muted-foreground mt-1.5">
                          VS Code prompts you for your key during install.
                        </p>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Claude Code</h3>
                    <CodeBlock>{`claude mcp add -s user webhooks-cc -e WHK_API_KEY=${key} -- npx -y @webhooks-cc/mcp`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Cursor (CLI)</h3>
                    <CodeBlock>{`npx @webhooks-cc/mcp setup cursor --api-key ${key}`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">VS Code (CLI)</h3>
                    <CodeBlock>{`npx @webhooks-cc/mcp setup vscode --api-key ${key}`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">OpenAI Codex</h3>
                    <CodeBlock>{`codex mcp add webhooks-cc -e WHK_API_KEY=${key} -- npx -y @webhooks-cc/mcp`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Windsurf</h3>
                    <CodeBlock>{`npx @webhooks-cc/mcp setup windsurf --api-key ${key}`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Claude Desktop</h3>
                    <CodeBlock>{`npx @webhooks-cc/mcp setup claude-desktop --api-key ${key}`}</CodeBlock>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold mb-3">Manual config</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      For any tool that reads an MCP config JSON file:
                    </p>
                    <CodeBlock>
                      {`{
  "mcpServers": {
    "webhooks-cc": {
      "command": "npx",
      "args": ["-y", "@webhooks-cc/mcp"],
      "env": {
        "WHK_API_KEY": "${key}"
      }
    }
  }
}`}
                    </CodeBlock>
                  </section>

                  <p className="text-sm text-muted-foreground">
                    See the{" "}
                    <Link href="/docs/mcp" className="text-primary hover:underline font-bold">
                      MCP docs
                    </Link>{" "}
                    for the full tool reference.
                  </p>
                </div>
              </div>
            </article>
          </main>
        </div>
      </div>

      <SearchModal />
    </div>
  );
}
