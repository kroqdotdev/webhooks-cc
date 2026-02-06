import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "CLI Overview Docs",
  description:
    "The webhooks.cc CLI lets you forward webhooks to localhost and manage endpoints from the terminal.",
  path: "/docs/cli",
});

export default function CliPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">CLI</h1>
      <p className="text-lg text-muted-foreground mb-10">
        The webhooks.cc CLI forwards incoming webhooks to your local development server. No port
        forwarding, no ngrok, no configuration.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Install</h2>
        <pre className="neo-code text-sm mb-4">{`brew install lohsefar/tap/whk`}</pre>
        <p className="text-sm text-muted-foreground">
          See{" "}
          <Link href="/installation" className="text-primary hover:underline font-bold">
            all installation options
          </Link>{" "}
          (shell script, GitHub Releases).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Authenticate</h2>
        <p className="text-muted-foreground mb-4">Log in with your webhooks.cc account:</p>
        <pre className="neo-code text-sm mb-4">{`whk auth login`}</pre>
        <p className="text-sm text-muted-foreground">
          Opens your browser to verify a device code. Your credentials are stored at{" "}
          <code className="font-mono font-bold">~/.config/whk/token.json</code>.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Forward to localhost</h2>
        <p className="text-muted-foreground mb-4">
          Create an endpoint and forward all requests to a local port:
        </p>
        <pre className="neo-code text-sm mb-4">{`whk tunnel 3000`}</pre>
        <p className="text-muted-foreground">
          This creates an endpoint, prints its URL, and forwards every incoming webhook to{" "}
          <code className="font-mono font-bold">localhost:3000</code> in real-time.
        </p>
      </section>

      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">Learn more</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/docs/cli/commands" className="text-primary hover:underline font-bold">
              Command reference
            </Link>{" "}
            <span className="text-muted-foreground">- all commands and flags</span>
          </li>
          <li>
            <Link href="/docs/cli/tunnel" className="text-primary hover:underline font-bold">
              Tunneling deep dive
            </Link>{" "}
            <span className="text-muted-foreground">- advanced tunneling configuration</span>
          </li>
        </ul>
      </section>
    </article>
  );
}
