import { ogImageResponse } from "@/lib/og/image";

// The /compare hub's Open Graph image, made once at build time.
export const dynamic = "force-static";

export function GET() {
  return ogImageResponse({
    kind: "Compare",
    title: "Webhook testing tools compared",
    subtitle: "One feature checklist, tool by tool",
    path: "/compare",
  });
}
