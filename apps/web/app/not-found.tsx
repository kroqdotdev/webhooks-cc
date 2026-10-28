import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/nav/site-header";

export const metadata: Metadata = {
  title: "Page Not Found",
  alternates: {},
};

export default function NotFound() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="pt-24 pb-20 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-6xl font-bold mb-4">404</h1>
          <p className="text-xl text-muted-foreground mb-8">
            This page doesn&apos;t exist or has been moved.
          </p>
          <nav className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/" className="ui-btn-primary">
              Home
            </Link>
            <Link href="/docs" className="ui-btn">
              Docs
            </Link>
            <Link href="/blog" className="ui-btn">
              Blog
            </Link>
          </nav>
        </div>
      </main>
    </div>
  );
}
