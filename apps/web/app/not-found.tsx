import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLinkIfSignedIn } from "@/components/nav/dashboard-link-if-signed-in";
import { SiteHeader } from "@/components/nav/site-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  // Absolute: this page serves both sites, so no site name is appended.
  title: { absolute: "Page not found" },
  alternates: {},
};

export default function NotFound() {
  return (
    <div className="min-h-screen">
      <SiteHeader notFound />
      <main className="pt-24 pb-20 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-6xl font-bold mb-4">404</h1>
          <p className="text-xl text-muted-foreground mb-8">
            This page doesn&apos;t exist or has been moved.
          </p>
          <nav className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <DashboardLinkIfSignedIn />
            <Button variant="primary" render={<Link href="/" />}>
              Home
            </Button>
            <Button variant="hairline" render={<Link href="/docs" />}>
              Docs
            </Button>
            <Button variant="hairline" render={<Link href="/blog" />}>
              Blog
            </Button>
          </nav>
        </div>
      </main>
    </div>
  );
}
