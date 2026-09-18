import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { BackButton } from "@/components/nav/back-button";
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
      <FloatingNavbar>
        <BackButton />
        <span className="text-xs font-bold caps text-muted-foreground border-strong border-line rounded-md px-2 py-0.5">
          Changelog
        </span>
      </FloatingNavbar>
      {children}
    </>
  );
}
