"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { CopyButton } from "@/components/ui/copy-button";

const KEY_PLACEHOLDER = "whcc_...";
const KEY_REGEX = /^whcc_[A-Za-z0-9_-]+$/;

const VSCODE_URL =
  "https://insiders.vscode.dev/redirect/mcp/install?name=webhooks-cc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40webhooks-cc%2Fmcp%22%5D%2C%22env%22%3A%7B%22WHK_API_KEY%22%3A%22%24%7Binput%3Awhk_api_key%7D%22%7D%7D&inputs=%5B%7B%22id%22%3A%22whk_api_key%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22webhooks.cc%20API%20key%20%28get%20yours%20at%20webhooks.cc%2Faccount%29%22%2C%22password%22%3Atrue%7D%5D";

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

const BTN =
  "inline-flex items-center gap-2 px-4 py-2 border-2 border-foreground bg-background font-bold text-sm shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all";

function CodeBlock({ children, copyText }: { children: string; copyText?: string }) {
  return (
    <div className="relative">
      <CopyButton text={copyText ?? children} />
      <pre className="neo-code text-sm overflow-x-auto whitespace-pre-wrap break-words pr-10">
        {children}
      </pre>
    </div>
  );
}

export function McpInstallGuide() {
  const [apiKey, setApiKey] = useState("");
  const trimmed = apiKey.trim();
  const key = trimmed && KEY_REGEX.test(trimmed) ? trimmed : KEY_PLACEHOLDER;
  const cursorUrl = useMemo(() => buildCursorUrl(key), [key]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xl font-bold mb-3">Your API key</h2>
        <p className="text-muted-foreground mb-3">
          Paste your API key to fill it into every command below. It stays in your browser only —
          nothing is sent or stored.
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="whcc_..."
          className="w-full px-3 py-2 border-2 border-foreground bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
          autoComplete="off"
          spellCheck={false}
          aria-label="webhooks.cc API key"
        />
        <p className="text-sm text-muted-foreground mt-2">
          Get your key from your{" "}
          <Link href="/account" className="text-primary hover:underline font-bold">
            account page
          </Link>
          .
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">One-click install</h2>
        <div className="space-y-3">
          <div>
            <a href={cursorUrl} target="_blank" rel="noopener noreferrer" className={BTN}>
              Add to Cursor
            </a>
            <p className="text-sm text-muted-foreground mt-1.5">
              {key !== KEY_PLACEHOLDER
                ? "Your key is included in the link — do not share this URL."
                : "Paste your key above first — it gets baked into the install link."}
            </p>
          </div>
          <div>
            <a href={VSCODE_URL} target="_blank" rel="noopener noreferrer" className={BTN}>
              Add to VS Code
            </a>
            <p className="text-sm text-muted-foreground mt-1.5">
              VS Code prompts you for your key during install.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Claude Code</h2>
        <CodeBlock>{`claude mcp add -s user webhooks-cc -e WHK_API_KEY=${key} -- npx -y @webhooks-cc/mcp`}</CodeBlock>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Cursor (CLI)</h2>
        <CodeBlock>{`npx @webhooks-cc/mcp setup cursor --api-key ${key}`}</CodeBlock>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">VS Code (CLI)</h2>
        <CodeBlock>{`npx @webhooks-cc/mcp setup vscode --api-key ${key}`}</CodeBlock>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">OpenAI Codex</h2>
        <CodeBlock>{`codex mcp add webhooks-cc -e WHK_API_KEY=${key} -- npx -y @webhooks-cc/mcp`}</CodeBlock>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Windsurf</h2>
        <CodeBlock>{`npx @webhooks-cc/mcp setup windsurf --api-key ${key}`}</CodeBlock>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Claude Desktop</h2>
        <CodeBlock>{`npx @webhooks-cc/mcp setup claude-desktop --api-key ${key}`}</CodeBlock>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Manual config</h2>
        <p className="text-muted-foreground mb-3">
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
    </div>
  );
}
