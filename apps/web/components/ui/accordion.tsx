"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";

/**
 * Show-and-hide sections where one opens at a time (Base UI's Accordion).
 * Unstyled, like Collapsible: an item's open state is `data-open:`, a
 * trigger's chevron turns with `group-data-panel-open:`. A Header is an <h3>.
 */
const Accordion = AccordionPrimitive.Root;
const AccordionItem = AccordionPrimitive.Item;
const AccordionHeader = AccordionPrimitive.Header;
const AccordionTrigger = AccordionPrimitive.Trigger;
const AccordionPanel = AccordionPrimitive.Panel;

export { Accordion, AccordionItem, AccordionHeader, AccordionTrigger, AccordionPanel };
