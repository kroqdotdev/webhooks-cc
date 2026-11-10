"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { noteNavigationTo } from "@/lib/leave-guard";

/**
 * Next's router, with every push and replace announced first
 * (lib/leave-guard.ts), so the dashboard holds back its own address writes
 * until the navigation has landed instead of cancelling it. Everything the
 * dashboard and the header navigate with goes through this.
 */
export function useAnnouncedRouter(): ReturnType<typeof useRouter> {
  const router = useRouter();
  return useMemo(
    () => ({
      ...router,
      push: (href, options) => {
        noteNavigationTo(href);
        router.push(href, options);
      },
      replace: (href, options) => {
        noteNavigationTo(href);
        router.replace(href, options);
      },
    }),
    [router]
  );
}
