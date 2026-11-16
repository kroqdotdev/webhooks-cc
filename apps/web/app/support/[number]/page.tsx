import { Suspense } from "react";
import { SkipTargetAbove } from "@/components/nav/skip-target";
import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { SiteHeader } from "@/components/nav/site-header";
import { TicketView } from "@/components/support/ticket-view";

export const metadata: Metadata = {
  title: "Ticket",
  robots: { index: false, follow: false },
};

export default async function TicketPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <SkipTargetAbove>
        <RequireAuth>
          <Suspense>
            <TicketView number={number} />
          </Suspense>
        </RequireAuth>
      </SkipTargetAbove>
    </div>
  );
}
