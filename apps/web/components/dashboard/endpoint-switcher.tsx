"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Star } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  defaultDashboardEndpoint,
  emitDashboardEndpointsChanged,
  fetchDashboardEndpoints,
  setDashboardEndpointFavorite,
  subscribeDashboardEndpointsChanged,
  type DashboardEndpointWithSharing,
  type DashboardEndpointsResponse,
} from "@/lib/dashboard-api";
import { Button } from "@/components/ui/button";
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
import { trackEndpointFavorited, trackEndpointSwitched } from "@/lib/analytics";
import { useSite } from "@/components/providers/site-provider";
import { listedOn, type EndpointSite } from "@/lib/site";

export function EndpointSwitcher() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardEndpointsResponse | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSlug = searchParams.get("endpoint");
  const site = useSite();
  const [savingFavorite, setSavingFavorite] = useState(false);

  useEffect(() => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      setData(null);
      return;
    }

    let cancelled = false;
    // Only the latest load counts: two quick star clicks start two reloads,
    // and the first to start may answer last with the older favourite.
    let loads = 0;

    const load = async () => {
      const seq = ++loads;
      try {
        const nextData = await fetchDashboardEndpoints(accessToken);
        if (!cancelled && seq === loads) {
          setData(nextData);
        }
      } catch (error) {
        console.error("Failed to load endpoints for switcher:", error);
        // A failed reload keeps the last list, so the switcher and its star
        // stay usable; only a first load that fails leaves it empty.
        if (!cancelled && seq === loads) {
          setData((prev) => prev ?? { owned: [], shared: [] });
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
  // else the first favourite, else the first endpoint): a stale or deleted
  // slug otherwise leaves the Select with a value no SelectItem carries,
  // rendering an empty trigger while the dashboard shows another endpoint.
  const current =
    allEndpoints.find((ep) => ep.slug === currentSlug) ?? defaultDashboardEndpoint(allEndpoints);
  const defaultSlug = current?.slug;

  // Favourites come first and are not repeated in the groups below.
  const favorites = allEndpoints.filter((ep) => ep.favorite);
  const rest = (ep: DashboardEndpointWithSharing) => !ep.favorite;
  const ownedRest = owned.filter(rest);
  const personalEndpoints = ownedRest.filter((ep) => !ep.sharedWith || ep.sharedWith.length === 0);
  const sharedByMe = ownedRest.filter((ep) => ep.sharedWith && ep.sharedWith.length > 0);
  const sharedWithMe = (data.shared ?? []).filter(shown).filter(rest);

  const hasSections = favorites.length > 0 || sharedByMe.length > 0 || sharedWithMe.length > 0;

  const labelClass = "text-xs font-bold caps text-muted-foreground";

  const toggleFavorite = async () => {
    const accessToken = session?.access_token;
    if (!current || !accessToken || savingFavorite) return;
    const favorite = !current.favorite;
    const mark = (value: boolean) => (ep: DashboardEndpointWithSharing) =>
      ep.id === current.id ? { ...ep, favorite: value } : ep;
    // Keep the open endpoint open: when the URL names no endpoint, or one
    // that is gone, the dashboard shows the first favourite, which this
    // change may move.
    if (current.slug !== currentSlug) router.replace(`/dashboard?endpoint=${current.slug}`);
    setData((prev) =>
      prev
        ? { owned: prev.owned.map(mark(favorite)), shared: prev.shared.map(mark(favorite)) }
        : prev
    );
    setSavingFavorite(true);
    try {
      await setDashboardEndpointFavorite(accessToken, current.slug, favorite);
      trackEndpointFavorited(favorite);
    } catch (error) {
      console.error("Failed to change the favourite endpoint:", error);
      setData((prev) =>
        prev
          ? { owned: prev.owned.map(mark(!favorite)), shared: prev.shared.map(mark(!favorite)) }
          : prev
      );
    } finally {
      setSavingFavorite(false);
      emitDashboardEndpointsChanged();
    }
  };

  // Who shares it, beside its name: the teams of an endpoint the caller shares,
  // or the team that shares it with them.
  const teamsOf = (ep: DashboardEndpointWithSharing) =>
    ep.sharedWith && ep.sharedWith.length > 0
      ? ep.sharedWith.map((s) => s.teamName).join(", ")
      : ep.fromTeam || ep.fromTeams
        ? (ep.fromTeam?.teamName ?? "team")
        : null;
  const item = (ep: DashboardEndpointWithSharing, withTeams: boolean) => {
    const teams = withTeams ? teamsOf(ep) : null;
    return (
      <SelectItem key={ep.id} value={ep.slug}>
        {ep.name || ep.slug}
        {teams && (
          <>
            {" "}
            <span className="text-muted-foreground">({teams})</span>
          </>
        )}
      </SelectItem>
    );
  };

  const groups = [
    { label: "Favourites", endpoints: favorites },
    { label: "My Endpoints", endpoints: personalEndpoints },
    { label: "Shared by me", endpoints: sharedByMe },
    { label: "Shared with me", endpoints: sharedWithMe },
  ].filter((group) => group.endpoints.length > 0);

  const isFavorite = current?.favorite === true;
  const endpointName = current ? current.name || current.slug : "this endpoint";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 md:flex-initial">
      <Select value={defaultSlug} onValueChange={handleChange}>
        <SelectTrigger className="min-w-0 flex-1 md:w-[260px] md:flex-initial">
          <SelectValue placeholder="Select endpoint" />
        </SelectTrigger>
        <SelectContent>
          {hasSections
            ? groups.map((group, index) => (
                <SelectGroup key={group.label}>
                  {index > 0 && <SelectSeparator />}
                  <SelectLabel className={labelClass}>{group.label}</SelectLabel>
                  {group.endpoints.map((ep) => item(ep, group.label !== "My Endpoints"))}
                </SelectGroup>
              ))
            : owned.map((ep) => item(ep, false))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        disabled={!current || savingFavorite}
        onClick={() => void toggleFavorite()}
        aria-pressed={isFavorite}
        title={isFavorite ? "Remove from favourites" : "Add to favourites"}
        aria-label={
          isFavorite
            ? `Remove ${endpointName} from favourites`
            : `Add ${endpointName} to favourites`
        }
      >
        <Star className={isFavorite ? "h-4 w-4 fill-action text-action" : "h-4 w-4"} />
      </Button>
    </div>
  );
}
