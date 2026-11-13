"use client";

import { useRef } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyWithFeedback } from "@/hooks/use-copy-with-feedback";

export function CodeBlock({
  children,
  title,
  ...props
}: React.ComponentProps<"pre"> & { title?: string }) {
  const { copy, isCopied } = useCopyWithFeedback();
  const copied = isCopied();
  const preRef = useRef<HTMLPreElement>(null);

  async function handleCopy() {
    const text = preRef.current?.textContent ?? "";
    await copy(text);
  }

  return (
    <div className="relative my-6 rounded-lg border border-border shadow-surface overflow-hidden">
      {/* The copy button sits in a header row, so it never covers the code. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-4 py-1">
        <span className="text-xs font-mono font-bold text-muted-foreground truncate">
          {title ?? ""}
        </span>
        <button
          onClick={handleCopy}
          className="shrink-0 flex items-center gap-1.5 px-2 py-1 text-xs font-bold rounded-md hover:bg-background transition-colors cursor-pointer"
          aria-label={copied ? "Copied" : "Copy code"}
          type="button"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={preRef} className="overflow-x-auto p-4 text-sm font-mono bg-muted" {...props}>
        {children}
      </pre>
    </div>
  );
}
