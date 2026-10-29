import type { Metadata } from "next";
import { SiteProvider } from "@/components/providers/site-provider";
import { createPageMetadata } from "@/lib/seo";
import { currentSite } from "@/lib/site-server";

export const metadata: Metadata = createPageMetadata({
  title: "Sign In",
  description:
    "Sign in to webhooks.cc to manage webhook endpoints, inspect requests, and use the CLI.",
  path: "/login",
  noIndex: true,
});

export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  return <SiteProvider site={await currentSite()}>{children}</SiteProvider>;
}
