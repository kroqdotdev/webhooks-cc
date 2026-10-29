import type { Metadata } from "next";
import { SiteProvider } from "@/components/providers/site-provider";
import { createPageMetadata } from "@/lib/seo";
import { SITES } from "@/lib/site";
import { currentSite } from "@/lib/site-server";

export async function generateMetadata(): Promise<Metadata> {
  const site = SITES[await currentSite()];
  return {
    ...createPageMetadata({
      title: "Reset Password",
      description: `Choose a new password for your ${site.name} account.`,
      path: "/auth/reset-password",
      noIndex: true,
    }),
    title: { absolute: `Reset Password | ${site.name}` },
  };
}

export default async function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <SiteProvider site={await currentSite()}>{children}</SiteProvider>;
}
