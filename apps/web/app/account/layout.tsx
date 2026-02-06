import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { AppHeader } from "@/components/nav/app-header";
import { ErrorBoundary } from "@/components/error-boundary";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Account",
  description: "Private account settings, billing, and API keys for webhooks.cc.",
  path: "/account",
  noIndex: true,
});

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
