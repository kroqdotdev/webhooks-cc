import { SiteHeader } from "@/components/nav/site-header";
import { SupportHome } from "@/components/support/support-home";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Support",
  description:
    "Get help with webhooks.cc and mailhooks.cc: open a support ticket from your account, or email support about billing, account access and bugs.",
  path: "/support",
});

export default function SupportPage() {
  return (
    <div className="min-h-screen">
      {/* The short header the account pages use, so support reads as part of the app. */}
      <SiteHeader compact />
      <SupportHome />
    </div>
  );
}
