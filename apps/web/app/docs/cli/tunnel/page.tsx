import { createPageMetadata } from "@/lib/seo";
import { JsonLd, howToSchema, faqSchema, type FAQItem } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "CLI Tunneling Docs",
  description: "Forward webhooks from webhooks.cc to your local development server.",
  path: "/docs/cli/tunnel",
});

const TUNNEL_FAQ: FAQItem[] = [
  {
    question: "How do I forward webhooks to localhost?",
    answer:
      "Run whk tunnel 3000 to create an endpoint and forward all incoming webhooks to your local server. The CLI connects via SSE and replays each request with the original method, headers, and body.",
  },
  {
    question: "Do I need to expose my local port to the internet?",
    answer:
      "No. The webhooks.cc CLI creates an outbound connection from your machine. No port forwarding, firewall changes, or public IP address required.",
  },
  {
    question: "Can I use an existing endpoint with the tunnel?",
    answer:
      "Yes. Pass --endpoint <slug> to forward an endpoint you already created in the dashboard or CLI, instead of creating a new one.",
  },
];

export default function TunnelPage() {
  return (
    <article>
      <JsonLd
        data={howToSchema({
          name: "How to forward webhooks to localhost",
          description:
            "Forward webhooks from webhooks.cc to your local development server using the CLI tunnel. No port forwarding or public IP required.",
          totalTime: "PT2M",
          steps: [
            {
              name: "Start the tunnel",
              text: "Run whk tunnel 3000 to create an endpoint and start forwarding. The CLI prints the public endpoint URL.",
            },
            {
              name: "Webhook arrives at webhooks.cc",
              text: "When a webhook is sent to your endpoint URL, the server pushes it to the CLI over Server-Sent Events (SSE).",
            },
            {
              name: "CLI replays to localhost",
              text: "The CLI replays the request — method, headers, body — to your local port.",
            },
            {
              name: "Local server processes the request",
              text: "Your local server processes the webhook as if the sender called it directly.",
            },
          ],
        })}
      />
      <JsonLd data={faqSchema(TUNNEL_FAQ)} />
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Tunneling</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Forward webhooks to your local server without deploying or exposing ports.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Interactive mode</h2>
        <p className="text-muted-foreground mb-4">
          The fastest way to start tunneling is through the interactive TUI:
        </p>
        <pre className="neo-code text-sm mb-4">{`whk`}</pre>
        <p className="text-muted-foreground mb-4">
          Select <span className="font-bold text-foreground">Tunnel</span> from the menu, enter your
          local port, and the TUI connects automatically. Incoming requests appear in a live stream
          showing:
        </p>
        <ul className="list-disc list-inside space-y-1.5 text-muted-foreground mb-4">
          <li>Timestamp and color-coded HTTP method</li>
          <li>Request path</li>
          <li>Forward result with status code and latency</li>
        </ul>
        <p className="text-muted-foreground">
          Press Enter on any request to open the detail viewer with three tabs:{" "}
          <span className="font-bold text-foreground">Overview</span> (method, path, IP, size),{" "}
          <span className="font-bold text-foreground">Headers</span>, and{" "}
          <span className="font-bold text-foreground">Body</span> (with JSON pretty-printing). Press
          Esc to go back.
        </p>
      </section>

      <section className="mb-10 border-t-2 border-foreground pt-8">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-6">
          Subcommand mode
        </p>

        <h2 className="text-xl font-bold mb-3">Create and forward</h2>
        <pre className="neo-code text-sm mb-4">{`whk tunnel 3000`}</pre>
        <p className="text-muted-foreground">
          Creates an endpoint, prints its URL, and forwards every incoming request to{" "}
          <code className="font-mono font-bold">localhost:3000</code>. The sender receives the mock
          response you configured (200 OK by default).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Forward an existing endpoint</h2>
        <p className="text-muted-foreground mb-4">
          Use <code className="font-mono font-bold">--endpoint</code> to forward an endpoint you
          already created in the dashboard or CLI:
        </p>
        <pre className="neo-code text-sm">{`whk tunnel 3000 --endpoint <slug>`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Ephemeral mode</h2>
        <p className="text-muted-foreground mb-4">Delete the endpoint when the tunnel exits:</p>
        <pre className="neo-code text-sm">{`whk tunnel 3000 -e`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Custom headers</h2>
        <p className="text-muted-foreground mb-4">
          Inject headers into every forwarded request with{" "}
          <code className="font-mono font-bold">-H</code> (repeatable):
        </p>
        <pre className="neo-code text-sm whitespace-pre-wrap break-words">{`whk tunnel 3000 -H "Authorization: Bearer test-token" -H "X-Custom: value"`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Listen without forwarding</h2>
        <p className="text-muted-foreground mb-4">
          Stream requests to the terminal without forwarding them to a local server:
        </p>
        <pre className="neo-code text-sm">{`whk listen <slug>`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">How it works</h2>
        <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
          <li>The CLI creates (or connects to) an endpoint on webhooks.cc.</li>
          <li>
            When a webhook arrives, the server pushes it to the CLI over Server-Sent Events (SSE).
          </li>
          <li>The CLI replays the request — method, headers, body — to your local port.</li>
          <li>Your local server processes it as if the sender called it directly.</li>
        </ol>
        <p className="text-sm text-muted-foreground mt-3">
          Sensitive headers (Authorization, Cookie) from the original request are filtered out
          before forwarding. Use <code className="font-mono font-bold">-H</code> to inject
          authentication headers your local server needs.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Tips</h2>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
          <li>The tunnel reconnects on network interruptions.</li>
          <li>
            Your local server{"'"}s response does not affect what the webhook sender receives.
          </li>
          <li>Multiple tunnels can run against different endpoints simultaneously.</li>
          <li>
            Use <code className="font-mono font-bold">-e</code> for throwaway sessions that clean up
            on exit.
          </li>
          <li>
            Pass <code className="font-mono font-bold">--nogui</code> or set{" "}
            <code className="font-mono font-bold">WHK_NOGUI=1</code> to disable the TUI and use
            plain text output.
          </li>
        </ul>
      </section>
    </article>
  );
}
