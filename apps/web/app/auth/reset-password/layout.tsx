import type { Metadata } from "next";
import { SiteProvider } from "@/components/providers/site-provider";
import { createPageMetadata } from "@/lib/seo";
import { currentSite } from "@/lib/site-server";

export const metadata: Metadata = createPageMetadata({
  title: "Reset Password",
  description: "Choose a new password for your webhooks.cc account.",
  path: "/auth/reset-password",
  noIndex: true,
});

export default async function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <SiteProvider site={await currentSite()}>{children}</SiteProvider>;
}
