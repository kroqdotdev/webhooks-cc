import { DiscordWebhookTester } from "@/components/tools/discord-webhook-tester";
import {
  NextStep,
  ReferenceTable,
  TextLink,
  ToolPageFrame,
  ToolSection,
} from "@/components/tools/tool-page";
import type { FAQItem } from "@/lib/schemas";
import { createPageMetadata } from "@/lib/seo";
import { requireTool, toolPath } from "@/lib/tools/catalog";

const page = requireTool("discord-webhook-tester");

// This page owns "discord webhook tester", "discord webhook checker" and
// "discord webhook test": someone with a webhook URL who wants to see a
// message post. /webhooks/discord is about capturing what Discord and your
// app send, and its title no longer says "tester".
export const metadata = createPageMetadata({
  title: page.title,
  description: page.description,
  path: toolPath(page.slug),
  keywords: [
    "discord webhook tester",
    "discord webhook checker",
    "discord webhook test",
    "test discord webhook",
    "send discord webhook message",
    "discord webhook 404",
    "discord webhook 429",
  ],
});

// Facts below are from Discord's developer documentation, read 2026-11-12.
const DOCS = {
  webhook: {
    label: "Discord: Webhook resource",
    href: "https://docs.discord.com/developers/resources/webhook",
  },
  message: {
    label: "Message resource",
    href: "https://docs.discord.com/developers/resources/message",
  },
  codes: {
    label: "Discord: Opcodes and status codes",
    href: "https://docs.discord.com/developers/topics/opcodes-and-status-codes",
  },
  limits: {
    label: "Rate limits",
    href: "https://docs.discord.com/developers/topics/rate-limits",
  },
} as const;

const FAQ: FAQItem[] = [
  {
    question: "How do I test a Discord webhook?",
    answer:
      "Paste the webhook URL into the tester above, write a message and press Send message. The message appears in the webhook's channel, and the page shows the status code and the body Discord answered with. From a terminal the same test is one POST request with a JSON body; the tester shows the matching curl command after each send.",
  },
  {
    question:
      "How do I check whether a Discord webhook URL still works without posting to the channel?",
    answer:
      "Press Check URL. It sends a GET request to the webhook URL, which Discord answers without any other authentication: a working URL returns the webhook's name and its channel and server ids, a deleted webhook returns 404 Unknown Webhook, and a wrong token returns 401 Invalid Webhook Token. Nothing is posted.",
  },
  {
    question: "Why does my Discord webhook return 404?",
    answer:
      "404 with the message Unknown Webhook (code 10015) means Discord has no webhook with that id. Either it was deleted in the channel's Integrations settings, or the URL was mistyped or cut short. Create a new webhook and replace the URL wherever it is used. Discord's documentation asks that a webhook answering 404 is not used again, and temporarily restricts clients that keep trying.",
  },
  {
    question: "What does 429 mean on a Discord webhook?",
    answer:
      "You are being rate limited: the webhook has been used faster than Discord allows. The JSON answer carries retry_after, the number of seconds to wait before the next request, and the response headers X-RateLimit-Remaining and X-RateLimit-Reset-After say how many requests are left and when the limit resets. Wait that long and send again. Clients that keep sending into 401, 403 or 429 answers can be blocked for a while: Discord counts 10,000 such requests in 10 minutes as the limit.",
  },
  {
    question: "Is it safe to paste my Discord webhook URL here?",
    answer:
      "The URL is a credential: anyone who has it can post to the channel. This page sends it to discord.com from your browser and nowhere else. There is no webhooks.cc server behind the tool, the page does not store what you type, and its analytics never record the fields. You can confirm this in your browser's network tab, which shows one request, to discord.com. If a webhook URL has leaked, delete the webhook in Discord and create a new one.",
  },
  {
    question: "How do I see what my own app sends to a Discord webhook?",
    answer:
      "Give your app a webhooks.cc endpoint URL in place of the Discord webhook URL. Each message it would have posted is captured with its full JSON body, so you can read the content and embeds before anything reaches a channel. When the payload looks right, turn on forwarding to the Discord webhook URL to pass captured requests on to the channel.",
  },
];

