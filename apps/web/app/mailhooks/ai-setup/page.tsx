import Link from "next/link";
import { Check, X } from "lucide-react";
import { FeaturePage } from "@/components/mailhooks/feature-page";
import { mailhooksFeature } from "@/lib/mailhooks-features";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { webhooksOrigin } from "@/lib/site";

const feature = mailhooksFeature("/ai-setup");

export const metadata = mailhooksMetadata({
  title: feature.title,
  description: feature.description,
  path: feature.path,
  keywords: feature.keywords,
});

const SENT = [
  "The 1 to 5 emails you picked, from the endpoint's own",
  "Their subject, sender, recipients, text and headers",
  "What you asked for: a field's name and what it is",
];

const NOT_SENT = [
  "Attachments, of any email",
  "Emails you did not pick",
  "Mail that arrives later: the patterns read it, not the AI",
];

export default function AiSetupPage() {
  return (
    <FeaturePage feature={feature}>
      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">What the AI sees</h2>
        <p className="text-muted-foreground mb-6">
          Only what you send with the box ticked, to Anthropic, our AI provider. We do not keep what
          is sent; a record of each ask holds who asked, when and how it went.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="ui-card ui-card-static">
            <h3 className="font-bold mb-3">Sent, when you ask</h3>
            <ul className="space-y-2">
              {SENT.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm">
                  <Check className="h-5 w-5 text-primary shrink-0" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h3 className="font-bold mb-3">Never sent</h3>
            <ul className="space-y-2">
              {NOT_SENT.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm">
                  <X className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          Anthropic is on our{" "}
          <Link
            href={`${webhooksOrigin()}/subprocessors`}
            className="text-primary font-bold hover:underline"
          >
            list of subprocessors
          </Link>
          .
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">How a proposal is checked</h2>
        <p className="text-muted-foreground mb-4">
          Whatever the model answers is treated as a draft. Each pattern is compiled with RE2 and
          run on every email you picked, and only fields that find a value in each of them come
          back, shown with the value they found. A layout comes with a match condition that every
          picked email meets.
        </p>
        <p className="text-muted-foreground">
          The result is the same kind of layout you would write by hand, so you can read it, change
          it and try it on an email in the preview. Start from a{" "}
          <Link href="/parse" className="text-primary font-bold hover:underline">
            ready-made layout
          </Link>{" "}
          instead when your sender has one.
        </p>
      </section>
    </FeaturePage>
  );
}
