import { CodeBlockCopy } from "./code-block-copy";

/**
 * A highlighted code block. A server component on purpose: only the copy
 * button is client code (see `CodeBlockCopy`), so the code is sent as HTML once.
 */
export function CodeBlock({
  children,
  title,
  ...props
}: React.ComponentProps<"pre"> & { title?: string }) {
  return (
    <div
      data-code-block=""
      className="relative my-6 rounded-lg border border-border shadow-surface overflow-hidden"
    >
      {/* The copy button sits in a header row, so it never covers the code. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-4 py-1">
        <span className="text-xs font-mono font-bold text-muted-foreground truncate">
          {title ?? ""}
        </span>
        <CodeBlockCopy />
      </div>
      <pre className="overflow-x-auto p-4 text-sm font-mono bg-muted" {...props}>
        {children}
      </pre>
    </div>
  );
}
