"use client";

import { createContext, useContext } from "react";
import { SITES, type SiteInfo, type SiteKey } from "@/lib/site";

const SiteContext = createContext<SiteKey>("webhooks");

/**
 * Which site the page is shown on (lib/site.ts): mailhooks.cc's own pages set
 * it, and the app's layouts pass on what proxy.ts resolved from the Host.
 * Pages without one are webhooks.cc's.
 */
export function SiteProvider({ site, children }: { site: SiteKey; children: React.ReactNode }) {
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteInfo {
  return SITES[useContext(SiteContext)];
}
