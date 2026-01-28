"use client";

import { useConvexAuth } from "convex/react";
import { LiveDemo } from "./live-demo";

export function AuthAwareDemo() {
  const { isAuthenticated } = useConvexAuth();

  if (isAuthenticated) {
    return null;
  }

  return (
    <section id="demo" className="py-20 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Try it now</h2>
          <p className="text-xl text-muted-foreground">
            Create a test endpoint and see webhooks appear in real-time
          </p>
        </div>
        <LiveDemo />
      </div>
    </section>
  );
}
