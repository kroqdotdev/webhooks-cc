"use client";

import Link from "next/link";
import { CopyButton } from "@/components/ui/copy-button";

export function InstallCards() {
  return (
    <div className="mt-16 grid md:grid-cols-2 gap-6">
      <div className="neo-card neo-card-static">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">SDK</p>
        <div className="neo-code !p-3 !shadow-none relative">
          <CopyButton text="npm install @webhooks-cc/sdk" />
          <code className="text-sm pr-8">
            <span className="text-primary">$</span> npm install @webhooks-cc/sdk
          </code>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Also works with{" "}
          <Link href="/installation" className="text-primary hover:underline font-bold">
            pnpm, yarn, and bun
          </Link>
        </p>
      </div>
      <div className="neo-card neo-card-static">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">CLI</p>
        <div className="neo-code !p-3 !shadow-none relative">
          <CopyButton text="curl -fsSL https://webhooks.cc/install.sh | sh" />
          <code className="text-sm pr-8">
            <span className="text-primary">$</span> curl -fsSL https://webhooks.cc/install.sh | sh
          </code>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Also available via{" "}
          <Link href="/installation" className="text-primary hover:underline font-bold">
            Homebrew
          </Link>
        </p>
      </div>
    </div>
  );
}
