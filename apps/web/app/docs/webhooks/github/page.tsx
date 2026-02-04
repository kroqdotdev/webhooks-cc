import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GitHub Webhooks - webhooks.cc Docs",
  description: "Set up GitHub webhook testing with webhooks.cc.",
};

export default function GitHubPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">GitHub Webhooks</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Capture and test GitHub webhooks during development. Inspect push events, pull request actions,
        and more.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">1. Create an endpoint</h2>
        <p className="text-muted-foreground mb-4">
          Create an endpoint in the{" "}
          <Link href="/dashboard" className="text-primary hover:underline font-bold">dashboard</Link>.
          Name it something like <code className="font-mono font-bold">GitHub Dev</code> and
          configure a mock response returning <code className="font-mono font-bold">200 OK</code>.
          Copy the generated URL from the URL bar.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">2. Configure GitHub</h2>
        <p className="text-muted-foreground mb-4">
          In your repository, go to <strong className="text-foreground">Settings &rarr; Webhooks &rarr; Add webhook</strong>:
        </p>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground mb-4">
          <li>
            <strong className="text-foreground">Payload URL:</strong>{" "}
            paste your endpoint URL (e.g., <code className="font-mono">https://go.webhooks.cc/w/&lt;slug&gt;</code>)
          </li>
          <li>
            <strong className="text-foreground">Content type:</strong>{" "}
            <code className="font-mono">application/json</code>
          </li>
          <li>
            <strong className="text-foreground">Secret:</strong> your webhook secret (optional but recommended)
          </li>
          <li>
            <strong className="text-foreground">Events:</strong> choose which events to receive
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">3. Forward to localhost</h2>
        <pre className="neo-code text-sm">{`whk tunnel 3000`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">4. Test it</h2>
        <p className="text-muted-foreground mb-4">
          Push a commit, open a PR, or use the <strong className="text-foreground">Redeliver</strong> button
          on an existing delivery in GitHub&#39;s webhook settings. The event appears in your dashboard
          and is forwarded to your local server.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Common events</h2>
        <div className="neo-code text-sm overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-foreground/20">
                <th className="text-left py-1.5 pr-4 font-bold">Event</th>
                <th className="text-left py-1.5 font-bold">Trigger</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4"><code>push</code></td>
                <td className="py-1.5 text-muted-foreground">Commits pushed to a branch</td>
              </tr>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4"><code>pull_request</code></td>
                <td className="py-1.5 text-muted-foreground">PR opened, closed, merged, or updated</td>
              </tr>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4"><code>issues</code></td>
                <td className="py-1.5 text-muted-foreground">Issue opened, closed, or edited</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-4"><code>release</code></td>
                <td className="py-1.5 text-muted-foreground">Release published or updated</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Signature verification</h2>
        <p className="text-muted-foreground">
          GitHub signs payloads with HMAC-SHA256 using your webhook secret. The{" "}
          <code className="font-mono font-bold">x-hub-signature-256</code> header is preserved when
          forwarding through webhooks.cc, so your local server can verify signatures as usual.
        </p>
      </section>
    </article>
  );
}
