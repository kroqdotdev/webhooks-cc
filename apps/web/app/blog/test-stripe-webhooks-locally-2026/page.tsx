import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogPostShell, type BlogPostData } from "@/components/blog/blog-post-shell";
import { getBlogPostBySlug } from "@/lib/blog";
import { createBlogPostMetadata, createPageMetadata } from "@/lib/seo";

const meta = getBlogPostBySlug("test-stripe-webhooks-locally-2026");

export const metadata = meta
  ? createBlogPostMetadata(meta)
  : createPageMetadata({
      title: "How to test Stripe webhooks locally in 2026",
      description:
        "Set up a local Stripe webhook workflow with a stable public endpoint, live request inspection, replay, and signature verification on localhost.",
      path: "/blog/test-stripe-webhooks-locally-2026",
    });

const post: BlogPostData | null = meta
  ? {
      slug: meta.slug,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      readMinutes: meta.readMinutes,
      publishedAt: new Date(`${meta.publishedAt}T00:00:00.000Z`).getTime(),
      updatedAt: new Date(`${meta.updatedAt}T00:00:00.000Z`).getTime(),
      tags: [...meta.tags],
      seoTitle: meta.title,
      seoDescription: meta.description,
      keywords: [...meta.tags],
      schemaType: "howto",
      authorName: "webhooks.cc",
      featured: false,
    }
  : null;

const headings = [
  { id: "architecture", text: "Architecture", level: 2 as const },
  { id: "start-handler", text: "Start local handler", level: 2 as const },
  { id: "open-tunnel", text: "Open tunnel", level: 2 as const },
  { id: "configure-stripe", text: "Configure Stripe endpoint", level: 2 as const },
  { id: "verify-signature", text: "Verify signature", level: 2 as const },
  { id: "debug-loop", text: "Debug loop", level: 2 as const },
];

export default function StripeLocalBlogPage() {
  if (!post) notFound();

  return (
    <BlogPostShell post={post} headings={headings} relatedPosts={[]}>
      <p>
        Stripe webhook testing is fastest when you can receive real event payloads on localhost
        without exposing your machine directly. The workflow below gives you three things in one
        loop: a stable public URL, full request history, and local handler feedback.
      </p>

      <h2 id="architecture">Architecture</h2>
      <p>
        Stripe sends events to your webhooks.cc endpoint URL. webhooks.cc stores each request and,
        when you run the CLI tunnel, forwards the request to your local server. You get capture,
        replay, and local execution at the same time.
      </p>
      <pre className="neo-code text-sm">{`Stripe -> https://go.webhooks.cc/w/<slug> -> whk tunnel -> http://localhost:3000/webhooks`}</pre>

      <h2 id="start-handler">1. Start your local webhook handler</h2>
      <pre className="neo-code text-sm">{`npm run dev`}</pre>
      <p>
        Make sure your webhook route accepts POST requests and reads the raw body before JSON
        parsing. Stripe signature verification depends on the exact raw payload.
      </p>

      <h2 id="open-tunnel">2. Open a tunnel to localhost</h2>
      <pre className="neo-code text-sm">{`whk tunnel 3000`}</pre>
      <p>
        The command prints the endpoint slug and forwards incoming requests to port 3000. Keep this
        process running during your test session.
      </p>

      <h2 id="configure-stripe">3. Configure Stripe webhook destination</h2>
      <p>
        In Stripe Dashboard, set your webhook destination to:
        <code>https://go.webhooks.cc/w/&lt;slug&gt;</code>
      </p>
      <p>
        Subscribe to the events you actually handle first (for example:
        <code>payment_intent.succeeded</code>, <code>checkout.session.completed</code>) instead of
        enabling every event.
      </p>

      <h2 id="verify-signature">4. Verify Stripe signatures in your app</h2>
      <pre className="neo-code text-sm">{`const event = stripe.webhooks.constructEvent(
  rawBody,
  req.headers["stripe-signature"],
  process.env.STRIPE_WEBHOOK_SECRET
);`}</pre>
      <p>
        To test this quickly, use the dashboard <strong>Send</strong> button with the Stripe
        template presets. Set your mock webhook secret to the same value your app verifies against.
      </p>

      <h2 id="debug-loop">5. Tight debug loop</h2>
      <ul>
        <li>Trigger a Stripe test event.</li>
        <li>Inspect headers and body in the dashboard request viewer.</li>
        <li>Replay the request to localhost after code changes.</li>
        <li>Add a deterministic SDK assertion for CI once behavior is stable.</li>
      </ul>

      <pre className="neo-code text-sm">{`const req = await client.requests.waitFor(endpoint.slug, {
  timeout: "30s",
  match: matchHeader("stripe-signature"),
});`}</pre>

      <p>
        Continue with{" "}
        <Link href="/blog/webhook-testing-cicd-typescript">
          webhook testing in CI/CD with TypeScript
        </Link>
        .
      </p>
    </BlogPostShell>
  );
}
