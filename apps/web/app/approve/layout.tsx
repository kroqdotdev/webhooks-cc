import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Approve a request",
  description: "Approve or refuse what an agent or API key asked for on your webhooks.cc account.",
  path: "/approve",
  noIndex: true,
});

export default function ApproveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
