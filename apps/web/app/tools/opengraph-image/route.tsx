import { ogImageResponse } from "@/lib/og/image";
import { TOOLS_PATH } from "@/lib/tools/catalog";

// The /tools index's Open Graph image, made once at build time.
export const dynamic = "force-static";

export function GET() {
  return ogImageResponse({
    kind: "Free tools",
    title: "Free webhook tools",
    subtitle: "Discord and Slack testers, signature checker",
    path: TOOLS_PATH,
  });
}
