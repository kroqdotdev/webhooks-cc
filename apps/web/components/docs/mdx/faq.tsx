"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function FAQItem({ question, children }: { question: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b-2 border-foreground last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        type="button"
        className="flex w-full items-center justify-between py-4 px-4 text-left font-bold hover:bg-muted transition-colors cursor-pointer"
      >
        {question}
        <ChevronDown
          className={cn("h-5 w-5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && <div className="px-4 pb-4 text-sm text-muted-foreground [&>p]:mb-2">{children}</div>}
    </div>
  );
}

export function FAQ({ children }: { children: React.ReactNode }) {
  return <div className="my-6 border-2 border-foreground bg-card shadow-neo-sm">{children}</div>;
}

FAQ.Item = FAQItem;
