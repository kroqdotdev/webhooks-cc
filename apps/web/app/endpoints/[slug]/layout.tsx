import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Endpoint Details",
  description: "Private endpoint details and settings for webhooks.cc.",
  path: "/endpoints",
  noIndex: true,
});

export default function EndpointLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
