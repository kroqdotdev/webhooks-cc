import { RequireAuth } from "@/components/auth/require-auth";
import { AppHeader } from "@/components/nav/app-header";
import { ErrorBoundary } from "@/components/error-boundary";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="min-h-screen">
        <AppHeader showBackToDashboard />
        <ErrorBoundary>{children}</ErrorBoundary>
      </div>
    </RequireAuth>
  );
}
