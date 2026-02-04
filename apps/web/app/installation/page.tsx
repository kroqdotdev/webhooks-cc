"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Copy, Check } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { ThemeToggle } from "@/components/ui/theme-toggle";

type Tab = "cli" | "sdk";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 p-1.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

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

export default function InstallationPage() {
  const [tab, setTab] = useState<Tab>("cli");

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b-2 border-foreground shrink-0 bg-background sticky top-0 z-50">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-bold text-lg">
              webhooks.cc
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 md:px-10">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">Installation</h1>
        <p className="text-lg text-muted-foreground mb-8">
          Install the CLI to forward webhooks to localhost, or the SDK for programmatic access.
        </p>

        {/* Tab switcher */}
        <div className="border-2 border-foreground flex mb-8">
          {(["cli", "sdk"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 px-4 py-2.5 text-sm font-bold uppercase tracking-wide cursor-pointer transition-colors border-r-2 border-foreground last:border-r-0",
                tab === t ? "bg-foreground text-background" : "bg-background hover:bg-muted"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "cli" && (
          <div className="space-y-6">
            <section>
              <h2 className="text-lg font-bold mb-3">Homebrew (macOS / Linux)</h2>
              <CodeBlock>{`brew install lohsefar/tap/whk`}</CodeBlock>
            </section>

            <section>
              <h2 className="text-lg font-bold mb-3">Shell script (macOS / Linux)</h2>
              <CodeBlock>{`curl -fsSL https://webhooks.cc/install.sh | sh`}</CodeBlock>
              <p className="text-sm text-muted-foreground mt-2">
                Downloads the latest binary for your platform and installs it
                to <code className="font-mono font-bold">/usr/local/bin</code>.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold mb-3">GitHub Releases</h2>
              <p className="text-sm text-muted-foreground">
                Download pre-built binaries for macOS, Linux, and Windows from{" "}
                <a
                  href="https://github.com/lohsefar/webhooks-cc/releases"
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
        )}

        {tab === "sdk" && (
          <div className="space-y-6">
            <section>
              <h2 className="text-lg font-bold mb-3">npm</h2>
              <CodeBlock>{`npm install @webhookscc/sdk`}</CodeBlock>
            </section>

            <section>
              <h2 className="text-lg font-bold mb-3">pnpm</h2>
              <CodeBlock>{`pnpm add @webhookscc/sdk`}</CodeBlock>
            </section>

            <section>
              <h2 className="text-lg font-bold mb-3">bun</h2>
              <CodeBlock>{`bun add @webhookscc/sdk`}</CodeBlock>
            </section>

            <section>
              <h2 className="text-lg font-bold mb-3">yarn</h2>
              <CodeBlock>{`yarn add @webhookscc/sdk`}</CodeBlock>
            </section>

            <section>
              <h2 className="text-lg font-bold mb-3">Quick start</h2>
              <CodeBlock>
                {`import { WebhooksCC } from "@webhookscc/sdk";

const client = new WebhooksCC({
  apiKey: process.env.WEBHOOKS_API_KEY,
});

const endpoint = await client.endpoints.create({
  name: "my-endpoint",
});

console.log(endpoint.url);`}
              </CodeBlock>
            </section>

            <p className="text-sm text-muted-foreground">
              Generate an API key from your{" "}
              <Link href="/account" className="text-primary hover:underline font-bold">
                account page
              </Link>
              . See the{" "}
              <Link href="/docs/sdk" className="text-primary hover:underline font-bold">
                SDK docs
              </Link>{" "}
              for the full API reference.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
