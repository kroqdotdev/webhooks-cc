import type { Metadata } from "next";
import { SiteProvider } from "@/components/providers/site-provider";
import { createPageMetadata } from "@/lib/seo";
import { SITES } from "@/lib/site";
import { currentSite } from "@/lib/site-server";

export async function generateMetadata(): Promise<Metadata> {
  const site = SITES[await currentSite()];
  return {
    ...createPageMetadata({
      title: "Sign In",
      description: `Sign in to ${site.name} to manage your endpoints, captured requests and emails.`,
      path: "/login",
      noIndex: true,
    }),
    title: { absolute: `Sign In | ${site.name}` },
  };
}

export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  return <SiteProvider site={await currentSite()}>{children}</SiteProvider>;
}
