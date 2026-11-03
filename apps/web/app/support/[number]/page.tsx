import { Suspense } from "react";
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
      <RequireAuth>
        <Suspense>
          <TicketView number={number} />
        </Suspense>
      </RequireAuth>
    </div>
  );
}
