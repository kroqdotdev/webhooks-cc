"use client";

import { useConvexAuth } from "convex/react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function HeroCTA() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-4">
        <span className="neo-btn-primary opacity-50">Loading...</span>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Link href="/dashboard" className="neo-btn-primary">
            Go to Dashboard
            <ArrowRight className="inline-block ml-2 h-5 w-5" />
          </Link>
        </div>
        <p className="text-muted-foreground">
          For more info see the{" "}
          <Link
            href="#faq"
            className="text-foreground font-bold hover:text-primary transition-colors"
          >
            FAQ
          </Link>{" "}
          or{" "}
          <Link
            href="/docs"
            className="text-foreground font-bold hover:text-primary transition-colors"
          >
            read the docs
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/login" className="neo-btn-primary">
          Register now
          <ArrowRight className="inline-block ml-2 h-5 w-5" />
        </Link>
        <span className="text-muted-foreground font-semibold">or</span>
        <Link href="/go" className="neo-btn-outline">
          Try it live
        </Link>
      </div>
      <p className="text-muted-foreground">
        For more info see the{" "}
        <Link
          href="#faq"
          className="text-foreground font-bold hover:text-primary transition-colors"
        >
          FAQ
        </Link>{" "}
        or{" "}
        <Link
          href="/docs"
          className="text-foreground font-bold hover:text-primary transition-colors"
        >
          read the docs
        </Link>
        .
      </p>
    </div>
  );
}
