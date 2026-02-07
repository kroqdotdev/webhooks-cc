import { GuestLiveDashboard } from "@/components/go/guest-live-dashboard";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Live Webhook Test",
  description:
    "Create a temporary webhook endpoint and inspect requests in the full dashboard layout without signing in.",
  path: "/go",
});

export default function GoPage() {
  return <GuestLiveDashboard />;
}
