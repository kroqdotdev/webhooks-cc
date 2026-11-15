import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Checkout",
  description: "Pay for a plan or add-on an agent or tool prepared for your webhooks.cc account.",
  path: "/checkout",
  noIndex: true,
});

export default function CheckoutLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
