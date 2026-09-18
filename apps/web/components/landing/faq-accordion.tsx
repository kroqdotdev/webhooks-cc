"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface FAQAccordionProps {
  items: { question: string; answer: string }[];
}

export function FAQAccordion({ items }: FAQAccordionProps) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="space-y-4">
      {items.map((item, i) => {
        const isOpen = open === i;
        const buttonId = `faq-button-${i}`;
        const panelId = `faq-panel-${i}`;
        return (
          <div
            key={item.question}
            className={`border-strong border-line rounded-lg bg-card transition-all ${
              isOpen
                ? "shadow-[6px_6px_0_0_hsl(var(--foreground))] clean:shadow-raised -translate-x-(--press) -translate-y-(--press)"
                : "shadow-[4px_4px_0_0_hsl(var(--foreground))] clean:shadow-raised-sm"
            }`}
          >
            <button
              id={buttonId}
              onClick={() => setOpen(isOpen ? null : i)}
              className="w-full flex items-center justify-between gap-4 p-5 text-left cursor-pointer"
              aria-expanded={isOpen}
              aria-controls={panelId}
            >
              <span className="font-bold text-lg">{item.question}</span>
              <ChevronDown
                className={`h-5 w-5 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
              />
            </button>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              aria-hidden={!isOpen}
              className={`grid transition-all duration-200 ${isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
            >
              <div className="overflow-hidden">
                <p className="px-5 pb-5 text-muted-foreground leading-relaxed">{item.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
