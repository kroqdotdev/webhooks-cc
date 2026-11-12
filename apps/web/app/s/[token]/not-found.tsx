import Link from "next/link";
import { SiteHeader } from "@/components/nav/site-header";
import { Button } from "@/components/ui/button";

// An unknown, revoked or expired share link. The page's metadata (robots
// noindex) covers this segment, and Next adds noindex to every 404 as well;
// only the root not-found may export metadata of its own.
export default function SharedRequestNotFound() {
  return (
    <div className="min-h-screen">
      <SiteHeader notFound />
      <main className="pt-24 pb-20 px-4">
        <div className="max-w-xl mx-auto text-center">
          <p className="text-xs font-bold text-muted-foreground mb-2">Shared request</p>
          <h1 className="text-3xl font-bold mb-3">This link no longer works</h1>
          <p className="text-muted-foreground mb-8">
            It expired, or the person who shared it revoked it. Ask them for a new link.
          </p>
          <Button variant="primary" render={<Link href="/" />}>
            Home
          </Button>
        </div>
      </main>
    </div>
  );
}
