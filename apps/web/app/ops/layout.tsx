import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { SiteHeader } from "@/components/nav/site-header";
import { OpsShell } from "@/components/ops/ops-shell";

export const metadata: Metadata = {
  title: { absolute: "Operations" },
  robots: { index: false, follow: false },
};

/** Staff only; see components/ops/ops-shell.tsx and lib/staff.ts. */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <SiteHeader compact />
      <RequireAuth>
        <OpsShell>{children}</OpsShell>
      </RequireAuth>
    </div>
  );
}
