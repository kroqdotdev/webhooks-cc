"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  fetchDashboardEndpoints,
  subscribeDashboardEndpointsChanged,
  type DashboardEndpointsResponse,
} from "@/lib/dashboard-api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trackEndpointSwitched } from "@/lib/analytics";
import { useSite } from "@/components/providers/site-provider";
import { listedOn, type EndpointSite } from "@/lib/site";

export function EndpointSwitcher() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardEndpointsResponse | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSlug = searchParams.get("endpoint");
  const site = useSite();

  useEffect(() => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      setData(null);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const nextData = await fetchDashboardEndpoints(accessToken);
        if (!cancelled) {
          setData(nextData);
        }
      } catch (error) {
        console.error("Failed to load endpoints for switcher:", error);
        if (!cancelled) {
          setData({ owned: [], shared: [] });
        }
      }
    };

    void load();
    const unsubscribe = subscribeDashboardEndpointsChanged(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session?.access_token]);

  // The endpoints this site lists, and the one open now even if it is listed
  // on the other site (opened by its link), as the dashboard does.
  const shown = (ep: { slug: string; site?: EndpointSite }) =>
    listedOn(ep.site, site.key) || ep.slug === currentSlug;
  const owned = (data?.owned ?? []).filter(shown);
  const allEndpoints = [...owned, ...(data?.shared ?? []).filter(shown)];

  if (!data || allEndpoints.length === 0) {
    return null;
  }

  const handleChange = (slug: string) => {
    trackEndpointSwitched();
    router.push(`/dashboard?endpoint=${slug}`);
  };

  // Resolve the ?endpoint= param the same way the dashboard does (exact match,
  // else first endpoint): a stale or deleted slug otherwise leaves the Select
  // with a value no SelectItem carries, rendering an empty trigger while the
  // dashboard shows the first endpoint.
  const defaultSlug =
    allEndpoints.find((ep) => ep.slug === currentSlug)?.slug ?? allEndpoints[0]?.slug;

  // Split owned endpoints into personal (not shared) and shared-by-me
  const personalEndpoints = owned.filter((ep) => !ep.sharedWith || ep.sharedWith.length === 0);
  const sharedByMe = owned.filter((ep) => ep.sharedWith && ep.sharedWith.length > 0);
  const sharedWithMe = (data.shared ?? []).filter(shown);

  const hasSections = sharedByMe.length > 0 || sharedWithMe.length > 0;

  const labelClass = "text-xs font-bold caps text-muted-foreground";

  return (
    <Select value={defaultSlug} onValueChange={handleChange}>
      <SelectTrigger className="min-w-0 flex-1 md:w-[260px] md:flex-none">
        <SelectValue placeholder="Select endpoint" />
      </SelectTrigger>
      <SelectContent>
        {hasSections ? (
          <>
            {personalEndpoints.length > 0 && (
              <SelectGroup>
                <SelectLabel className={labelClass}>My Endpoints</SelectLabel>
                {personalEndpoints.map((ep) => (
                  <SelectItem key={ep.id} value={ep.slug}>
                    {ep.name || ep.slug}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {sharedByMe.length > 0 && (
              <>
                {personalEndpoints.length > 0 && <SelectSeparator />}
                <SelectGroup>
                  <SelectLabel className={labelClass}>Shared by me</SelectLabel>
                  {sharedByMe.map((ep) => {
                    const teamNames = ep.sharedWith!.map((s) => s.teamName).join(", ");
                    return (
                      <SelectItem key={ep.id} value={ep.slug}>
                        {ep.name || ep.slug}{" "}
                        <span className="text-muted-foreground">({teamNames})</span>
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              </>
            )}
            {sharedWithMe.length > 0 && (
              <>
                {(personalEndpoints.length > 0 || sharedByMe.length > 0) && <SelectSeparator />}
                <SelectGroup>
                  <SelectLabel className={labelClass}>Shared with me</SelectLabel>
                  {sharedWithMe.map((ep) => (
                    <SelectItem key={ep.id} value={ep.slug}>
                      {ep.name || ep.slug}{" "}
                      <span className="text-muted-foreground">
                        ({ep.fromTeam?.teamName ?? "team"})
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
          </>
        ) : (
          owned.map((ep) => (
            <SelectItem key={ep.id} value={ep.slug}>
              {ep.name || ep.slug}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
