import { MAX_LAYOUTS, type Layout } from "@webhooks-cc/sdk/email";
import { layoutTemplate } from "@/lib/layout-templates";

/**
 * An endpoint's layouts with a template's added at the end: under an id of
 * its own (shopify-orders-2 when shopify-orders is taken), so an earlier
 * copy the user edited stays as it is. Null when the template is unknown or
 * the endpoint has no room.
 */
export function withTemplateLayout(
  layouts: readonly Layout[],
  templateId: string
): { layouts: Layout[]; layout: Layout } | null {
  const template = layoutTemplate(templateId);
  if (!template || layouts.length >= MAX_LAYOUTS) return null;
  const taken = new Set(layouts.map((layout) => layout.id));
  let id = template.layout.id;
  for (let n = 2; taken.has(id); n++) id = `${template.layout.id}-${n}`;
  const layout: Layout = { ...structuredClone(template.layout), id };
  return { layouts: [...layouts, layout], layout };
}