export default function DiscordWebhookTesterPage() {
  return (
    <ToolPageFrame
      page={page}
      heading="Discord webhook tester"
      lead="Paste a webhook URL, write a message, and send it. The request goes from your browser straight to Discord, and the answer is explained in plain words."
      tool={<DiscordWebhookTester />}
      privacy="A webhook URL is a credential. This tool sends it to discord.com and nowhere else: nothing you type reaches webhooks.cc, and nothing is stored."
      faq={FAQ}
      faqHeading="Discord webhook questions"
      footer={
        <NextStep
          title="See what your app sends before Discord does"
          links={[
            { href: "/webhooks/discord", label: "Capture Discord webhooks" },
            { href: "/docs/cli/tunnel", label: "Forward to localhost with whk tunnel" },
            { href: "/", label: "Get a free endpoint" },
          ]}
        >
          This tester posts a message you write. To test the messages your code writes, point it at
          a webhooks.cc endpoint: every request is captured with its headers and JSON body, can be
          replayed, and can be forwarded on to the real Discord webhook or to your machine.
        </NextStep>
      }
    >
      <ToolSection title="How a Discord webhook works">
        <p>
          A Discord webhook is a URL that posts messages into one channel. It needs no bot and no
          login: the URL itself carries the webhook&apos;s id and a secret token, as in{" "}
          <code>https://discord.com/api/webhooks/&#123;id&#125;/&#123;token&#125;</code>. You create
          one in a channel&apos;s settings under Integrations, Webhooks, and copy its URL from
          there.
        </p>
        <p>
          To post, send a <code>POST</code> request with a JSON body to that URL. Discord needs at
          least one of <code>content</code>, <code>embeds</code>, a file, components or a poll. The
          tester sends the fields below, and adds <code>wait=true</code> to the URL so that Discord
          answers with the message it saved; without it, Discord answers 204 with no body, and a
          message that could not be saved is not reported as an error.
        </p>
        <ReferenceTable
          columns={["Field", "What it does", "Limit"]}
          codeColumn={0}
          rows={[
            ["content", "The message text", "Up to 2,000 characters"],
            ["username", "Replaces the webhook's name for this one message", ""],
            [
              "embeds",
              "Rich blocks with a title, description, link and colour. The tester sends one.",
              "Up to 10 per message; title 256 and description 4,096 characters; 6,000 characters across the text fields of all embeds",
            ],
            [
              "allowed_mentions",
              "Which mentions may notify. The tester sends an empty list unless you tick the box, so a test pings no one.",
              "",
            ],
            [
              "thread_id",
              "In the URL's query string: posts into a thread of the webhook's channel. Keep it on the URL you paste and the tester passes it on.",
              "",
            ],
          ]}
          source={[DOCS.webhook, DOCS.message]}
        />
      </ToolSection>

      <ToolSection title="What Discord's answers mean">
        <p>
          Discord answers a webhook request with an HTTP status and, on an error, a JSON body
          holding a <code>message</code> and a numeric <code>code</code>. These are the ones a
          webhook meets.
        </p>
        <ReferenceTable
          columns={["Status", "Meaning"]}
          codeColumn={0}
          rows={[
            ["200", "The message was saved. With wait=true the body is the message itself."],
            ["204", "The request was accepted. This is the answer without wait=true."],
            [
              "400",
              "The body was refused: an empty message (code 50006), a field over its limit or malformed (50035, with the field named in errors), or JSON that could not be read (50109).",
            ],
            [
              "401",
              "Invalid Webhook Token (50027). The webhook exists, but the token in the URL is not its token.",
            ],
            [
              "404",
              "Unknown Webhook (10015). No webhook has this id: it was deleted, or the URL is wrong.",
            ],
            [
              "429",
              "Rate limited. The body's retry_after is the number of seconds to wait before sending again.",
            ],
            ["5xx", "An error on Discord's side. These are rare; wait and send again."],
          ]}
          source={[DOCS.codes, DOCS.limits]}
        />
        <p>
          A webhook in a forum or media channel answers 400 (code 220001) unless the request names a
          thread: every message there belongs to one. Add <code>?thread_id=</code> and the
          thread&apos;s id to the webhook URL to post in an existing thread, or send a{" "}
          <code>thread_name</code> in the body to start a new one (this tester does not).
        </p>
      </ToolSection>

      <ToolSection title="Webhooks and interaction endpoints are different things">
        <p>
          The webhook tested here is a URL you post <strong>to</strong>. Discord also sends requests
          the other way: slash commands and button presses go to your app&apos;s interactions
          endpoint, signed with Ed25519. Those are covered on the{" "}
          <TextLink href="/webhooks/discord">Discord webhooks page</TextLink>, which shows how to
          capture and inspect them.
        </p>
      </ToolSection>
    </ToolPageFrame>
  );
}
