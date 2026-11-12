import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { EmailToJson } from "@/components/mailhooks/email-to-json";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { UseTemplateButton } from "@/components/mailhooks/use-template-button";
import { LAYOUT_TEMPLATES, layoutTemplate } from "@/lib/layout-templates";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Only the senders in the catalogue are pages. An unknown one is never
// rendered here: rendered on demand, each made-up slug was written to the
// route cache and answered 404 with a year of s-maxage. proxy.ts marks an
// unknown sender as missing, so the visitor still gets mailhooks.cc's own 404
// (app/mailhooks/missing), uncached.
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
        <Button
          variant="outlined"
          className="py-1.5! px-3! text-xs flex items-center gap-1.5"
          render={<Link href="/parse" />}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Layout gallery
        </Button>
      </SiteHeader>
      <main className="py-16 px-4">
        <article className="max-w-6xl mx-auto">
          <p className="text-xs font-bold text-muted-foreground mb-3">
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

          <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-8 mt-12">
            <section className="min-w-0">
              <h2 className="text-2xl font-bold mb-4">The layout</h2>
              <p className="text-muted-foreground mb-4">
                It matches the email by its subject, reads each field with an RE2 pattern
                {template.layout.lineItems ? ", and turns the list into line items" : ""}
                {template.layout.parseAttachments ? ", and parses the attachments" : ""}. Edit any
                of it in the endpoint&apos;s settings, where the preview tries it on an email you
                captured as you type.
              </p>
              <p className="mb-4">{matchSentence(template.layout.match?.conditions ?? [])}</p>
              {/* What it reads, as a table; the patterns stay one click away, as JSON. */}
              <Card className="p-0! overflow-x-auto mb-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Field
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Read from
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        In the example
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(template.layout.fields ?? []).map((field) => (
                      <tr key={field.name} className="border-b last:border-0">
                        <td className="px-4 py-2 font-mono">{field.name}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {field.from === "header"
                            ? `the ${field.header} header`
                            : `the ${field.from}`}
                        </td>
                        <td className="px-4 py-2 font-mono">
                          {template.result.fields[field.name] ?? "Not found"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Card className="group" render={<details />}>
                <summary className="cursor-pointer font-semibold list-none [&::-webkit-details-marker]:hidden flex items-center gap-2">
                  <ChevronRight
                    aria-hidden
                    className="h-4 w-4 transition-transform group-open:rotate-90"
                  />
                  The layout as JSON
                </summary>
                <pre className="mt-3 text-xs font-mono overflow-x-auto leading-relaxed">
                  {JSON.stringify(template.layout, null, 2)}
                </pre>
              </Card>
            </section>
            <aside className="min-w-0">
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
                <Link href="/docs/layouts" className="underline">
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
                  <Card
                    interactive
                    className="block h-full"
                    render={<Link href={`/parse/${other.id}`} />}
                  >
                    <p className="font-bold">{other.title}</p>
                  </Card>
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

/** The layout's conditions as one plain sentence. */
function matchSentence(conditions: { name?: string; op?: string; value?: unknown }[]): string {
  if (conditions.length === 0) return "It applies to every email the endpoint receives.";
  const ops: Record<string, string> = {
    contains: "contains",
    equals: "is",
    starts_with: "starts with",
    ends_with: "ends with",
    matches: "matches",
  };
  const parts = conditions.map(
    (c) =>
      `the ${c.name ?? "email"} ${ops[c.op ?? ""] ?? c.op ?? "matches"} "${String(c.value ?? "")}"`
  );
  return `It applies when ${parts.join(" and ")}.`;
}
