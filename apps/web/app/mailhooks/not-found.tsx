import type { Metadata } from "next";
import Link from "next/link";
import { DashboardLinkIfSignedIn } from "@/components/nav/dashboard-link-if-signed-in";
import { SiteHeader } from "@/components/nav/site-header";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";

export const metadata: Metadata = { title: "Page not found" };

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
            <Link href="/" className="ui-btn-primary">
              Home
            </Link>
            <Link href="/parse" className="ui-btn-outline">
              Layout gallery
            </Link>
            <Link href="/guides" className="ui-btn-outline">
              Guides
            </Link>
          </nav>
        </div>
      </main>
      <MailhooksFooter />
    </>
  );
}
