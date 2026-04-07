import { GuestLiveDashboard } from "@/components/go/guest-live-dashboard";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, faqSchema, softwareApplicationSchema } from "@/lib/schemas";

const GO_FAQ_ITEMS = [
  {
    question: "Is there a free webhook endpoint with no signup?",
    answer:
      "Yes. The /go page creates a temporary guest endpoint so you can send a webhook and inspect the payload immediately without creating an account first.",
  },
  {
    question: "How long does a guest endpoint last?",
    answer:
      "Guest endpoints are ephemeral — they expire after 12 hours and accept up to 25 requests. Sign up free to get persistent endpoints with higher limits.",
  },
  {
    question: "Can I test webhooks locally and in CI?",
    answer:
      "Yes. Use the CLI to forward events to localhost during development and the SDK in automated test suites for CI pipelines.",
  },
] as const;

export const metadata = createPageMetadata({
  title: "Free Webhook Endpoint — No Signup Required",
  description:
    "Create a free webhook endpoint and inspect requests live in seconds. No account needed. Capture payloads, view headers, and debug webhooks instantly.",
  path: "/go",
  keywords: [
    "free webhook endpoint",
    "guest webhook endpoint",
    "live webhook test",
    "test webhook online",
    "webhook request inspector",
    "instant webhook url",
    "webhook capture free",
    "webhook payload viewer",
  ],
});

export default function GoPage() {
  return (
    <main>
      <JsonLd data={softwareApplicationSchema()} />
      <JsonLd data={faqSchema([...GO_FAQ_ITEMS])} />
      <section className="pt-28 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            Free webhook endpoint — ready in one click
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Capture and inspect incoming webhooks instantly. No signup required. Your endpoint is
            live for 12 hours with up to 25 requests.
          </p>
        </div>
      </section>
      <GuestLiveDashboard />
    </main>
  );
}
