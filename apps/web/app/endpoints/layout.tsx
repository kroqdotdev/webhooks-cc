import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Endpoints",
  description: "Private endpoint management area for webhooks.cc accounts.",
  path: "/endpoints",
  noIndex: true,
});

export default function EndpointsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
