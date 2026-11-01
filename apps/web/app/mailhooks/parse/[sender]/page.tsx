import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { EmailToJson } from "@/components/mailhooks/email-to-json";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { UseTemplateButton } from "@/components/mailhooks/use-template-button";
import { LAYOUT_TEMPLATES, layoutTemplate } from "@/lib/layout-templates";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { webhooksOrigin } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return LAYOUT_TEMPLATES.map((template) => ({ sender: template.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ sender: string }> }) {
  const template = layoutTemplate((await params).sender);
  if (!template) return {};
  return mailhooksMetadata({
    title: template.title,
    description: template.description,
    path: `/parse/${template.id}`,
    keywords: [
      `${template.sender.toLowerCase()} email parser`,
      `parse ${template.sender.toLowerCase()} emails`,
      `${template.sender.toLowerCase()} ${template.kind} to json`,
    ],
  });
}

export default async function SenderPage({ params }: { params: Promise<{ sender: string }> }) {
  const template = layoutTemplate((await params).sender);
  if (!template) notFound();
  const others = LAYOUT_TEMPLATES.filter((other) => other.id !== template.id).slice(0, 6);
  return (
    <>
      <SiteHeader>
        <Link
          href="/parse"
          className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Senders
        </Link>
      </SiteHeader>
      <main className="py-16 px-4">
        <article className="max-w-6xl mx-auto">
          <p className="text-xs font-bold caps text-muted-foreground mb-3">
            {template.sender} {template.kind}
          </p>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">{template.title}</h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-3xl">{template.intro}</p>
          <div className="flex flex-wrap items-center gap-4 mb-12">
            <UseTemplateButton templateId={template.id} />
            <span className="text-sm text-muted-foreground">
              Free plan included: 2 layouts per endpoint.
            </span>
          </div>

          <EmailToJson template={template} />

          <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-8 mt-12">
            <section>
              <h2 className="text-2xl font-bold mb-4">The layout</h2>
              <p className="text-muted-foreground mb-4">
                It matches the email by its subject, reads each field with an RE2 pattern
                {template.layout.lineItems ? ", and turns the list into line items" : ""}
                {template.layout.parseAttachments ? ", and parses the attachments" : ""}. Edit any
                of it in the endpoint&apos;s settings, where the preview tries it on an email you
                captured as you type.
              </p>
              <pre className="ui-card ui-card-static text-xs font-mono overflow-x-auto leading-relaxed">
                {JSON.stringify(template.layout, null, 2)}
              </pre>
            </section>
            <aside>
              <h2 className="text-2xl font-bold mb-4">Before you rely on it</h2>
              <p className="text-muted-foreground mb-4">
                The email above is an example: real ones differ by account, settings and language.
                Send one of yours to the endpoint first, open it in the preview, and change a
                pattern where a field comes back empty.
              </p>
              <ul className="space-y-3 text-muted-foreground list-disc pl-5">
                {template.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
              <p className="text-sm mt-6">
                <Link href={`${webhooksOrigin()}/docs/layouts`} className="underline">
                  How layouts work
                </Link>
              </p>
            </aside>
          </div>

          <section className="mt-16">
            <h2 className="text-2xl font-bold mb-6">More senders</h2>
            <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {others.map((other) => (
                <li key={other.id}>
                  <Link href={`/parse/${other.id}`} className="ui-card block h-full">
                    <p className="font-bold">{other.title}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </article>
      </main>
      <MailhooksFooter />
    </>
  );
}
