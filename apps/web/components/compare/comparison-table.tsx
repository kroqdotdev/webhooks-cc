import Link from "next/link";
import { CodeBox } from "@/components/ui/code";
import { cn } from "@/lib/utils";

/**
 * The faint pine that marks our own column or row in a comparison. Dark mode
 * takes 60% of the selected tint, which reads as faint there as the full tint
 * does in light mode. Exported so tables built by hand (the team pricing on
 * /for-teams) match this one.
 */
export const OUR_TINT = "bg-selected dark:bg-selected/60";

export type ComparisonTool = {
  name: string;
  /** Links the column header, usually to the tool's own comparison page. */
  href?: string | null;
  /** Our own column (webhooks.cc, whk share): drawn on the pine tint. */
  ours?: boolean;
};

/**
 * A feature table on the comparison pages: one row per feature (its name,
 * then one cell per tool in `tools` order). The column marked `ours` is one
 * band of the selected tint from the header to the last row, so a reader
 * finds our answers at a glance; its header names it too, so the tint is
 * never the only signal. `dense` keeps headers and feature names on one line,
 * for tables with many tools that scroll sideways.
 *
 * The table uses separate borders with no spacing, because cells under the
 * collapsed model cannot round their corners; the row rules are therefore on
 * the cells, not the rows.
 */
export function ComparisonTable({
  tools,
  rows,
  dense = false,
  className,
}: {
  tools: readonly ComparisonTool[];
  rows: readonly (readonly string[])[];
  dense?: boolean;
  className?: string;
}) {
  const last = rows.length - 1;
  return (
    <CodeBox className={cn("overflow-x-auto", className)}>
      <table className="w-full text-sm border-separate border-spacing-0">
        <thead>
          <tr>
            <th scope="col" className="text-left py-2.5 pr-3 font-bold border-b">
              Feature
            </th>
            {tools.map((tool) => (
              <th
                key={tool.name}
                scope="col"
                className={cn(
                  "text-left py-2.5 px-3 font-bold border-b",
                  dense && "whitespace-nowrap",
                  tool.ours && cn(OUR_TINT, "text-selected-foreground rounded-t-md")
                )}
              >
                {tool.href ? (
                  <Link href={tool.href} className="hover:text-primary transition-colors">
                    {tool.name}
                  </Link>
                ) : (
                  tool.name
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row[0]}>
              <th
                scope="row"
                className={cn(
                  "text-left align-top py-2.5 pr-3 font-medium",
                  r !== last && "border-b border-foreground/20",
                  dense && "whitespace-nowrap"
                )}
              >
                {row[0]}
              </th>
              {tools.map((tool, i) => (
                <td
                  key={tool.name}
                  className={cn(
                    "align-top py-2.5 px-3",
                    r !== last && "border-b border-foreground/20",
                    tool.ours && OUR_TINT,
                    tool.ours && r === last && "rounded-b-md"
                  )}
                >
                  {row[i + 1]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </CodeBox>
  );
}
