import { Suspense } from "react";
import type { Metadata } from "next";
import { RequireAuth } from "@/components/auth/require-auth";
import { SiteHeader } from "@/components/nav/site-header";
import { NewTicketForm } from "@/components/support/new-ticket-form";

export const metadata: Metadata = {
  title: "New ticket",
  robots: { index: false, follow: false },
};

export default function NewTicketPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <RequireAuth>
        <Suspense>
          <NewTicketForm />
        </Suspense>
      </RequireAuth>
    </div>
  );
}
