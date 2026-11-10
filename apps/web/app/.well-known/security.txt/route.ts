import { securityTxt } from "@/lib/security-txt";

// Expires is counted from the request, so the file never goes stale.
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(securityTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
