import { toEmailCapture } from "@/lib/email-capture";
import type { EmailJsonSource } from "@/lib/email-json";

/**
 * A stand-in email for a test delivery from an endpoint that has not
 * received one yet. It goes through the same JSON builder as real mail and
 * is marked as a test.
 */
export function sampleEmailSource(address: string, now: Date = new Date()): EmailJsonSource {
  const text =
    "This is a test delivery from webhooks.cc.\n\nYour test code is 123456.\n\nRead about forwarding: https://webhooks.cc/docs/forwarding\n";
  const email = toEmailCapture({
    subject: "Test delivery from webhooks.cc",
    from: [{ name: "webhooks.cc", address: "test@webhooks.cc" }],
    to: [{ name: null, address }],
    date: now.toISOString(),
    message_id: `test-${now.getTime()}@webhooks.cc`,
    text,
    html: `<p>This is a test delivery from webhooks.cc.</p><p>Your test code is <b>123456</b>.</p><p><a href="https://webhooks.cc/docs/forwarding">Read about forwarding</a></p>`,
    smtp: { test: true, size: text.length },
  })!;
  return {
    id: "00000000-0000-4000-8000-000000000000",
    receivedAt: now.getTime(),
    path: address,
    size: text.length,
    headers: { subject: "Test delivery from webhooks.cc", from: "webhooks.cc <test@webhooks.cc>" },
    email,
  };
}
