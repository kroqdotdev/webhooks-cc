import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/nav/app-header";

export const metadata: Metadata = {
  title: "Page Not Found",
  alternates: {},
};

export default function NotFound() {
  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="pt-32 pb-20 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-6xl font-bold mb-4">404</h1>
          <p className="text-xl text-muted-foreground mb-8">
            This page doesn&apos;t exist or has been moved.
          </p>
          <nav className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/" className="neo-btn neo-btn-primary px-6 py-3 font-bold">
              Home
            </Link>
            <Link href="/docs" className="neo-btn px-6 py-3 font-bold">
              Docs
            </Link>
            <Link href="/blog" className="neo-btn px-6 py-3 font-bold">
              Blog
            </Link>
            <Link href="/go" className="neo-btn px-6 py-3 font-bold">
              Try it free
            </Link>
          </nav>
        </div>
      </main>
    </div>
  );
}
