import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Webhook CLI Guide",
  description:
    "Use the webhooks.cc CLI to forward webhooks to localhost, manage endpoints, and inspect requests directly from your terminal.",
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
        <pre className="neo-code text-sm mb-4">{`brew install kroqdotdev/tap/whk`}</pre>
        <p className="text-sm text-muted-foreground">
          See{" "}
          <Link href="/installation" className="text-primary hover:underline font-bold">
            all installation options
          </Link>{" "}
          (shell script, GitHub Releases).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Interactive mode</h2>
        <p className="text-muted-foreground mb-4">
          Run <code className="font-mono font-bold">whk</code> with no arguments to launch the
          interactive TUI:
        </p>
        <pre className="neo-code text-sm mb-4">{`whk`}</pre>
        <p className="text-muted-foreground mb-4">
          The main menu gives you access to every feature:
        </p>
        <ul className="list-disc list-inside space-y-1.5 text-muted-foreground mb-4">
          <li>
            <span className="font-bold text-foreground">Tunnel</span> — create an endpoint and
            forward webhooks to localhost
          </li>
          <li>
            <span className="font-bold text-foreground">Listen</span> — stream incoming requests in
            real time
          </li>
          <li>
            <span className="font-bold text-foreground">Endpoints</span> — create, list, and delete
            endpoints
          </li>
          <li>
            <span className="font-bold text-foreground">Auth</span> — log in and out
          </li>
          <li>
            <span className="font-bold text-foreground">Update</span> — check for new versions
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Requests are streamed in real time with color-coded HTTP methods, timestamps, and forward
          results. Press Enter on any request to inspect its headers and body. Navigation uses arrow
          keys or vim-style <code className="font-mono font-bold">j</code>/
          <code className="font-mono font-bold">k</code>.
        </p>
      </section>

      <section className="mb-10 border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-3">Subcommand mode</h2>
        <p className="text-muted-foreground mb-4">
          Every feature is also available as a direct subcommand, useful for scripting or when you
          prefer plain text output.
        </p>

        <h3 className="font-bold mb-2">Authenticate</h3>
        <pre className="neo-code text-sm mb-2">{`whk auth login`}</pre>
        <p className="text-sm text-muted-foreground mb-6">
          Opens your browser to verify a device code. Credentials are stored at{" "}
          <code className="font-mono font-bold">~/.config/whk/token.json</code>.
        </p>

        <h3 className="font-bold mb-2">Forward to localhost</h3>
        <pre className="neo-code text-sm mb-2">{`whk tunnel 3000`}</pre>
        <p className="text-sm text-muted-foreground mb-6">
          Creates an endpoint, prints its URL, and forwards every incoming webhook to{" "}
          <code className="font-mono font-bold">localhost:3000</code> in real time.
        </p>

        <p className="text-sm text-muted-foreground">
          To disable the TUI entirely, pass <code className="font-mono font-bold">--nogui</code> or
          set <code className="font-mono font-bold">WHK_NOGUI=1</code>.
        </p>
      </section>

      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">Learn more</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/docs/cli/commands" className="text-primary hover:underline font-bold">
              Command reference
            </Link>{" "}
            <span className="text-muted-foreground">— all commands and flags</span>
          </li>
          <li>
            <Link href="/docs/cli/tunnel" className="text-primary hover:underline font-bold">
              Tunneling deep dive
            </Link>{" "}
            <span className="text-muted-foreground">— advanced tunneling configuration</span>
          </li>
        </ul>
      </section>
    </article>
  );
}
