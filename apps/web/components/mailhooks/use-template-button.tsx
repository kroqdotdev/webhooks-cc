"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";

/**
 * Adds a sender's layout to one of your endpoints: the dashboard asks which
 * (lib/layout-templates.ts). Signed out, signing in comes first and returns
 * there.
 */
export function UseTemplateButton({ templateId }: { templateId: string }) {
  const isAuthenticated = useIsAuthenticated();
  const target = `/dashboard?template=${encodeURIComponent(templateId)}`;
  const href = isAuthenticated ? target : `/login?redirect=${encodeURIComponent(target)}`;
  return (
    <Link href={href} className="ui-btn-primary inline-flex items-center gap-2">
      Use this layout
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}
