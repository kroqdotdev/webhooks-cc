import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, howToSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { StartFreeCTA } from "@/components/landing/start-free-cta";
import { PricingCTA } from "@/components/landing/pricing-cta";

const PATH = "/email-to-webhook";

export const metadata = createPageMetadata({
  title: "Email to Webhook: Inbound Email Parsed to Signed JSON",
  description:
    "Receive inbound email as a webhook. webhooks.cc parses every email to JSON (sender, subject, text, HTML, codes, links, attachments, SPF, DKIM and DMARC) and posts it to your URL, signed with Standard Webhooks headers and retried for a day.",
  path: PATH,
  keywords: [
    "email to webhook",
    "inbound email webhook",
    "email to json",
    "inbound email parsing",
    "parse incoming email",
    "receive email webhook",
    "email parser api",
    "email webhook",
    "standard webhooks",
  ],
});

const STEPS = [
  {
    name: "Create an endpoint",
    text: "Sign up free and create an endpoint. It receives email at its slug at mailhooks.cc.",
  },
  {
    name: "Add your URL",
    text: "In the endpoint's Settings, under Forwarding, enter your server's https URL and save. A signing secret starting with whsec_ is created; copy it into your handler.",
  },
  {
    name: "Send a test delivery",
    text: "Send test delivery posts the newest email, or a sample, to your URL once and shows the status, the time and the start of your server's answer.",
  },
  {
    name: "Turn forwarding on",
    text: "From then on every email the endpoint receives is posted to your URL as JSON, usually within a second or two.",
  },
];

const REQUEST_SAMPLE = `POST /hooks/email HTTP/1.1
Content-Type: application/json
webhook-id: msg_0b9e5f3a6c1d4f7e9a2b3c4d5e6f7a8b
webhook-timestamp: 1791450602
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{
  "type": "email.received",
  "timestamp": "2026-10-08T09:30:01.882Z",
  "data": {
    "id": "0b9e5f3a-6c1d-4f7e-9a2b-3c4d5e6f7a8b",
    "address": "acme-support+billing@mailhooks.cc",
    "tag": "billing",
    "subject": "Question about invoice 2291",
    "from": { "name": "Ines Duarte", "address": "ines@tidewater.app" },
    "to": [{ "name": null, "address": "acme-support+billing@mailhooks.cc" }],
    "text": "Hi, the invoice lists two seats but we have three...",
    "html": "<div>Hi, the invoice lists two seats...</div>",
    "codes": [],
    "links": [],
    "attachments": [
      { "filename": "invoice-2291.pdf", "contentType": "application/pdf", "size": 48211 }
    ],
    "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass", "tls": "TLSv1_3" },
    "headers": { "subject": "Question about invoice 2291", "...": "..." },
    "test": false
  }
}`;

const VERIFY_SAMPLE = `import { verifyStandardWebhookSignature } from "@webhooks-cc/sdk";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers);
  const age = Math.abs(Date.now() / 1000 - Number(headers["webhook-timestamp"]));
  const ok =
    age <= 300 &&
    (await verifyStandardWebhookSignature(rawBody, headers, process.env.FORWARD_SECRET!));
  if (!ok) return new Response("Invalid signature", { status: 401 });

  const { data } = JSON.parse(rawBody);
  await handleInboundEmail(data); // your code
  return new Response(null, { status: 204 });
}`;

const USE_CASES = [
  {
    title: "Handle replies and inbound requests",
    text: "Give customers or a partner an address and turn what they send into tickets, comments or records in your app.",
  },
  {
    title: "React to services that only send email",
    text: "Some vendors notify by email and nothing else. Forward those messages and handle them like any other webhook.",
  },
  {
    title: "Drive end-to-end tests",
    text: "Let a test server receive the signup or login email as JSON, with the one-time code and the main link already picked out.",
  },
  {
    title: "Feed email into a workflow or an agent",
    text: "Post structured email to an automation, a queue or an AI agent without writing a MIME parser first.",
  },
];

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "How do I receive email as a webhook?",
    answer:
      "Create a webhooks.cc endpoint, enter your URL under Forwarding in its Settings, and turn forwarding on. Every email sent to the endpoint's mailhooks.cc address is then posted to your URL as JSON, signed with Standard Webhooks headers.",
  },
  {
    question: "What does the JSON contain?",
    answer:
      "The sender, recipients, subject, date, message id, the text and HTML parts, the one-time codes and links found in the email, the name, type and size of each attachment, the SPF, DKIM and DMARC results, and every header. It is the same JSON each email's JSON tab shows in the dashboard. The codes and links fields are left out when the endpoint's owner turned off \"Show codes and links found in emails\", so treat them as optional.",
  },
  {
    question: "How are forwarded emails signed?",
    answer:
      "With Standard Webhooks headers: webhook-id, webhook-timestamp and webhook-signature, an HMAC-SHA256 of the id, the timestamp and the body with your endpoint's whsec_ secret. The webhooks.cc SDK and the official Standard Webhooks libraries verify them.",
  },
  {
    question: "What happens when my server is down?",
    answer:
      "A delivery that does not get a 2xx answer within 15 seconds is tried again after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, 3 hours, 6 hours and 12 hours, about a day in all. Each try is listed on the email with your server's status and the start of its answer, and you can redeliver by hand.",
  },
  {
    question: "Are attachments forwarded?",
    answer:
      "Their name, type and size are. The contents are not kept, so they are not forwarded either.",
  },
  {
    question: "Does forwarding cost extra?",
    answer:
      "No. Forwarding is on every plan, Free included, and does not use your quota: each email already counted as one request when it arrived.",
  },
  {
    question: "Can I forward to localhost?",
    answer:
      "No. The URL must be https on a public host name; IP addresses, localhost and private networks are refused. While you build the handler locally, copy an email's JSON from the dashboard and post it yourself.",
  },
];

