"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";

/**
 * Adds a sender's layout to one of your endpoints: the dashboard asks which
 * (lib/layout-templates.ts). Signed out, signing in comes first and returns
 * there.
 */
export function UseTemplateButton({ templateId }: { templateId: string }) {
  const isAuthenticated = useIsAuthenticated();
  const target = `/dashboard?template=${encodeURIComponent(templateId)}`;
  // Gallery pages are where new visitors arrive, so signed out it opens sign-up.
  const href = isAuthenticated
    ? target
    : `/login?mode=sign-up&redirect=${encodeURIComponent(target)}`;
  return (
    <Button
      variant="primary"
      className="inline-flex items-center gap-2"
      render={<Link href={href} />}
    >
      Use this layout
      <ArrowRight className="h-4 w-4" />
    </Button>
  );
}
