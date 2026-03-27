"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  fetchDashboardEndpoints,
  subscribeDashboardEndpointsChanged,
  type DashboardEndpointsResponse,
  type DashboardEndpointWithSharing,
} from "@/lib/dashboard-api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function endpointLabel(ep: DashboardEndpointWithSharing): string {
  const base = ep.name || ep.slug;

  if (ep.fromTeam) {
    return `${ep.slug} (${ep.fromTeam.teamName})`;
  }

  if (ep.sharedWith && ep.sharedWith.length > 0) {
    const teamNames = ep.sharedWith.map((s) => s.teamName).join(", ");
    return `${base} (Shared with ${teamNames})`;
  }

  return base;
}

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
  const hasShared = (data.shared?.length ?? 0) > 0;

  return (
    <Select value={defaultSlug} onValueChange={handleChange}>
      <SelectTrigger className="w-[260px]">
        <SelectValue placeholder="Select endpoint" />
      </SelectTrigger>
      <SelectContent>
        {hasShared ? (
          <>
            <SelectGroup>
              <SelectLabel>My Endpoints</SelectLabel>
              {data.owned.map((endpoint) => (
                <SelectItem key={endpoint.id} value={endpoint.slug}>
                  {endpointLabel(endpoint)}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Shared with me</SelectLabel>
              {data.shared.map((endpoint) => (
                <SelectItem key={endpoint.id} value={endpoint.slug}>
                  {endpointLabel(endpoint)}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        ) : (
          data.owned.map((endpoint) => (
            <SelectItem key={endpoint.id} value={endpoint.slug}>
              {endpointLabel(endpoint)}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
