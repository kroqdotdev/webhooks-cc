import type { Metadata } from "next";
import { SiteHeader } from "@/components/nav/site-header";

export const metadata: Metadata = {
  title: "Payment received",
  description: "Your payment went through. You can go back to your agent.",
  alternates: { canonical: "/checkout/complete" },
  robots: { index: false, follow: false },
};

/**
 * Where Polar sends the person after paying a checkout link an agent handed
 * them (lib/billing/checkout-links.ts). Public and static: it reads nothing
 * and says nothing about the account, since anyone can open it.
 */
export default function CheckoutCompletePage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-xl px-6 py-10 md:px-10">
        <h1 className="mb-4 text-3xl font-bold md:text-4xl">Payment received</h1>
        <p className="text-sm text-muted-foreground">
          Thanks. Your payment went through, and the purchase is applied to the account within a
          minute. You can close this page and go back to your agent: it sees the payment and carries
          on.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Your receipt comes from Polar by email. Invoices and the payment method are under Account,
          Plan when you are signed in.
        </p>
      </main>
    </div>
  );
}
