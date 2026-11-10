import { LAYOUT_TEMPLATES, layoutTemplate, type LayoutTemplate } from "@/lib/layout-templates";

/**
 * The layout templates' sender groups, by template id: the Add layout menu
 * and the public gallery list them under these headings. A template not
 * listed here still shows, under "Other senders".
 */
export const TEMPLATE_GROUPS: { name: string; ids: string[] }[] = [
  {
    name: "Commerce",
    ids: [
      "shopify-orders",
      "woocommerce-orders",
      "etsy-sales",
      "amazon-seller-orders",
      "ebay-sales",
    ],
  },
  { name: "Payments", ids: ["stripe-receipts", "paypal-payments"] },
  {
    name: "Bookings and travel",
    ids: ["booking-com-reservations", "airbnb-reservations", "calendly-bookings"],
  },
  { name: "Forms, reports and files", ids: ["form-responses", "csv-reports", "pdf-invoices"] },
];

/** Every template under its group's name, in the groups' order; empty groups are left out. */
export function groupedTemplates(): { name: string; templates: LayoutTemplate[] }[] {
  const listed = new Set(TEMPLATE_GROUPS.flatMap((group) => group.ids));
  const groups = TEMPLATE_GROUPS.map((group) => ({
    name: group.name,
    templates: group.ids
      .map((id) => layoutTemplate(id))
      .filter((template): template is LayoutTemplate => template !== null),
  }));
  const other = LAYOUT_TEMPLATES.filter((template) => !listed.has(template.id));
  if (other.length > 0) groups.push({ name: "Other senders", templates: other });
  return groups.filter((group) => group.templates.length > 0);
}
