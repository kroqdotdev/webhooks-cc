import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLinkIfSignedIn } from "@/components/nav/dashboard-link-if-signed-in";
import { SiteHeader } from "@/components/nav/site-header";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: { absolute: "Page not found | mailhooks.cc" } };

export default function MailhooksNotFound() {
  return (
    <>
      <SiteHeader notFound />
      <main className="pt-24 pb-20 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-6xl font-bold mb-4">404</h1>
          <p className="text-xl text-muted-foreground mb-8">
            This page doesn&apos;t exist on mailhooks.cc.
          </p>
          <nav
            aria-label="Places to go"
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <DashboardLinkIfSignedIn />
            <Button variant="primary" render={<Link href="/" />}>
              Home
            </Button>
            <Button variant="surface" render={<Link href="/parse" />}>
              Layout gallery
            </Button>
            <Button variant="surface" render={<Link href="/guides" />}>
              Guides
            </Button>
          </nav>
        </div>
      </main>
      <MailhooksFooter />
    </>
  );
}
