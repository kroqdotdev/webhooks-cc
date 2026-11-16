"use client";

import { Check, Copy } from "lucide-react";
import { useCopyWithFeedback } from "@/hooks/use-copy-with-feedback";

/**
 * The copy button of a code block. It is the only client part of the block, so
 * the highlighted code is plain server HTML and never travels a second time as
 * client component props: a docs page with a hundred blocks halves in size.
 * The button reads the code from the block it sits in.
 */
export function CodeBlockCopy() {
  const { copy, isCopied } = useCopyWithFeedback();
  const copied = isCopied();

  return (
    <button
      onClick={(event) => {
        const block = event.currentTarget.closest("[data-code-block]");
        void copy(block?.querySelector("pre")?.textContent ?? "");
      }}
      className="shrink-0 flex items-center gap-1.5 px-2 py-1 text-xs font-bold rounded-md hover:bg-background transition-colors cursor-pointer"
      aria-label={copied ? "Copied" : "Copy code"}
      type="button"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
