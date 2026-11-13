"use client";

import { Copy, Check } from "lucide-react";
import { useCopyWithFeedback } from "@/hooks/use-copy-with-feedback";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const { copy, isCopied } = useCopyWithFeedback();
  const copied = isCopied();

  const handleCopy = () => void copy(text);

  return (
    <button
      onClick={handleCopy}
      className={
        className ??
        "absolute top-2 right-2 p-1.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
      }
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}