export default function EmailToWebhookPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Email to webhook", path: PATH },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <JsonLd
        data={howToSchema({
          name: "How to receive inbound email as a webhook",
          description:
            "Forward every email a webhooks.cc endpoint receives to your server as signed JSON.",
          steps: STEPS,
          totalTime: "PT3M",
        })}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            Email to webhook, parsed to JSON
          </h1>
          <p className="text-xl text-muted-foreground mb-6">
            Send mail to an endpoint&apos;s mailhooks.cc address and webhooks.cc posts every email
            to your server as JSON. No mail server to run and no MIME to parse. Each request is
            signed with Standard Webhooks headers and retried until your server answers 2xx.
          </p>
          <StartFreeCTA goCta={null} />
          <p className="text-sm text-muted-foreground mt-4">
            On every plan. Read the{" "}
            <Link href="/docs/forwarding" className="text-primary font-bold hover:underline">
              forwarding docs
            </Link>{" "}
            for the full payload and examples in Node and Python.
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Set it up</h2>
          <ol className="space-y-4">
            {STEPS.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <span className="w-9 h-9 border-strong border-line rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0 shadow-raised-sm">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-bold mb-0.5">{step.name}</h3>
                  <p className="text-muted-foreground text-sm">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">What your server receives</h2>
          <p className="text-muted-foreground mb-6">
            One <code className="font-mono text-sm">POST</code> per email. The body is the parsed
            message; the headers let you check that it came from webhooks.cc. Every copy of one
            email carries the same <code className="font-mono text-sm">webhook-id</code>, so a
            handler can skip a retry it already processed.
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{REQUEST_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            Shortened. The full JSON also carries the endpoint, cc and reply-to addresses, the date,
            the message id, the size and which parts were cut.{" "}
            <code className="font-mono">codes</code> and <code className="font-mono">links</code>{" "}
            are left out when the endpoint&apos;s owner turned off &quot;Show codes and links found
            in emails&quot;.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Verify the signature</h2>
          <p className="text-muted-foreground mb-6">
            The signature is an HMAC-SHA256 of the id, the timestamp and the raw body, keyed with
            your endpoint&apos;s secret. Check it, and that the timestamp is recent, before you
            parse the body:
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{VERIFY_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            The official{" "}
            <a
              href="https://github.com/standard-webhooks/standard-webhooks"
              className="text-primary font-bold hover:underline"
              rel="noopener"
            >
              Standard Webhooks libraries
            </a>{" "}
            verify the same headers in Go, Python, Ruby, Java, PHP, Rust, C# and more.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">What people build with it</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {USE_CASES.map((useCase) => (
              <div key={useCase.title} className="ui-card ui-card-static">
                <h3 className="font-bold mb-1.5">{useCase.title}</h3>
                <p className="text-sm text-muted-foreground">{useCase.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Delivery and limits</h2>
          <ul className="grid sm:grid-cols-2 gap-3">
            {[
              "Any 2xx accepts a delivery; redirects are not followed",
              "15 seconds for your server to answer",
              "8 retries over about a day, then marked failed",
              "Every try logged, with a Redeliver button",
              "https URLs on public host names only",
              "Text and HTML up to 256 KB each; attachment contents not included",
              "Every plan, Free included",
              "No extra quota: each email counted once when it arrived",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <span className="text-sm">{item}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground mt-4">
            Testing the emails your own app sends rather than handling inbound mail? See{" "}
            <Link href="/email-testing" className="text-primary font-bold hover:underline">
              email testing
              <ArrowRight className="inline-block ml-1 h-4 w-4" />
            </Link>
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Email to webhook questions</h2>
          <FAQAccordion items={FAQ_ITEMS} />
        </section>

        <div className="ui-card bg-foreground text-background text-center py-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-3">Your first forwarded email</h2>
          <p className="opacity-80 mb-6 max-w-md mx-auto">
            Sign up free, create an endpoint, add your URL and send it an email.
          </p>
          <div className="flex justify-center text-foreground">
            <PricingCTA />
          </div>
          <p className="text-sm opacity-80 mt-6">No credit card</p>
        </div>
      </div>
    </main>
  );
}
