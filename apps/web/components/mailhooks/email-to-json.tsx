import type { LayoutTemplate } from "@/lib/layout-templates";
import { Card } from "@/components/ui/card";

/**
 * A sender page's picture of the idea: the email as it arrives, and what its
 * layout reads from it (the template's checked result, never invented here).
 */
export function EmailToJson({ template }: { template: LayoutTemplate }) {
  const { sample, result } = template;
  const json = {
    parsed: {
      status: "matched",
      layout: { id: template.layout.id, name: template.layout.name },
      fields: result.fields,
      lineItems: result.lineItems,
    },
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[repeat(2,minmax(0,1fr))] gap-6 items-stretch">
      <Card className="p-0! overflow-hidden flex flex-col" render={<figure />}>
        <figcaption className="px-5 py-3 border-b text-xs font-bold text-muted-foreground">
          The email
        </figcaption>
        <dl className="px-5 pt-4 text-sm grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">From</dt>
          <dd className="truncate">
            {sample.from.name} &lt;{sample.from.address}&gt;
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="font-medium">{sample.subject}</dd>
          {sample.attachment && (
            <>
              <dt className="text-muted-foreground">Attached</dt>
              <dd className="font-mono text-xs self-center">{sample.attachment}</dd>
            </>
          )}
        </dl>
        <pre className="flex-1 px-5 py-4 text-sm whitespace-pre-wrap font-sans leading-relaxed">
          {sample.text}
        </pre>
      </Card>
      <Card className="p-0! overflow-hidden flex flex-col" render={<figure />}>
        <figcaption className="px-5 py-3 border-b text-xs font-bold text-muted-foreground">
          What your endpoint delivers
        </figcaption>
        {/* On phones the JSON scrolls in a shorter box, so the page reaches "How it works" sooner. */}
        <pre
          tabIndex={0}
          aria-label="The JSON your endpoint delivers"
          className="px-5 py-4 text-xs font-mono overflow-x-auto leading-relaxed max-md:max-h-72 max-md:overflow-y-auto"
        >
          {JSON.stringify(json, null, 2)}
        </pre>
        {sample.attachment && (
          <p className="px-5 pb-4 text-xs text-muted-foreground">
            Shortened: the delivery also carries parsed.attachments, with the text or rows read from{" "}
            {sample.attachment}.
          </p>
        )}
      </Card>
    </div>
  );
}
