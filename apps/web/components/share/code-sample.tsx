import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Prose from the share pages' data, where `backticks` mark code: a setting's
 * name, a header, a command. Nothing else is read as markup.
 */
export function InlineCode({ text }: { text: string }): ReactNode {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono text-[0.9em] text-foreground">
        {part}
      </code>
    ) : (
      part
    )
  );
}

/**
 * A command or config snippet with a copy button. `copy` is what the button
 * copies when it is not the whole block (the command without its comments).
 */
export function CodeSample({
  code,
  file,
  copy,
}: {
  code: string;
  /** The file the snippet belongs in, shown above it: "next.config.ts". */
  file?: string;
  copy?: string;
}) {
  return (
    <div>
      {file && <p className="font-mono text-xs text-muted-foreground mb-1.5">{file}</p>}
      <div className="relative">
        <CopyButton text={copy ?? code} />
        <pre className="ui-code overflow-x-auto text-sm pr-10">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
