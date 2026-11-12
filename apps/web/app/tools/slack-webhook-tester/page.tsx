import { SlackWebhookTester } from "@/components/tools/slack-webhook-tester";
import {
  NextStep,
  ReferenceTable,
  TextLink,
  ToolLink,
  ToolPageFrame,
  ToolSection,
} from "@/components/tools/tool-page";
import type { FAQItem } from "@/lib/schemas";
import { createPageMetadata } from "@/lib/seo";
import { requireTool, toolPath } from "@/lib/tools/catalog";

const page = requireTool("slack-webhook-tester");

// This page owns "slack webhook tester": someone with an incoming webhook URL
// who wants to see a message post. /webhooks/slack is about the events Slack
// sends to an app, and its title does not say "tester".
export const metadata = createPageMetadata({
  title: page.title,
  description: page.description,
  path: toolPath(page.slug),
  keywords: [
    "slack webhook tester",
    "slack webhook test",
    "test slack incoming webhook",
    "slack incoming webhook tester",
    "slack webhook invalid_payload",
    "slack webhook no_service",
    "slack webhook cors",
  ],
});

// Facts below are from Slack's documentation, read 2026-11-12.
const DOCS = {
  sending: {
    label: "Slack: Sending messages using incoming webhooks",
    href: "https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks",
  },
  errors: {
    label: "Changes to errors for incoming webhooks",
    href: "https://docs.slack.dev/changelog/2016-05-17-changes-to-errors-for-incoming-webhooks",
  },
  limits: {
    label: "Rate limits",
    href: "https://docs.slack.dev/apis/web-api/rate-limits",
  },
  postMessage: {
    label: "chat.postMessage",
    href: "https://docs.slack.dev/reference/methods/chat.postMessage",
  },
} as const;

const FAQ: FAQItem[] = [
  {
    question: "How do I test a Slack incoming webhook?",
    answer:
      'Paste the webhook URL into the tester above, write a message and press Send message. Slack answers 200 with the text "ok" when the message was posted to the channel the webhook was made for, and an error word such as invalid_payload or no_service when it was not. From a terminal the same test is one POST request with a JSON body and a Content-type: application/json header; the tester shows that curl command after each send.',
  },
  {
    question: "Why can my own web page not post to a Slack webhook (a CORS error)?",
    answer:
      "Slack documents the request as JSON with a Content-type: application/json header. Before a browser sends that header to another site, it asks the site for permission with a preflight request, and hooks.slack.com does not grant it, so the browser never sends the message and reports a CORS error. The usual answer is to post from your server, which also keeps the webhook URL out of the page's source where any visitor could read it. A request with a form body needs no preflight, which is how this tester sends from your browser: the same JSON in a form field named payload, which Slack accepts although its current documentation shows only the JSON request.",
  },
  {
    question: "What does invalid_payload mean?",
    answer:
      "Slack could not understand the body: the JSON is malformed, or its content does not match the content type it was sent with. It comes with a 400 status, and Slack says such a request should not be sent again without correcting it. Check that the body is one JSON object, that strings are in double quotes, and that line breaks inside strings are written as \\n.",
  },
  {
    question: "What does no_service mean?",
    answer:
      "The incoming webhook is disabled, removed or invalid: the last parts of the URL match no webhook. That happens when the webhook or its app was removed from the workspace, or when Slack revoked the URL, which it does for secrets it finds published, for instance in a public repository. Create a new webhook and keep its URL out of code that others can read.",
  },
  {
    question: "Can a message choose its own channel, name or icon?",
    answer:
      "Not with a webhook made by a Slack app: Slack's documentation says you cannot override the default channel, the username or the icon, and the message goes to the channel chosen when the app was installed. Only legacy custom-integration webhooks took channel, username, icon_emoji and icon_url fields in the payload.",
  },
  {
    question: "Is it safe to paste my Slack webhook URL here?",
    answer:
      "The URL contains a secret: anyone who has it can post to the channel. This page sends it to hooks.slack.com from your browser and nowhere else. There is no webhooks.cc server behind the tool, the page does not store what you type, and its analytics never record the fields. Your browser's network tab shows the one request, to hooks.slack.com.",
  },
  {
    question: "How do I test the events Slack sends to my app?",
    answer:
      "That is the other direction: the Events API, slash commands and interactive components are requests Slack sends to a URL of yours, signed with your signing secret. Point the Request URL at a webhooks.cc endpoint to capture and inspect them, and check their x-slack-signature header with the webhook signature checker.",
  },
];

