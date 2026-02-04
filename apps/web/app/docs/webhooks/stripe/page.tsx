import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Stripe Webhooks - webhooks.cc Docs",
  description: "Set up Stripe webhook testing with webhooks.cc.",
};

export default function StripePage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Stripe Webhooks</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Test Stripe webhooks locally without exposing your development server to the internet.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">1. Create an endpoint</h2>
        <p className="text-muted-foreground mb-4">
          Create a new endpoint in the{" "}
          <Link href="/dashboard" className="text-primary hover:underline font-bold">dashboard</Link>.
          Name it something like <code className="font-mono font-bold">Stripe Dev</code> and
          copy the generated URL from the URL bar.
        </p>
        <p className="text-muted-foreground mb-4">
          Configure the mock response to return what Stripe expects:
        </p>
        <div className="neo-code text-sm mb-4">
          <div><strong>Status:</strong> 200</div>
          <div><strong>Body:</strong> {`{"received": true}`}</div>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">2. Add the URL to Stripe</h2>
        <p className="text-muted-foreground mb-4">
          In the{" "}
          <strong className="text-foreground">Stripe Dashboard &rarr; Developers &rarr; Webhooks</strong>,
          add a new endpoint with your webhooks.cc URL:
        </p>
        <pre className="neo-code text-sm mb-4">https://go.webhooks.cc/w/&lt;slug&gt;</pre>
        <p className="text-muted-foreground">
          Select the events you want to receive (e.g., <code className="font-mono">payment_intent.succeeded</code>,
          <code className="font-mono"> checkout.session.completed</code>).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">3. Forward to localhost</h2>
        <p className="text-muted-foreground mb-4">
          Use the CLI to forward captured webhooks to your local server:
        </p>
        <pre className="neo-code text-sm">{`whk tunnel 3000`}</pre>
        <p className="text-sm text-muted-foreground mt-3">
          Or use <code className="font-mono font-bold">whk listen &lt;slug&gt;</code> to
          stream requests from an existing endpoint to the terminal.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">4. Trigger a test event</h2>
        <p className="text-muted-foreground mb-4">
          Use the Stripe CLI or dashboard to send a test event:
        </p>
        <pre className="neo-code text-sm mb-4">{`stripe trigger payment_intent.succeeded`}</pre>
        <p className="text-muted-foreground">
          The webhook appears in your webhooks.cc dashboard and is forwarded to your local server.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Signature verification</h2>
        <p className="text-muted-foreground">
          Stripe signs webhooks with a secret. When testing through webhooks.cc, the original signature
          headers are preserved and forwarded. Your local server can verify them using the Stripe
          webhook signing secret from your Stripe dashboard. Use the{" "}
          <code className="font-mono font-bold">stripe-signature</code> header as usual.
        </p>
      </section>
    </article>
  );
}
