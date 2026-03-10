"use client";

import { useState, useRef } from "react";
import { Check, Copy } from "lucide-react";

export function CodeBlock({
  children,
  title,
  ...props
}: React.ComponentProps<"pre"> & { title?: string }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  async function handleCopy() {
    const text = preRef.current?.textContent ?? "";
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative my-6 border-2 border-foreground shadow-neo-sm overflow-hidden">
      {title && (
        <div className="border-b-2 border-foreground bg-muted px-4 py-1.5 text-xs font-mono font-bold text-muted-foreground">
          {title}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 border-2 border-foreground bg-background hover:bg-muted transition-colors cursor-pointer z-10"
        aria-label="Copy code"
        type="button"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre ref={preRef} className="overflow-x-auto p-4 text-sm font-mono bg-muted" {...props}>
        {children}
      </pre>
    </div>
  );
}
