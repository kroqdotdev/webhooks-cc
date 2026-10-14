import { RequireAuth } from "@/components/auth/require-auth";
import { ErrorBoundary } from "@/components/error-boundary";
import { AppHeader } from "@/components/nav/app-header";
import { SettingsDataProvider } from "@/components/settings/settings-data";
import { SettingsShell } from "@/components/settings/settings-shell";

/**
 * Account and team settings share one frame, so moving between them keeps the
 * side nav and its team list instead of remounting the page.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="min-h-screen">
        <AppHeader showBackToDashboard />
        <SettingsDataProvider>
          <SettingsShell>
            <ErrorBoundary>{children}</ErrorBoundary>
          </SettingsShell>
        </SettingsDataProvider>
      </div>
    </RequireAuth>
  );
}
