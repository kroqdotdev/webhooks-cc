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

export function EndpointSwitcher() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardEndpointsResponse | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSlug = searchParams.get("endpoint");

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

  const allEndpoints = [...(data?.owned ?? []), ...(data?.shared ?? [])];

  if (!data || allEndpoints.length === 0) {
    return null;
  }

  const handleChange = (slug: string) => {
    router.push(`/dashboard?endpoint=${slug}`);
  };

  const defaultSlug = currentSlug || allEndpoints[0]?.slug;

  // Split owned endpoints into personal (not shared) and shared-by-me
  const personalEndpoints = data.owned.filter((ep) => !ep.sharedWith || ep.sharedWith.length === 0);
  const sharedByMe = data.owned.filter((ep) => ep.sharedWith && ep.sharedWith.length > 0);
  const sharedWithMe = data.shared ?? [];

  const hasSections = sharedByMe.length > 0 || sharedWithMe.length > 0;

  const labelClass = "text-xs font-bold uppercase tracking-wide text-muted-foreground";

  return (
    <Select value={defaultSlug} onValueChange={handleChange}>
      <SelectTrigger className="w-[260px]">
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
          data.owned.map((ep) => (
            <SelectItem key={ep.id} value={ep.slug}>
              {ep.name || ep.slug}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
