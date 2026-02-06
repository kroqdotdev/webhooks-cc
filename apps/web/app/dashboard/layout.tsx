import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { AppHeader } from "@/components/nav/app-header";
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
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader showEndpointSwitcher showNewEndpoint />
        {children}
      </div>
    </RequireAuth>
  );
}
