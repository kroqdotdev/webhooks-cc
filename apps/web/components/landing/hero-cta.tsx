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
      <div className="flex flex-wrap gap-4">
        <Link href="/dashboard" className="neo-btn-primary">
          Go to Dashboard
          <ArrowRight className="inline-block ml-2 h-5 w-5" />
        </Link>
        <Link href="/docs" className="neo-btn-outline">
          Read the docs
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-4">
      <Link href="/go" className="neo-btn-primary">
        Try it live
        <ArrowRight className="inline-block ml-2 h-5 w-5" />
      </Link>
      <Link href="/docs" className="neo-btn-outline">
        Read the docs
      </Link>
    </div>
  );
}
