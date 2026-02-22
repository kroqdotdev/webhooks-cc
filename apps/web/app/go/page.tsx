import { GuestLiveDashboard } from "@/components/go/guest-live-dashboard";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Live Webhook Test",
  description:
    "Create a temporary webhook endpoint and inspect requests instantly in a live dashboard without signing in or setting up the CLI first.",
  path: "/go",
});

export default function GoPage() {
  return (
    <main>
      <GuestLiveDashboard />
    </main>
  );
}
