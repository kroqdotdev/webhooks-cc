import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { SiteHeader } from "@/components/nav/site-header";
import { SiteProvider } from "@/components/providers/site-provider";
import { createPageMetadata } from "@/lib/seo";
import { SITES } from "@/lib/site";
import { currentSite } from "@/lib/site-server";

export async function generateMetadata(): Promise<Metadata> {
  const site = SITES[await currentSite()];
  return {
    ...createPageMetadata({
      title: "New endpoint",
      description: `Create an endpoint on ${site.name}.`,
      path: "/endpoints",
      noIndex: true,
    }),
    title: { absolute: `New endpoint | ${site.name}` },
  };
}

export default async function EndpointsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SiteProvider site={await currentSite()}>
      <SiteHeader />
      <RequireAuth>{children}</RequireAuth>
    </SiteProvider>
  );
}
