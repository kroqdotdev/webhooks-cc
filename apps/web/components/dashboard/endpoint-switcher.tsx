"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Star } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  defaultDashboardEndpoint,
  setDashboardEndpointFavorite,
  type DashboardEndpointWithSharing,
} from "@/lib/dashboard-api";
import { noteNavigationTo } from "@/lib/leave-guard";
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
import { useDashboardEndpoints } from "@/components/dashboard/endpoints-provider";

/** The endpoint with a star clicked here but not yet in the list. */
function withStar(star: { id: string; favorite: boolean }) {
  return (ep: DashboardEndpointWithSharing): DashboardEndpointWithSharing =>
    ep.id === star.id ? { ...ep, favorite: star.favorite } : ep;
}

/** The switcher's outline while the list loads: the trigger and the star, empty. */
function SwitcherPlaceholder() {
  return (
    <div aria-hidden className="flex min-w-0 flex-1 items-center gap-1 md:flex-initial">
      <div className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background md:w-[260px] md:flex-initial" />
      <div className="h-10 w-10 shrink-0" />
    </div>
  );
}

export function EndpointSwitcher() {
  const { session } = useAuth();
  // The dashboard's one list (endpoints-provider.tsx).
  const { data: listed, failed, reload } = useDashboardEndpoints();
  const searchParams = useSearchParams();
  const currentSlug = searchParams.get("endpoint");
  const site = useSite();
  const [savingFavorite, setSavingFavorite] = useState(false);
  // A star clicked here shows at once, but only here: the page reads
  // favourites to pick the endpoint a bare /dashboard opens, and it should
  // change only once the server has the change. Shown until the list read
  // after the save arrives; dropped at once when the save fails.
  const [star, setStar] = useState<{ id: string; favorite: boolean } | null>(null);
  const data =
    listed && star
      ? { owned: listed.owned.map(withStar(star)), shared: listed.shared.map(withStar(star)) }
      : listed;

  // The endpoints this site lists, and the one open now even if it is listed
  // on the other site (opened by its link), as the dashboard does.
  const shown = (ep: { slug: string; site?: EndpointSite }) =>
    listedOn(ep.site, site.key) || ep.slug === currentSlug;
  const owned = (data?.owned ?? []).filter(shown);
  const allEndpoints = [...owned, ...(data?.shared ?? []).filter(shown)];

  // The list could not be read: the page says so, and there is nothing to switch.
  if (failed) return null;
  // Until there is something to switch to, a stand-in of the switcher's size,
  // so the header does not grow and push the page down when it appears: while
  // the list loads, and while a new account's first endpoint is being made.
  if (!data || data.owned.length + data.shared.length === 0) return <SwitcherPlaceholder />;
  // Endpoints, but none listed on this site.
  if (allEndpoints.length === 0) return null;

  // Through the History API, which Next syncs into useSearchParams, as the
  // dashboard writes its own address: the page is a client page with nothing
  // to fetch from the server, so router.push only cost a server round trip
  // with nothing changing on screen. The dashboard loads the endpoint's requests the moment it sees
  // the new address.
  // Announced first (lib/leave-guard.ts), so a ?request= write the page has
  // waiting for the old endpoint is held back instead of landing on the new
  // endpoint's address before the page has seen it.
  const handleChange = (slug: string) => {
    trackEndpointSwitched();
    const href = `/dashboard?endpoint=${encodeURIComponent(slug)}`;
    noteNavigationTo(href);
    window.history.pushState(null, "", href);
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

  const labelClass = "text-xs font-bold text-muted-foreground";

  const toggleFavorite = async () => {
    const accessToken = session?.access_token;
    if (!current || !accessToken || savingFavorite) return;
    const favorite = !current.favorite;
    // Keep the open endpoint open: when the URL names no endpoint, or one
    // that is gone, the dashboard shows the first favourite, which this
    // change may move.
    // Only the endpoint is added: the view, section and open request stay.
    if (current.slug !== currentSlug) {
      const params = new URLSearchParams(window.location.search);
      params.set("endpoint", current.slug);
      window.history.replaceState(null, "", `/dashboard?${params.toString()}`);
    }
    const mine = { id: current.id, favorite };
    const drop = () => setStar((shown) => (shown === mine ? null : shown));
    setStar(mine);
    setSavingFavorite(true);
    try {
      await setDashboardEndpointFavorite(accessToken, current.slug, favorite);
      trackEndpointFavorited(favorite);
    } catch (error) {
      console.error("Failed to change the favourite endpoint:", error);
      drop();
      void reload();
      return;
    } finally {
      setSavingFavorite(false);
    }
    // The list now carries the change; until it is read again the star stays
    // (a failed read leaves an older list, and the server has the change).
    if (await reload()) drop();
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
    <div className="ph-no-capture flex min-w-0 flex-1 items-center gap-1 md:flex-initial">
      <Select value={defaultSlug} onValueChange={handleChange}>
        <SelectTrigger
          aria-label="Endpoint"
          className="min-w-0 flex-1 md:w-[260px] md:flex-initial"
        >
          <SelectValue placeholder="Select endpoint" />
        </SelectTrigger>
        {/* Rendered in a portal, so it needs its own: endpoint names stay out of autocapture. */}
        <SelectContent className="ph-no-capture">
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
        <Star className={isFavorite ? "h-4 w-4 fill-primary text-primary" : "h-4 w-4"} />
      </Button>
    </div>
  );
}
