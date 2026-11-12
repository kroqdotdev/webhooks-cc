import { ogImageResponse } from "@/lib/og/image";

// The /share page's Open Graph image, made once at build time.
export const dynamic = "force-static";

export function GET() {
  return ogImageResponse({
    kind: "Share localhost",
    title: "Share localhost at a public URL",
    subtitle: "One command, an HTTPS link, live reload included",
    path: "/share",
  });
}
