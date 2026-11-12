import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SiteHeader } from "@/components/nav/site-header";
import { SupportHome } from "@/components/support/support-home";
import { createPageMetadata } from "@/lib/seo";
import { Button } from "@/components/ui/button";

export const metadata = createPageMetadata({
  title: "Support",
  description:
    "Get help with webhooks.cc and mailhooks.cc: open a support ticket from your account, or email support about billing, account access and bugs.",
  path: "/support",
});

export default function SupportPage() {
  return (
    <div className="min-h-screen">
      {/* The same header as the account pages (and their way back), so support reads as part of the app. */}
      <SiteHeader>
        <Button
          variant="outlined"
          className="py-1.5! px-3! text-xs flex items-center gap-1.5"
          render={<Link href="/dashboard" />}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Button>
      </SiteHeader>
      <SupportHome />
    </div>
  );
}