export default function SlackWebhookTesterPage() {
  return (
    <ToolPageFrame
      page={page}
      heading="Slack webhook tester"
      lead="Paste an incoming webhook URL, write a message or Block Kit JSON, and send it. The request goes from your browser straight to Slack, and the answer is explained in plain words."
      tool={<SlackWebhookTester />}
      privacy="A webhook URL contains a secret. This tool sends it to hooks.slack.com and nowhere else: nothing you type reaches webhooks.cc, and nothing is stored."
      faq={FAQ}
      faqHeading="Slack webhook questions"
      footer={
        <NextStep
          title="Testing what Slack sends to you"
          links={[
            { href: "/webhooks/slack", label: "Capture Slack webhooks" },
            { href: "/docs/cli/tunnel", label: "Forward to localhost with whk tunnel" },
            { href: "/", label: "Get a free endpoint" },
          ]}
        >
          An incoming webhook posts into Slack. Events, slash commands and button presses come out
          of it, to a URL of yours. A webhooks.cc endpoint captures those requests with every header
          and the body, checks their signature, and forwards them to your machine while you build
          the handler.
        </NextStep>
      }
    >
      <ToolSection id="browser" title="What a browser can and cannot do here">
        <p>
          Slack documents one way to send: a <code>POST</code> with the message as JSON and the
          header <code>Content-type: application/json</code>. A web page cannot make that request.
          Before a browser sends that header to another site it asks the site for permission (a CORS
          preflight), and <code>hooks.slack.com</code> does not give it.
        </p>
        <p>
          So this tool sends the same JSON as a form field named <code>payload</code>. A form needs
          no preflight, and Slack&apos;s answers carry <code>Access-Control-Allow-Origin: *</code>,
          which lets the page read the status and the text and show them to you. Slack accepts the
          form, but its current documentation shows only the JSON request, so treat the curl command
          under each answer as the reference: if the tester gets <code>invalid_payload</code> for a
          message that looks right, run the curl command to rule out the difference.
        </p>
        <p>
          <strong>If the browser cannot read the answer</strong>, because an extension, a firewall
          or a network filter got in the way, the page cannot know whether Slack received the
          message. It says so rather than guess, and shows the curl command for the request as Slack
          documents it, which prints Slack&apos;s answer in your terminal.
        </p>
        <p>
          Two kinds of URL are not incoming webhooks and are refused before anything is sent:
          workflow webhooks (under <code>/triggers/</code>), which take the variables their workflow
          defines rather than a message, and GovSlack webhooks, which live on another host.
        </p>
      </ToolSection>

      <ToolSection title="How a Slack incoming webhook works">
        <p>
          An incoming webhook is a URL that posts messages into one Slack channel. You get one by
          creating a Slack app, turning on Incoming Webhooks and installing the app to a workspace;
          the channel is chosen at that moment, and the URL has the form{" "}
          <code>https://hooks.slack.com/services/T.../B.../...</code>. The URL contains a secret,
          and Slack searches for and revokes secrets it finds published.
        </p>
        <p>
          The simplest message is{" "}
          <code>&#123;&quot;text&quot;: &quot;Hello, world.&quot;&#125;</code>. Text takes
          Slack&apos;s own formatting: <code>*bold*</code>, <code>_italic_</code>, and links written
          as <code>&lt;https://example.com|link text&gt;</code>. For layout beyond text, add a{" "}
          <code>blocks</code> array of Block Kit blocks, up to 50 in a message; the JSON tab above
          sends whatever you write. Keep <code>text</code> under 4,000 characters, as{" "}
          <a
            href={DOCS.postMessage.href}
            rel="noopener"
            className="font-bold text-primary hover:underline"
          >
            Slack advises
          </a>
          ; it cuts off messages longer than 40,000.
        </p>
      </ToolSection>

      <ToolSection title="What Slack's answers mean">
        <p>
          Slack answers 200 with the plain text <code>ok</code> when a message is posted. Anything
          else is a failure, named by a word in the body. Slack documents a status code for these:
        </p>
        <ReferenceTable
          columns={["Answer", "Status", "Meaning"]}
          codeColumn={0}
          rows={[
            ["ok", "200", "The message was posted."],
            [
              "invalid_payload",
              "400",
              "The body could not be understood. Correct it before sending again.",
            ],
            ["user_not_found", "400", "The user named in the request does not exist."],
            [
              "action_prohibited",
              "403",
              "The workspace restricts this webhook from posting here. Trying again will not help.",
            ],
            ["channel_not_found", "404", "The channel the webhook posts to does not exist."],
            [
              "channel_is_archived",
              "410",
              "The channel was archived and accepts no more messages.",
            ],
            ["rollup_error", "500", "Something went wrong on Slack's side."],
          ]}
          source={[DOCS.errors, DOCS.sending, DOCS.limits]}
        />
        <p>
          And these words, whose status the documentation does not give: <code>no_service</code>{" "}
          (the webhook is disabled, removed or invalid), <code>no_team</code> (the workspace is
          missing or invalid), <code>team_disabled</code> (the workspace is no longer active),{" "}
          <code>no_active_hooks</code> (the webhook is disabled), <code>invalid_token</code> (the
          secret is expired, invalid or missing), <code>no_text</code> (the payload has no{" "}
          <code>text</code>), <code>posting_to_general_channel_denied</code> and{" "}
          <code>too_many_attachments</code> (more than 100).
        </p>
        <p>
          An incoming webhook takes about <strong>one message a second</strong>, with short bursts
          allowed. Past that Slack answers <code>429 Too Many Requests</code> with a{" "}
          <code>Retry-After</code> header giving the seconds to wait.
        </p>
      </ToolSection>

      <ToolSection title="The other direction: requests Slack sends to you">
        <p>
          Events, slash commands and interactive components are requests from Slack to your app,
          each signed with your signing secret in the <code>x-slack-signature</code> header. To
          check one by hand, paste its body and headers into the{" "}
          <ToolLink
            slug="webhook-signature-checker"
            className="font-bold text-primary hover:underline"
          >
            webhook signature checker
          </ToolLink>{" "}
          and pick Slack. To capture them as they arrive, see{" "}
          <TextLink href="/webhooks/slack">Slack webhooks</TextLink>.
        </p>
      </ToolSection>
    </ToolPageFrame>
  );
}
