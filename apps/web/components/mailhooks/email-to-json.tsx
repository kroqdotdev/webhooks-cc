import type { LayoutTemplate } from "@/lib/layout-templates";

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
    <div className="grid lg:grid-cols-2 gap-6 items-start">
      <figure className="ui-card ui-card-static p-0! overflow-hidden">
        <figcaption className="px-5 py-3 border-b-strong border-line text-xs font-bold caps text-muted-foreground">
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
        <pre className="px-5 py-4 text-sm whitespace-pre-wrap font-sans leading-relaxed">
          {sample.text}
        </pre>
      </figure>
      <figure className="ui-card ui-card-static p-0! overflow-hidden">
        <figcaption className="px-5 py-3 border-b-strong border-line text-xs font-bold caps text-muted-foreground">
          What your endpoint delivers
        </figcaption>
        <pre className="px-5 py-4 text-xs font-mono overflow-x-auto leading-relaxed">
          {JSON.stringify(json, null, 2)}
        </pre>
      </figure>
    </div>
  );
}
