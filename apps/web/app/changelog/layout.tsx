import { SiteHeader } from "@/components/nav/site-header";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Changelog",
  description:
    "See what's new in webhooks.cc. Full version history of features, improvements, and fixes across the web app, CLI, SDK, and MCP server.",
  path: "/changelog",
});

export default function ChangelogLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
