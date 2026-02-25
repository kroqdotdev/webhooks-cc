"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function HeroCTA() {
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
