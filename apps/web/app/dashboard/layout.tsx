import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { SiteHeader } from "@/components/nav/site-header";
import { siteHeaderTop } from "@/lib/announcements";
import { EndpointSwitcher } from "@/components/dashboard/endpoint-switcher";
import { NewEndpointDialog } from "@/components/dashboard/new-endpoint-dialog";
import { DashboardAnnouncement } from "@/components/dashboard/teams-callout";
import { QuotaBanner } from "@/components/dashboard/quota-banner";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Dashboard",
  description: "Private webhook dashboard for viewing endpoints and captured requests.",
  path: "/dashboard",
  noIndex: true,
});

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      {/* The fixed banners leave a spacer above this frame, so the frame gives up
          their height rather than pushing its own header under them. The header
          sticks to the frame's top edge, which is already below the banners. */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: `calc(100vh - ${siteHeaderTop()})` }}
      >
        <SiteHeader compact top="0px">
          <EndpointSwitcher />
          <NewEndpointDialog />
        </SiteHeader>
        <QuotaBanner />
        <DashboardAnnouncement />
        {children}
      </div>
    </RequireAuth>
  );
}
