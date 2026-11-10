"use client";

import Link from "next/link";
import { CopyButton } from "@/components/ui/copy-button";

export function InstallCards() {
  return (
    <div className="mt-16 grid md:grid-cols-3 gap-6">
      <div className="ui-card ui-card-static">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">SDK</p>
        <div className="ui-code p-3! shadow-none! relative">
          <CopyButton text="npm install @webhooks-cc/sdk" />
          <code className="text-sm pr-8">
            <span className="text-primary-ink">$</span> npm install @webhooks-cc/sdk
          </code>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Also with{" "}
          <Link href="/installation" className="text-primary-ink hover:underline font-bold">
            pnpm, yarn, and bun, or for Python and Go
          </Link>
        </p>
      </div>
      <div className="ui-card ui-card-static">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">CLI</p>
        <div className="ui-code p-3! shadow-none! relative">
          <CopyButton text="curl -fsSL https://webhooks.cc/install.sh | sh" />
          <code className="text-sm pr-8">
            <span className="text-primary-ink">$</span> curl -fsSL https://webhooks.cc/install.sh |
            sh
          </code>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Also available via{" "}
          <Link href="/installation" className="text-primary-ink hover:underline font-bold">
            Homebrew
          </Link>
        </p>
      </div>
      <Link href="/docs/mcp" className="ui-card ui-card-static block group">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">MCP</p>
        <p className="text-sm font-bold group-hover:text-primary-ink transition-colors">
          Connect your AI agent: Claude Code, Cursor, VS Code, Codex, claude.ai & more.
        </p>
        <p className="text-xs text-primary-ink font-bold mt-2 group-hover:underline">
          Setup guide &rarr;
        </p>
      </Link>
    </div>
  );
}
