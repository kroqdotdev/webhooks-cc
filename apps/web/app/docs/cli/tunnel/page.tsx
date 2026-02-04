import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tunneling - webhooks.cc Docs",
  description: "Forward webhooks from webhooks.cc to your local development server.",
};

export default function TunnelPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Tunneling</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Forward webhooks to your local server without deploying or exposing ports.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Create and forward</h2>
        <pre className="neo-code text-sm mb-4">{`whk tunnel 3000`}</pre>
        <p className="text-muted-foreground">
          Creates an endpoint, prints its URL, and forwards every incoming request
          to <code className="font-mono font-bold">localhost:3000</code>. The
          sender receives the mock response you configured (200 OK by default).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Forward an existing endpoint</h2>
        <p className="text-muted-foreground mb-4">
          Use <code className="font-mono font-bold">--endpoint</code> to
          forward an endpoint you already created in the dashboard or CLI:
        </p>
        <pre className="neo-code text-sm">{`whk tunnel 3000 --endpoint <slug>`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Ephemeral mode</h2>
        <p className="text-muted-foreground mb-4">
          Delete the endpoint when the tunnel exits:
        </p>
        <pre className="neo-code text-sm">{`whk tunnel 3000 -e`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Custom headers</h2>
        <p className="text-muted-foreground mb-4">
          Inject headers into every forwarded request
          with <code className="font-mono font-bold">-H</code> (repeatable):
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
          <li>When a webhook arrives, the server pushes it to the CLI over Server-Sent Events (SSE).</li>
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
          <li>Your local server{"'"}s response does not affect what the webhook sender receives.</li>
          <li>Multiple tunnels can run against different endpoints simultaneously.</li>
          <li>Use <code className="font-mono font-bold">-e</code> for throwaway sessions that clean up on exit.</li>
        </ul>
      </section>
    </article>
  );
}
