import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Endpoints",
  description: "Private endpoint management area for webhooks.cc accounts.",
  path: "/endpoints",
  noIndex: true,
});

export default function EndpointsLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
