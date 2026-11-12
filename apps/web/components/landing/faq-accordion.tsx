"use client";

import { Accordion } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";

interface FAQAccordionProps {
  items: { question: string; answer: string }[];
}

/**
 * One answer open at a time. Closed answers stay in the page's HTML, and the
 * browser's find-in-page opens the one it finds.
 */
export function FAQAccordion({ items }: FAQAccordionProps) {
  return (
    <Accordion.Root className="space-y-4">
      {items.map((item) => (
        <Accordion.Item
          key={item.question}
          className="border border-border rounded-lg bg-card transition-all shadow-surface data-open:shadow-float"
        >
          {/* The question is a heading here; it keeps the body's letter spacing. */}
          <Accordion.Header className="tracking-normal">
            <Accordion.Trigger className="group w-full flex items-center justify-between gap-4 p-5 text-left cursor-pointer">
              <span className="font-bold text-lg">{item.question}</span>
              <ChevronDown className="h-5 w-5 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-180" />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Panel
            hiddenUntilFound
            className="h-(--accordion-panel-height) overflow-hidden transition-[height] duration-200 data-starting-style:h-0 data-ending-style:h-0"
          >
            <p className="px-5 pb-5 text-muted-foreground leading-relaxed">{item.answer}</p>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}
