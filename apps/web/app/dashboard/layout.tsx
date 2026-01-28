import { RequireAuth } from "@/components/auth/require-auth";
import { AppHeader } from "@/components/nav/app-header";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppHeader showEndpointSwitcher showNewEndpoint />
        {children}
      </div>
    </RequireAuth>
  );
}
