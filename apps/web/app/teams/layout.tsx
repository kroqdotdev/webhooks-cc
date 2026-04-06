import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { AppHeader } from "@/components/nav/app-header";

export const metadata: Metadata = {
  title: "Teams",
  robots: { index: false, follow: false },
};

export default function TeamsLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="min-h-screen">
        <AppHeader showBackToDashboard />
        {children}
      </div>
    </RequireAuth>
  );
}
