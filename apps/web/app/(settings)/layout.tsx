import { RequireAuth } from "@/components/auth/require-auth";
import { ErrorBoundary } from "@/components/error-boundary";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SiteHeader } from "@/components/nav/site-header";
import { SiteProvider } from "@/components/providers/site-provider";
import type { Metadata } from "next";
import { SITES } from "@/lib/site";
import { currentSite } from "@/lib/site-server";
import { tunnelConfig } from "@/lib/tunnels/config";

/** Settings pages' titles name the site they are shown on. */
export async function generateMetadata(): Promise<Metadata> {
  const site = SITES[await currentSite()];
  return { title: { template: `%s | ${site.name}`, default: site.name } };
}
import { SettingsDataProvider } from "@/components/settings/settings-data";
import { SettingsShell } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";

/**
 * Account and team settings share one frame, so moving between them keeps the
 * side nav and its team list instead of remounting the page.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SiteProvider site={await currentSite()}>
      <RequireAuth>
        <div className="min-h-screen">
          <SiteHeader>
            <Button
              variant="outlined"
              className="py-1.5! px-3! text-xs flex items-center gap-1.5"
              render={<Link href="/dashboard" />}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </Button>
          </SiteHeader>
          <SettingsDataProvider>
            <SettingsShell sharing={tunnelConfig() !== null}>
              <ErrorBoundary>{children}</ErrorBoundary>
            </SettingsShell>
          </SettingsDataProvider>
        </div>
      </RequireAuth>
    </SiteProvider>
  );
}
