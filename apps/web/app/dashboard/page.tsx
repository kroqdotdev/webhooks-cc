"use client";

import { useAnnouncedRouter } from "@/lib/announced-router";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { useSite } from "@/components/providers/site-provider";
import { setOpenEndpoint, switchSite } from "@/lib/site-switch-client";
import { SITES, endpointHomeSite, listedOn, otherSite, twoSites, type SiteKey } from "@/lib/site";
import { TemplateImportDialog } from "@/components/dashboard/template-import-dialog";
import Link from "next/link";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { cn } from "@/lib/utils";
import { EndpointBar, type EndpointTab } from "@/components/dashboard/endpoint-bar";
import {
  EndpointSettingsPanel,
  type SettingsSection,
} from "@/components/dashboard/endpoint-settings-panel";
import { isSettingsSection } from "@/components/dashboard/settings-primitives";
import {
  DirtySectionsProvider,
  DiscardChangesDialog,
  type DirtySection,
} from "@/components/dashboard/dirty-sections";
import { leavesEditedSettings } from "@/components/dashboard/dirty-reporters";
import {
  navigationPending,
  navigationSettled,
  noteNavigation,
  setLeaveGuard,
} from "@/lib/leave-guard";
import { RequestList } from "@/components/dashboard/request-list";
import {
  RequestDetail,
  RequestDetailEmpty,
  ALL_TABS,
  TABS,
  type Tab,
} from "@/components/dashboard/request-detail";
import { EmailDetail } from "@/components/dashboard/email-detail";
import { NewEndpointDialog } from "@/components/dashboard/new-endpoint-dialog";
import type { ParsedEmail } from "@webhooks-cc/sdk/email";
import { KeyboardShortcutsDialog } from "@/components/dashboard/keyboard-shortcuts-dialog";
import { RequestDiff } from "@/components/dashboard/request-diff";
import { RequestTimeline } from "@/components/dashboard/request-timeline";
import { getPinnedIds, togglePin } from "@/lib/pinned-requests";
import { getNote, setNote, getAllNotes } from "@/lib/request-notes";

import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Copy, Check, Send, Download, ChevronDown, Mail, Inbox, X } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { exportToJson, exportToCsv, downloadFile } from "@/lib/export";
import { trackRequestExported } from "@/lib/analytics";
import { subscribeToEndpointRequestChanges } from "@/lib/supabase/realtime";
import {
  fetchDashboardEndpoints,
  fetchDashboardRequests,
  fetchDashboardSearch,
  fetchDashboardSearchCount,
  subscribeDashboardEndpointsChanged,
  defaultDashboardEndpoint,
  createDashboardEndpoint,
  emitDashboardEndpointsChanged,
  updateDashboardEndpoint,
  claimGuestEndpointForUser,
  type DashboardEndpoint,
  sendTestEmail,
  fetchDashboardRequestById,
} from "@/lib/dashboard-api";
import {
  buildRetainedCountParams,
  computeShowHasMore,
  countLoadedAfter,
  incrementRetainedCount,
  matchesFilters,
  retainedCountCutoff,
} from "@/lib/dashboard-count";
import { createRefreshScheduler } from "@/lib/refresh-scheduler";
import type {
  ClickHouseRequest,
  ClickHouseSummary,
  AnyRequestSummary,
  Request,
} from "@/types/request";
import type { KindFilter } from "@/types/request";
import { toEmailSummary } from "@/lib/email-capture";

const CLICKHOUSE_PAGE_SIZE = 50;
const PANE_MIN = 240;
const PANE_DEFAULT = 384;
/** The list pane takes at most this share of the window, so the detail pane keeps room. */
const PANE_MAX_SHARE = 0.42;
/** How far an arrow key moves the divider. */
const PANE_STEP = 24;

/**
 * Keeps the dashboard's own <title> in front of the layout's "Dashboard" one.
 * React puts a newly mounted title first, and each navigation (a request
 * picked, Settings opened) mounts the layout's metadata title again, so the
 * page's title is moved back in front whenever the head changes.
 */
function keepTitleFirst(own: HTMLTitleElement | null) {
  if (!own) return;
  const head = own.ownerDocument.head;
  const moveFirst = () => {
    const first = head.querySelector("title");
    if (first && first !== own && own.parentNode === head) head.insertBefore(own, first);
  };
  moveFirst();
  const observer = new MutationObserver(moveFirst);
  observer.observe(head, { childList: true });
  return () => observer.disconnect();
}

/** The widest the list pane may be at the current window width. */
function paneMaxWidth(): number {
  return Math.round(window.innerWidth * PANE_MAX_SHARE);
}

function savePaneWidth(width: number) {
  try {
    localStorage.setItem("dashboard_pane_width", width === 0 ? "collapsed" : String(width));
  } catch {
    /* noop */
  }
}
// Realtime refreshes: a short settle window lets a request insert and its
// signature update share one fetch, and bursts refresh at most once a second.
const REALTIME_SETTLE_MS = 150;
const REALTIME_MIN_INTERVAL_MS = 1000;
// The retained count follows arrivals in the browser. The server count is
// rate-limited per user, so while events flow it is re-read at most every
// COUNT_MIN_INTERVAL_MS (with a search active, where arrivals cannot be matched
// locally, or after more than a page arrived between refreshes), and otherwise
// every COUNT_RESYNC_INTERVAL_MS to drop requests that left retention.
const COUNT_MIN_INTERVAL_MS = 10_000;
const COUNT_RESYNC_INTERVAL_MS = 60_000;
// No event says a parse finished: while an email that arrived in the last two
// minutes on an endpoint with layouts has no result, the list is read again.
const PARSE_FRESH_MS = 2 * 60 * 1000;
const PARSE_REFRESH_MS = 4000;
// How long the open request waits before it is written to the address (see writeRequestSoon).
const REQUEST_WRITE_DELAY_MS = 200;
const NO_ECHO = Symbol("no echo");
// Email that arrived before the layouts were saved was never queued for them.
// The save time is this browser's and the arrival the server's, so allow for
// a clock a little ahead.
const LAYOUTS_SAVED_SLACK_MS = 3_000;

export default function DashboardPage() {
  const { session, isLoading: authLoading } = useAuth();
  const accessToken = session?.access_token ?? null;
  // Every endpoint the account can open; the list shows those listed on this
  // site (lib/site.ts), but a link to any of them still opens it.
  const [allEndpoints, setAllEndpoints] = useState<DashboardEndpoint[] | undefined>(undefined);
  // The account's own endpoints (layouts are the owner's to change).
  const [ownedSlugs, setOwnedSlugs] = useState<Set<string>>(new Set());
  const site = useSite();
  const [recentRequests, setRecentRequests] = useState<Request[]>([]);
  // The endpoint whose first page of requests has arrived; until then an
  // empty list means "loading", not "nothing captured yet".
  const [requestsLoadedFor, setRequestsLoadedFor] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const endpointSlugParam = searchParams.get("endpoint");
  // A ready-made layout to add, from a mailhooks.cc sender page.
  const templateParam = searchParams.get("template");

  const endpoints = useMemo(
    () => allEndpoints?.filter((endpoint) => listedOn(endpoint.site, site.key)),
    [allEndpoints, site.key]
  );
  // The endpoint a slug opens: one listed here, else one opened by its slug
  // (a link, the other site's switcher) though listed elsewhere, else the default.
  const resolveEndpoint = (slug: string | null) =>
    (slug
      ? (endpoints?.find((ep) => ep.slug === slug) ?? allEndpoints?.find((ep) => ep.slug === slug))
      : undefined) ?? (endpoints ? defaultDashboardEndpoint(endpoints) : undefined);

  // Settings sections with unsaved edits (DirtySectionsProvider reports them).
  const [dirtySections, setDirtySections] = useState<DirtySection[]>([]);
  const dirtySectionsRef = useRef<DirtySection[]>([]);
  const handleDirtyChange = useCallback((list: DirtySection[]) => {
    dirtySectionsRef.current = list;
    setDirtySections(list);
  }, []);

  // The URL moved away from settings with unsaved edits (another endpoint from
  // the header's switcher, the account menu's Dashboard, Back or Forward): the
  // settings stay open, held by the edited endpoint's slug, until the person
  // keeps editing or discards.
  const settingsParam = searchParams.get("view") === "settings";
  const [heldLeave, setHeldLeave] = useState<{ slug: string; keeping: boolean } | null>(null);
  const [seenPlace, setSeenPlace] = useState({ slug: endpointSlugParam, settings: settingsParam });
  let held = heldLeave;
  if (seenPlace.slug !== endpointSlugParam || seenPlace.settings !== settingsParam) {
    setSeenPlace({ slug: endpointSlugParam, settings: settingsParam });
    const editing = resolveEndpoint(seenPlace.slug)?.slug;
    if (
      held === null &&
      dirtySections.length > 0 &&
      editing !== undefined &&
      leavesEditedSettings({
        editing,
        slug: endpointSlugParam,
        settings: settingsParam,
        defaultSlug: endpoints ? defaultDashboardEndpoint(endpoints)?.slug : undefined,
      })
    ) {
      held = { slug: editing, keeping: false };
      setHeldLeave(held);
    } else if (
      // Kept editing, but the address moved on to yet another place before it
      // came back to these settings (a quick Back): that is a new way out, so
      // the question is asked again instead of staying answered.
      held?.keeping &&
      leavesEditedSettings({
        editing: held.slug,
        slug: endpointSlugParam,
        settings: settingsParam,
        defaultSlug: endpoints ? defaultDashboardEndpoint(endpoints)?.slug : undefined,
      })
    ) {
      held = { slug: held.slug, keeping: false };
      setHeldLeave(held);
    }
  }
  if (held) {
    const heldSlug = held.slug;
    if (
      // Kept editing, or Back returned there: the URL opens the held
      // endpoint's Settings again, by its slug or as the default endpoint.
      !leavesEditedSettings({
        editing: heldSlug,
        slug: endpointSlugParam,
        settings: settingsParam,
        defaultSlug: endpoints ? defaultDashboardEndpoint(endpoints)?.slug : undefined,
      }) ||
      // The held endpoint is gone (deleted here or elsewhere): nothing to keep.
      (allEndpoints !== undefined && !allEndpoints.some((ep) => ep.slug === heldSlug))
    ) {
      held = null;
      setHeldLeave(null);
    }
  }
  const endpointSlug = held ? held.slug : endpointSlugParam;
  // While a way out is held the address already names the place the person
  // was going, not the endpoint still on screen: its ?request= is not this
  // endpoint's, so it is neither followed nor written until the hold ends.
  const holding = held !== null;
  const holdingRef = useRef(holding);
  // eslint-disable-next-line react-hooks/refs
  holdingRef.current = holding;
  // Opened by its slug (a link, the other site's switcher) though listed elsewhere.
  const linkedEndpoint = endpointSlug
    ? allEndpoints?.find((ep) => ep.slug === endpointSlug)
    : undefined;
  const currentEndpoint = resolveEndpoint(endpointSlug);
  const currentEndpointId = currentEndpoint?.id;
  const currentSlug = currentEndpoint?.slug;
  const currentSite = currentEndpoint?.site;
  // The header's site switcher keeps the open endpoint only on a site that lists it.
  useEffect(() => {
    setOpenEndpoint(currentSlug ? { slug: currentSlug, site: currentSite } : null);
    return () => setOpenEndpoint(null);
  }, [currentSlug, currentSite]);

  // The selected request is mirrored in ?request= (updateParams below):
  // a link or a reload opens it, and on phones Back closes it.
  const requestParam = searchParams.get("request");
  const [selectedId, setSelectedId] = useState<string | null>(() => requestParam);
  const requestParamRef = useRef(requestParam);
  // eslint-disable-next-line react-hooks/refs
  requestParamRef.current = requestParam;
  const [selectedClickHouseDetail, setSelectedClickHouseDetail] =
    useState<ClickHouseRequest | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(() => requestParam !== null);
  const mobileDetailRef = useRef(mobileDetail);
  // eslint-disable-next-line react-hooks/refs
  mobileDetailRef.current = mobileDetail;
  // The ?request= value this page last wrote; anything else came from Back,
  // Forward or a link.
  const writtenRequestRef = useRef(requestParam);
  // Whether opening the request added a history entry (phones), so Back to
  // list can go back instead of adding another.
  const pushedRequestRef = useRef(false);
  const prevTopSummaryId = useRef<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  // mailhooks.cc is mail-first: its list opens on emails.
  const defaultKind: KindFilter = site.key === "mailhooks" ? "email" : "all";
  const [kindFilter, setKindFilter] = useState<KindFilter>(defaultKind);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Pinning
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (currentSlug) setPinnedIds(getPinnedIds(currentSlug));
  }, [currentSlug]);
  const handleTogglePin = useCallback(
    (id: string) => {
      if (!currentSlug) return;
      setPinnedIds(togglePin(currentSlug, id));
    },
    [currentSlug]
  );

  // Notes
  const [noteIds, setNoteIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>();
    return new Set(Object.keys(getAllNotes()));
  });
  const currentNote = selectedId ? getNote(selectedId) : null;
  const handleNoteChange = useCallback(
    (note: string) => {
      if (!selectedId) return;
      setNote(selectedId, note);
      // Rebuild from canonical store in case eviction pruned entries
      setNoteIds(new Set(Object.keys(getAllNotes())));
    },
    [selectedId]
  );

  // Compare mode: freeze both sides so live changes don't mutate the diff
  const [compareId, setCompareId] = useState<string | null>(null);
  const [compareRequest, setCompareRequest] = useState<ClickHouseRequest | null>(null);
  const [compareBase, setCompareBase] = useState<ClickHouseRequest | null>(null);
  const compareIdRef = useRef(compareId);
  // eslint-disable-next-line react-hooks/refs
  compareIdRef.current = compareId;
  const recentRequestsRef = useRef(recentRequests);
  // eslint-disable-next-line react-hooks/refs
  recentRequestsRef.current = recentRequests;

  const handleCompareSelect = useCallback(
    (id: string) => {
      if (compareIdRef.current === id) {
        setCompareId(null);
        setCompareRequest(null);
        setCompareBase(null);
      } else {
        setCompareId(id);
        // Snapshot the currently selected request as the frozen left side
        const base = displayRequestRef.current;
        if (base) {
          const baseId = "_id" in base ? base._id : base.id;
          setCompareBase({
            id: baseId,
            slug: currentSlug ?? "",
            method: base.method,
            path: base.path,
            headers: base.headers,
            body: base.body,
            queryParams: base.queryParams,
            contentType: base.contentType,
            ip: base.ip,
            size: base.size,
            receivedAt: base.receivedAt,
          });
        }
        const fromRecent = recentRequestsRef.current.find((r) => r._id === id);
        if (fromRecent) {
          setCompareRequest({
            id: fromRecent._id,
            slug: currentSlug ?? "",
            method: fromRecent.method,
            path: fromRecent.path,
            headers: fromRecent.headers,
            body: fromRecent.body,
            queryParams: fromRecent.queryParams,
            contentType: fromRecent.contentType,
            ip: fromRecent.ip,
            size: fromRecent.size,
            receivedAt: fromRecent.receivedAt,
          });
        } else {
          setCompareRequest(clickHouseDetailMap.current.get(id) ?? null);
        }
      }
    },
    [currentSlug]
  );

  const exitCompare = useCallback(() => {
    setCompareId(null);
    setCompareRequest(null);
    setCompareBase(null);
  }, []);

  useEffect(() => {
    if (!compareId) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") exitCompare();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [compareId, exitCompare]);

  // View mode (list vs timeline)
  const [viewMode, setViewMode] = useState<"list" | "timeline">("list");

  // Resizable split pane
  const [paneWidth, setPaneWidth] = useState(() => {
    if (typeof window === "undefined") return PANE_DEFAULT;
    try {
      const stored = localStorage.getItem("dashboard_pane_width");
      if (stored === "collapsed") return 0;
      const val = stored ? parseInt(stored, 10) : PANE_DEFAULT;
      if (!Number.isFinite(val)) return PANE_DEFAULT;
      const maxWidth = paneMaxWidth();
      return maxWidth >= PANE_MIN ? Math.max(PANE_MIN, Math.min(maxWidth, val)) : PANE_DEFAULT;
    } catch {
      return PANE_DEFAULT;
    }
  });
  const isDragging = useRef(false);
  const paneCollapsed = paneWidth === 0;
  const paneWidthRef = useRef(paneWidth);
  // eslint-disable-next-line react-hooks/refs
  paneWidthRef.current = paneWidth;

  const handleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (paneWidthRef.current === 0 || e.button !== 0) return;
    e.preventDefault();
    isDragging.current = true;
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startWidth = paneWidthRef.current;
    // Pointer capture keeps the drag going over iframes (the email preview) and works for touch.
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* noop */
    }

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDragging.current || ev.pointerId !== pointerId) return;
      const newWidth = Math.max(
        PANE_MIN,
        Math.min(paneMaxWidth(), startWidth + (ev.clientX - startX))
      );
      setPaneWidth(newWidth);
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      isDragging.current = false;
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist after drag ends
      savePaneWidth(paneWidthRef.current);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
  }, []);

  const toggleCollapse = useCallback(() => {
    setPaneWidth((prev) => {
      const next = prev === 0 ? Math.min(PANE_DEFAULT, Math.max(PANE_MIN, paneMaxWidth())) : 0;
      savePaneWidth(next);
      return next;
    });
  }, []);

  // The divider's largest value, for assistive tech; it follows the window.
  const [paneMaxWidthNow, setPaneMaxWidthNow] = useState(() =>
    typeof window === "undefined" ? PANE_DEFAULT : paneMaxWidth()
  );
  useEffect(() => {
    const update = () => setPaneMaxWidthNow(paneMaxWidth());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // The divider as a keyboard control: arrows resize, Enter collapses or expands.
  const handleDividerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        toggleCollapse();
        return;
      }
      const step = e.key === "ArrowRight" ? PANE_STEP : e.key === "ArrowLeft" ? -PANE_STEP : 0;
      if (!step || paneWidthRef.current === 0) return;
      e.preventDefault();
      const next = Math.max(PANE_MIN, Math.min(paneMaxWidth(), paneWidthRef.current + step));
      setPaneWidth(next);
      savePaneWidth(next);
    },
    [toggleCollapse]
  );

  // Keyboard shortcuts dialog
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const desktopSearchInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);

  // Tab state from URL: read searchParams for deriving current tab,
  // but write via window.location.search to avoid subscribing to the object (rerender-defer-reads).
  const router = useAnnouncedRouter();
  const pathname = usePathname();
  const tabParam = searchParams.get("tab") as Tab | null;
  const activeTab: Tab = tabParam && ALL_TABS.includes(tabParam) ? tabParam : "body";
  // Sets (a string) or drops (null) query parameters and keeps the rest.
  // Through the History API, which Next syncs into useSearchParams: the URL
  // changes at once, so calls in quick succession (live follow, arrow keys)
  // never drop each other's changes, and none costs a server round trip.
  // A ?request= write that is waiting (writeRequestSoon below) rides along with
  // the next write of anything else, so the two cost one history call.
  // The ?request= value this page wrote last, until the router has echoed it
  // back; NO_ECHO when none is on its way.
  const writeEchoRef = useRef<string | null | typeof NO_ECHO>(NO_ECHO);
  const requestWriteRef = useRef<{
    value: string | null;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const cancelRequestWrite = useCallback(() => {
    const waiting = requestWriteRef.current;
    requestWriteRef.current = null;
    if (waiting) clearTimeout(waiting.timer);
    return waiting;
  }, []);
  // Gone from the screen (another page opened), this page writes nothing more:
  // a write that was waiting is dropped and none is armed afterwards.
  const onScreenRef = useRef(false);
  useEffect(() => {
    onScreenRef.current = true;
    return () => {
      onScreenRef.current = false;
      cancelRequestWrite();
    };
  }, [cancelRequestWrite]);
  const updateParams = useCallback(
    (given: Record<string, string | null>, mode: "replace" | "push" = "replace") => {
      const waiting = cancelRequestWrite();
      // The address is another page's by now (this one is on its way out).
      if (!onScreenRef.current || window.location.pathname !== pathname) return;
      const changes =
        waiting && !("request" in given) ? { request: waiting.value, ...given } : given;
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      const href = `${pathname}${qs ? `?${qs}` : ""}`;
      // Nothing to change: no history call at all.
      if (mode === "replace" && href === `${window.location.pathname}${window.location.search}`) {
        return;
      }
      if (mode === "push") window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
    },
    [pathname, cancelRequestWrite]
  );
  // The open request goes into the address a moment later, and only the last
  // one: holding j or k, or a burst of arrivals while following, is one write
  // instead of one per step (Safari refuses more than about 100 history calls
  // in a short while). It also waits for a navigation that is on its way,
  // because Next reads a history write as a navigation and would drop that one.
  const writeRequestSoon = useCallback(
    (value: string | null) => {
      if (holdingRef.current) return;
      writtenRequestRef.current = value;
      cancelRequestWrite();
      if (!onScreenRef.current) return;
      const flush = () => {
        if (navigationPending()) {
          requestWriteRef.current = { value, timer: setTimeout(flush, REQUEST_WRITE_DELAY_MS) };
          return;
        }
        requestWriteRef.current = null;
        // The router hands this value back through useSearchParams a moment
        // later; by then a newer request may be selected (see below).
        // Only a write that changes the address comes back.
        if (new URLSearchParams(window.location.search).get("request") !== value) {
          writeEchoRef.current = value;
        }
        updateParams({ request: value });
      };
      requestWriteRef.current = { value, timer: setTimeout(flush, REQUEST_WRITE_DELAY_MS) };
    },
    [updateParams, cancelRequestWrite]
  );
  // The address changed (a navigation landed, or this page wrote it).
  const searchKey = searchParams.toString();
  useEffect(() => {
    navigationSettled();
  }, [pathname, searchKey]);
  const setActiveTab = useCallback(
    (tab: Tab) => updateParams({ tab: tab === "body" ? null : tab }),
    [updateParams]
  );

  // Retained request history state
  const [olderRequests, setOlderRequests] = useState<ClickHouseRequest[]>([]);
  const [searchResults, setSearchResults] = useState<ClickHouseRequest[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [hasLoadedOlderPage, setHasLoadedOlderPage] = useState(false);
  const [retainedTotalCount, setRetainedTotalCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const retainedCountRequestSeq = useRef(0);
  const recentRequestsRequestSeq = useRef(0);
  const searchResultsRequestSeq = useRef(0);
  // Requests already reflected in retainedTotalCount, and when the server
  // count was last requested.
  const countedRequestsRef = useRef<Request[]>([]);
  const lastCountRequestAtRef = useRef(0);
  const refreshRetainedCountRef = useRef<() => Promise<void>>(async () => {});
  const countSchedulerRef = useRef<ReturnType<typeof createRefreshScheduler> | null>(null);

  const clickHouseDetailMap = useRef(new Map<string, ClickHouseRequest>());

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (searchInput === "") {
      setDebouncedSearch("");
      return;
    }
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(searchInput), 400);
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchInput]);

  const guestClaimAttempted = useRef(false);
  // Only the latest load counts: every star click starts a reload, and an
  // older one may answer last with the favourites from before it.
  const endpointsLoadSeq = useRef(0);

  const loadEndpoints = useCallback(async () => {
    if (!accessToken) return;
    const seq = ++endpointsLoadSeq.current;

    // On first load, try to claim a guest endpoint from /go
    if (!guestClaimAttempted.current) {
      guestClaimAttempted.current = true;
      try {
        const stored = localStorage.getItem("demo_endpoint");
        if (stored) {
          const parsed = JSON.parse(stored) as { slug?: string };
          if (parsed.slug) {
            await claimGuestEndpointForUser(accessToken, parsed.slug);
          }
          localStorage.removeItem("demo_endpoint");
        }
      } catch {
        // Claim is best-effort; proceed with normal load
      }
    }

    try {
      const response = await fetchDashboardEndpoints(accessToken);
      if (seq !== endpointsLoadSeq.current) return;
      setAllEndpoints([...response.owned, ...response.shared]);
      setOwnedSlugs(new Set(response.owned.map((endpoint) => endpoint.slug)));
    } catch (error) {
      console.error("Failed to load dashboard endpoints:", error);
      // A failed reload keeps the list it had: an empty one would show the
      // first-endpoint screen, which creates an endpoint on its own.
      if (seq === endpointsLoadSeq.current) setAllEndpoints((prev) => prev ?? []);
    }
  }, [accessToken]);

  const refreshRecentRequests = useCallback(async () => {
    if (!accessToken || !currentSlug) {
      recentRequestsRequestSeq.current++;
      setRecentRequests([]);
      return;
    }

    const requestSeq = ++recentRequestsRequestSeq.current;

    try {
      const nextRequests = await fetchDashboardRequests(accessToken, currentSlug, 50);
      if (requestSeq === recentRequestsRequestSeq.current) {
        setRecentRequests(nextRequests);
        setRequestsLoadedFor(currentSlug);
      }
    } catch (error) {
      console.error("Failed to load dashboard requests:", error);
      if (requestSeq === recentRequestsRequestSeq.current) {
        setRecentRequests([]);
        setRequestsLoadedFor(currentSlug);
      }
    }
  }, [accessToken, currentSlug]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadEndpoints();
    const unsubscribe = subscribeDashboardEndpointsChanged(() => {
      void loadEndpoints();
    });

    return unsubscribe;
  }, [accessToken, loadEndpoints]);

  useEffect(() => {
    void refreshRecentRequests();
  }, [refreshRecentRequests]);

  const selectedRecentRequest = useMemo(
    () => recentRequests.find((request) => request._id === selectedId),
    [recentRequests, selectedId]
  );

  const displayRequest = selectedRecentRequest ?? selectedClickHouseDetail ?? undefined;

  // Only an endpoint's owner can share its requests (lib/supabase/request-shares.ts).
  // Endpoints shared with you arrive with fromTeam (app/api/endpoints/route.ts).
  const ownsCurrentEndpoint = currentEndpoint !== undefined && !("fromTeam" in currentEndpoint);
  const shareProps = useMemo(
    () => (accessToken && ownsCurrentEndpoint ? { accessToken } : undefined),
    [accessToken, ownsCurrentEndpoint]
  );

  const fetchFromClickHouse = useCallback(
    async (params: Record<string, string>): Promise<{ data: ClickHouseRequest[]; ok: boolean }> => {
      if (!accessToken) return { data: [], ok: false };
      try {
        const results = await fetchDashboardSearch(accessToken, params);
        return { data: results, ok: true };
      } catch (err) {
        console.error("ClickHouse search failed:", err);
        return { data: [], ok: false };
      }
    },
    [accessToken]
  );

  const fetchCountFromClickHouse = useCallback(
    async (params: Record<string, string>): Promise<{ count: number | null; ok: boolean }> => {
      if (!accessToken) return { count: null, ok: false };
      try {
        const count = await fetchDashboardSearchCount(accessToken, params);
        return { count, ok: true };
      } catch (err) {
        console.error("ClickHouse count failed:", err);
        return { count: null, ok: false };
      }
    },
    [accessToken]
  );

  const storeClickHouseResults = useCallback((results: ClickHouseRequest[]) => {
    const map = clickHouseDetailMap.current;
    for (const r of results) {
      map.set(r.id, r);
    }
    // Evict oldest entries if map exceeds cap
    if (map.size > 500) {
      const excess = map.size - 500;
      const iter = map.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key) map.delete(key);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedClickHouseDetail(null);
      return;
    }
    if (selectedRecentRequest) {
      setSelectedClickHouseDetail(null);
      return;
    }
    setSelectedClickHouseDetail(clickHouseDetailMap.current.get(selectedId) ?? null);
  }, [selectedId, selectedRecentRequest]);

  // Older pages are fetched with the filters, so a filter change starts over.
  const prevListFilters = useRef(`${methodFilter}|${kindFilter}`);
  useEffect(() => {
    const filters = `${methodFilter}|${kindFilter}`;
    if (prevListFilters.current !== filters) {
      prevListFilters.current = filters;
      setOlderRequests([]);
      setHasMore(false);
      setHasLoadedOlderPage(false);
    }
  }, [methodFilter, kindFilter]);

  const handleKindFilterChange = useCallback((kind: KindFilter) => {
    setKindFilter(kind);
    // The method picker is hidden for email, so a method left over from HTTP
    // would hide every email with no way to clear it.
    if (kind === "email") setMethodFilter("ALL");
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (!currentEndpoint || loadingMore) return;
    setLoadingMore(true);

    const currentOldest = olderRequests.length > 0 ? olderRequests[olderRequests.length - 1] : null;
    const oldestRecentRequest =
      recentRequests.length > 0 ? recentRequests[recentRequests.length - 1] : null;

    const toTimestamp = currentOldest?.receivedAt ?? oldestRecentRequest?.receivedAt;

    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: String(CLICKHOUSE_PAGE_SIZE),
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (kindFilter !== "all") params.kind = kindFilter;
    if (toTimestamp != null) params.to = String(Math.floor(toTimestamp) - 1);

    try {
      const { data: results } = await fetchFromClickHouse(params);
      storeClickHouseResults(results);
      setOlderRequests((prev) => [...prev, ...results]);
      setHasMore(results.length >= CLICKHOUSE_PAGE_SIZE);
      setHasLoadedOlderPage(true);
    } catch (err) {
      console.error("Load more failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [
    currentEndpoint,
    loadingMore,
    olderRequests,
    recentRequests,
    methodFilter,
    kindFilter,
    fetchFromClickHouse,
    storeClickHouseResults,
  ]);

  const refreshSearchResults = useCallback(
    async ({ showLoading }: { showLoading: boolean }) => {
      if (!debouncedSearch || !currentEndpoint) {
        searchResultsRequestSeq.current++;
        setSearchResults([]);
        setSearchError(false);
        setSearchLoading(false);
        return;
      }

      const requestSeq = ++searchResultsRequestSeq.current;
      if (showLoading) {
        setSearchLoading(true);
      }
      setSearchError(false);

      const params: Record<string, string> = {
        slug: currentEndpoint.slug,
        q: debouncedSearch,
        limit: String(CLICKHOUSE_PAGE_SIZE),
        order: "desc",
      };
      if (methodFilter !== "ALL") params.method = methodFilter;
      if (kindFilter !== "all") params.kind = kindFilter;

      const { data: results, ok } = await fetchFromClickHouse(params);
      if (requestSeq !== searchResultsRequestSeq.current) return;

      if (!ok) {
        setSearchError(true);
        setSearchResults([]);
      } else {
        storeClickHouseResults(results);
        setSearchResults(results);
      }

      setSearchLoading(false);
    },
    [
      currentEndpoint,
      debouncedSearch,
      methodFilter,
      kindFilter,
      fetchFromClickHouse,
      storeClickHouseResults,
    ]
  );

  useEffect(() => {
    if (!debouncedSearch || !currentEndpoint) {
      setSearchResults([]);
      setSearchError(false);
      setSearchLoading(false);
      return;
    }

    void refreshSearchResults({ showLoading: true });
  }, [debouncedSearch, currentEndpoint, refreshSearchResults]);

  const refreshRetainedCount = useCallback(async () => {
    if (!currentSlug) return;
    const requestSeq = ++retainedCountRequestSeq.current;
    lastCountRequestAtRef.current = Date.now();
    // Without a search, arrivals are added in the browser, so bound the server
    // count at the newest counted request and add whatever was counted past it
    // by the time the response lands. Counting both would double-count.
    const counted = countedRequestsRef.current;
    const cutoff =
      !debouncedSearch && counted[0]?.endpointId === currentEndpointId
        ? retainedCountCutoff(counted)
        : undefined;
    const params = buildRetainedCountParams(
      currentSlug,
      methodFilter,
      debouncedSearch,
      cutoff,
      kindFilter
    );

    const { count, ok } = await fetchCountFromClickHouse(params);
    if (requestSeq !== retainedCountRequestSeq.current) return;
    if (ok && count != null) {
      setRetainedTotalCount(
        cutoff === undefined
          ? count
          : count + countLoadedAfter(countedRequestsRef.current, cutoff, methodFilter, kindFilter)
      );
    }
  }, [
    currentSlug,
    currentEndpointId,
    methodFilter,
    kindFilter,
    debouncedSearch,
    fetchCountFromClickHouse,
  ]);

  useEffect(() => {
    refreshRetainedCountRef.current = refreshRetainedCount;
  }, [refreshRetainedCount]);

  useEffect(() => {
    const scheduler = createRefreshScheduler({
      run: () => void refreshRetainedCountRef.current(),
      settleMs: 0,
      minIntervalMs: COUNT_MIN_INTERVAL_MS,
    });
    countSchedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      countSchedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!currentSlug || !accessToken) {
      retainedCountRequestSeq.current++;
      setRetainedTotalCount(null);
      return;
    }
    void refreshRetainedCount();
  }, [currentSlug, accessToken, methodFilter, kindFilter, debouncedSearch, refreshRetainedCount]);

  useEffect(() => {
    if (!currentSlug || !accessToken) return;

    const onFocus = () => {
      void refreshRecentRequests();
      if (debouncedSearch) {
        void refreshSearchResults({ showLoading: false });
      }
      void refreshRetainedCount();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onFocus();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    accessToken,
    currentSlug,
    debouncedSearch,
    refreshRecentRequests,
    refreshRetainedCount,
    refreshSearchResults,
  ]);

  useEffect(() => {
    if (!currentEndpointId) {
      return;
    }

    const scheduler = createRefreshScheduler({
      settleMs: REALTIME_SETTLE_MS,
      minIntervalMs: REALTIME_MIN_INTERVAL_MS,
      run: () => {
        void refreshRecentRequests();
        if (debouncedSearch) {
          void refreshSearchResults({ showLoading: false });
        }

        if (
          debouncedSearch ||
          Date.now() - lastCountRequestAtRef.current >= COUNT_RESYNC_INTERVAL_MS
        ) {
          countSchedulerRef.current?.schedule();
        }
      },
    });

    const unsubscribe = subscribeToEndpointRequestChanges(currentEndpointId, scheduler.schedule);
    return () => {
      scheduler.cancel();
      unsubscribe();
    };
  }, [currentEndpointId, debouncedSearch, refreshRecentRequests, refreshSearchResults]);

  const allItems = useMemo((): AnyRequestSummary[] => {
    if (debouncedSearch) {
      return searchResults.map((r): ClickHouseSummary => ({
        id: r.id,
        method: r.method,
        path: r.path,
        contentType: r.contentType,
        size: r.size,
        receivedAt: r.receivedAt,
        signatureVerified: r.signatureVerified,
        signatureError: r.signatureError,
        signingProvider: r.signingProvider,
        responseStatus: r.responseStatus,
        responseRule: r.responseRule,
        detectedProvider: r.detectedProvider,
        detectedEvent: r.detectedEvent,
        kind: r.kind,
        email: toEmailSummary(r.email ?? null),
      }));
    }

    const recentSummaries: AnyRequestSummary[] = recentRequests
      .filter((request) => methodFilter === "ALL" || request.method === methodFilter)
      .map((request) => ({
        _id: request._id,
        _creationTime: request._creationTime,
        method: request.method,
        path: request.path,
        contentType: request.contentType,
        size: request.size,
        receivedAt: request.receivedAt,
        signatureVerified: request.signatureVerified,
        signatureError: request.signatureError,
        signingProvider: request.signingProvider,
        responseStatus: request.responseStatus,
        responseRule: request.responseRule,
        detectedProvider: request.detectedProvider,
        detectedEvent: request.detectedEvent,
        kind: request.kind,
        email: toEmailSummary(request.email ?? null),
      }));

    const oldestRecent =
      recentRequests.length > 0 ? recentRequests[recentRequests.length - 1].receivedAt : -Infinity;
    const olderSummaries: ClickHouseSummary[] = olderRequests
      .filter((r) => r.receivedAt < oldestRecent)
      .map((r) => ({
        id: r.id,
        method: r.method,
        path: r.path,
        contentType: r.contentType,
        size: r.size,
        receivedAt: r.receivedAt,
        signatureVerified: r.signatureVerified,
        signatureError: r.signatureError,
        signingProvider: r.signingProvider,
        responseStatus: r.responseStatus,
        responseRule: r.responseRule,
        detectedProvider: r.detectedProvider,
        detectedEvent: r.detectedEvent,
        kind: r.kind,
        email: toEmailSummary(r.email ?? null),
      }));

    return [...recentSummaries, ...olderSummaries];
  }, [recentRequests, olderRequests, searchResults, debouncedSearch, methodFilter]);

  const displayedItems = useMemo(
    () =>
      kindFilter === "all"
        ? allItems
        : allItems.filter((item) => matchesFilters(item, "ALL", kindFilter)),
    [allItems, kindFilter]
  );

  // What the layouts made of each email the list shows (the summary rows carry none).
  const parsedById = useMemo(() => {
    const map = new Map<string, ParsedEmail | null>();
    for (const r of [...olderRequests, ...searchResults]) {
      if (r.kind === "email") map.set(r.id, r.parsed ?? null);
    }
    for (const r of recentRequests) {
      if (r.kind === "email") map.set(r._id, r.parsed ?? null);
    }
    return map;
  }, [recentRequests, olderRequests, searchResults]);
  // Each HTTP request's query string, for its row (the summary rows carry none),
  // so /health?check=deep reads apart from /health.
  const queryById = useMemo(() => {
    const map = new Map<string, string>();
    const add = (id: string, params: Record<string, string> | undefined) => {
      const query = params ? new URLSearchParams(params).toString() : "";
      if (query) map.set(id, `?${query}`);
    };
    for (const r of [...olderRequests, ...searchResults]) {
      if (r.kind !== "email") add(r.id, r.queryParams);
    }
    for (const r of recentRequests) {
      if (r.kind !== "email") add(r._id, r.queryParams);
    }
    return map;
  }, [recentRequests, olderRequests, searchResults]);
  const layoutsActive = (currentEndpoint?.layouts?.length ?? 0) > 0;
  // The endpoint carries no time its layouts were saved, so a save made on this
  // page (seen as its layouts changing) is timed here: email from before it was
  // never queued for a layout and is not "reading...". Without one (layouts
  // saved before the page loaded) any fresh email without a result may be.
  const layoutsJson = useMemo(
    () => JSON.stringify(currentEndpoint?.layouts ?? []),
    [currentEndpoint?.layouts]
  );
  const layoutsSeen = useRef<{ endpointId: string; layouts: string } | null>(null);
  const [layoutsSavedAt, setLayoutsSavedAt] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    if (!currentEndpointId) return;
    const seen = layoutsSeen.current;
    layoutsSeen.current = { endpointId: currentEndpointId, layouts: layoutsJson };
    if (seen?.endpointId !== currentEndpointId || seen.layouts === layoutsJson) return;
    const at = Date.now();
    setLayoutsSavedAt((current) => new Map(current).set(currentEndpointId, at));
  }, [currentEndpointId, layoutsJson]);
  const savedAt = currentEndpointId ? layoutsSavedAt.get(currentEndpointId) : undefined;
  const parseSince = savedAt === undefined ? null : savedAt - LAYOUTS_SAVED_SLACK_MS;
  const [parseClock, setParseClock] = useState(() => Date.now());
  const parsePending =
    layoutsActive &&
    recentRequests.some(
      (request) =>
        request.kind === "email" &&
        !request.parsed &&
        parseClock - request.receivedAt < PARSE_FRESH_MS &&
        (parseSince === null || request.receivedAt >= parseSince)
    );
  useEffect(() => {
    if (!parsePending) return;
    const timer = setInterval(() => {
      setParseClock(Date.now());
      void refreshRecentRequests();
    }, PARSE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [parsePending, refreshRecentRequests]);
  // An open email the layouts finished reading: the list shows it at once.
  const handleParsed = useCallback((id: string, parsed: ParsedEmail) => {
    setRecentRequests((prev) =>
      prev.some((request) => request._id === id)
        ? prev.map((request) => (request._id === id ? { ...request, parsed } : request))
        : prev
    );
    const older = clickHouseDetailMap.current.get(id);
    if (older) clickHouseDetailMap.current.set(id, { ...older, parsed });
  }, []);

  useEffect(() => {
    if (recentRequests.length === 0) {
      prevTopSummaryId.current = null;
      countedRequestsRef.current = [];
      return;
    }

    const topId = recentRequests[0]._id;
    const previousTopId = prevTopSummaryId.current;

    // First snapshot for this endpoint: the count may have been read before
    // this list, so re-read it bounded at the snapshot. Later snapshots are
    // reconciled by the arrival increments below.
    if (!previousTopId && !debouncedSearch) {
      countedRequestsRef.current = recentRequests;
      void refreshRetainedCountRef.current();
    }

    if (previousTopId && topId !== previousTopId) {
      const previousIdx = recentRequests.findIndex((request) => request._id === previousTopId);
      const arrived = previousIdx >= 0 ? previousIdx : 1;

      if (arrived > 0) {
        // More than a page arrived when the previous top is gone: take the
        // whole page for now and let the server fill in the rest.
        const matching = recentRequests
          .slice(0, previousIdx >= 0 ? previousIdx : recentRequests.length)
          .filter((request) => matchesFilters(request, methodFilter, kindFilter));
        // Follow, or announce, only arrivals the list shows; the filters hide the rest.
        if (liveMode) {
          if (matching.length > 0) {
            const followed = matching[0]._id;
            setSelectedId(followed);
            // Following means "the newest", which the address says by naming
            // no request: one write when following starts, none per arrival.
            // A phone with a request open keeps naming it, so that Back still
            // has something to take away and returns to the list.
            const phoneDetail =
              mobileDetailRef.current && window.matchMedia("(max-width: 767px)").matches;
            const next = phoneDetail ? followed : null;
            if (writtenRequestRef.current !== null && writtenRequestRef.current !== next) {
              writeRequestSoon(next);
            }
          }
        } else if (matching.length > 0) {
          setNewCount((prev) => prev + matching.length);
        }

        if (!debouncedSearch) {
          setRetainedTotalCount((prev) => incrementRetainedCount(prev, matching.length));
          if (previousIdx === -1) {
            countSchedulerRef.current?.schedule();
          }
        }
      }
    }

    prevTopSummaryId.current = topId;
    countedRequestsRef.current = recentRequests;
  }, [recentRequests, liveMode, debouncedSearch, methodFilter, kindFilter, writeRequestSoon]);

  // With nothing selected, select the newest request the list shows. Only once
  // the list is this endpoint's: right after a switch it still holds the
  // previous endpoint's requests, and one of those would be looked up here,
  // found to be another endpoint's and dropped, leaving nothing selected.
  useEffect(() => {
    if (selectedId || displayedItems.length === 0) return;
    if (!currentSlug || requestsLoadedFor !== currentSlug) return;
    const first = displayedItems[0];
    setSelectedId("_id" in first ? first._id : first.id);
  }, [displayedItems, selectedId, currentSlug, requestsLoadedFor]);

  // The request last fetched on its own because the list did not hold it.
  const lookedUpRequestRef = useRef<string | null>(null);
  // A different endpoint starts over. The first one keeps what the URL selected.
  const prevEndpointIdRef = useRef(currentEndpointId);
  useEffect(() => {
    const previous = prevEndpointIdRef.current;
    prevEndpointIdRef.current = currentEndpointId;
    if (previous === undefined || previous === currentEndpointId) return;
    // A request of the endpoint left behind is not written to this one's address,
    // and one looked up there may be looked up again here.
    cancelRequestWrite();
    lookedUpRequestRef.current = null;
    // The selection is the address's (a link, or Back to an entry that names a
    // request), else none until this endpoint's list picks its newest.
    setSelectedId(holdingRef.current ? null : requestParamRef.current);
    setSelectedClickHouseDetail(null);
    setNewCount(0);
    prevTopSummaryId.current = null;
    setMethodFilter("ALL");
    setKindFilter(defaultKind);
    setSearchInput("");
    setDebouncedSearch("");
    setOlderRequests([]);
    setSearchResults([]);
    setHasMore(false);
    setHasLoadedOlderPage(false);
    setRetainedTotalCount(null);
    setLoadingMore(false);
    setSearchLoading(false);
    setSearchError(false);
    clickHouseDetailMap.current.clear();
  }, [currentEndpointId, defaultKind, cancelRequestWrite]);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      // On a phone the detail replaces the list: opening it is a history
      // entry, so Back returns to the list rather than leaving the dashboard.
      const push = window.matchMedia("(max-width: 767px)").matches && !mobileDetailRef.current;
      setMobileDetail(true);
      if (push) {
        writtenRequestRef.current = id;
        pushedRequestRef.current = true;
        updateParams({ request: id }, "push");
      } else if (writtenRequestRef.current !== id) {
        writeRequestSoon(id);
      }
    },
    [updateParams, writeRequestSoon]
  );

  // ?request= changed by Back, Forward or a link: follow it.
  const followRequestParam = useCallback(
    (value: string | null) => {
      if (value === writtenRequestRef.current) return;
      // The address says something this page did not write (a link, the menu's
      // Dashboard, Back): a write still waiting would put the old request back.
      cancelRequestWrite();
      writtenRequestRef.current = value;
      pushedRequestRef.current = false;
      if (value === null) {
        setMobileDetail(false);
        return;
      }
      setSelectedId(value);
      setMobileDetail(true);
    },
    [cancelRequestWrite]
  );
  const seenRequestParamRef = useRef(requestParam);
  useEffect(() => {
    if (holding) return;
    // The router echoing this page's own write is not a change from outside,
    // even when a newer request was selected since (stepping with j and k
    // faster than the echo): following it would undo the newer selection.
    if (seenRequestParamRef.current !== requestParam) {
      seenRequestParamRef.current = requestParam;
      const echo = writeEchoRef.current;
      writeEchoRef.current = NO_ECHO;
      if (requestParam === echo) return;
    }
    followRequestParam(requestParam);
  }, [requestParam, holding, followRequestParam]);
  // Back and Forward are also read from the address itself. Next brings a
  // pushed URL into useSearchParams in a transition; a Back that lands before
  // it commits takes the parameter from unset to unset, which the effect above
  // never sees, and the request would stay open over the list.
  useEffect(() => {
    const onPopState = () => {
      // The entry arrived at says which request is open; a write still waiting
      // is stale, and so is the echo of one made before.
      cancelRequestWrite();
      writeEchoRef.current = NO_ECHO;
      if (holdingRef.current) return;
      followRequestParam(new URLSearchParams(window.location.search).get("request"));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [followRequestParam, cancelRequestWrite]);

  // Phones: Back to list goes back when opening the request added a history entry.
  const handleBackToList = useCallback(() => {
    setMobileDetail(false);
    if (pushedRequestRef.current) {
      pushedRequestRef.current = false;
      router.back();
      return;
    }
    writtenRequestRef.current = null;
    updateParams({ request: null });
  }, [router, updateParams]);

  const handleToggleLiveMode = useCallback(() => setLiveMode((prev) => !prev), []);
  const handleToggleSort = useCallback(() => setSortNewest((prev) => !prev), []);

  const handleJumpToNew = useCallback(() => {
    // The newest request the list shows, which the filters may make older than the newest overall.
    const newest = displayedItems[0];
    if (newest) {
      const id = "_id" in newest ? newest._id : newest.id;
      setSelectedId(id);
      setNewCount(0);
      if (writtenRequestRef.current !== id) writeRequestSoon(id);
    }
  }, [displayedItems, writeRequestSoon]);

  const handleExportJson = useCallback(async () => {
    if (!currentEndpoint) return;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (kindFilter !== "all") params.kind = kindFilter;
    if (debouncedSearch) params.q = debouncedSearch;

    const { data: results, ok } = await fetchFromClickHouse(params);
    if (!ok || results.length === 0) {
      alert("Export failed: could not fetch data. Please try again.");
      return;
    }
    downloadFile(exportToJson(results), "webhooks-export.json", "application/json");
    trackRequestExported("json", results.length);
    if (results.length >= 200) {
      alert("Exported first 200 requests. Use search filters to narrow the export.");
    }
  }, [currentEndpoint, methodFilter, kindFilter, debouncedSearch, fetchFromClickHouse]);

  const handleExportCsv = useCallback(async () => {
    if (!currentEndpoint) return;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (kindFilter !== "all") params.kind = kindFilter;
    if (debouncedSearch) params.q = debouncedSearch;

    const { data: results, ok } = await fetchFromClickHouse(params);
    if (!ok || results.length === 0) {
      alert("Export failed: could not fetch data. Please try again.");
      return;
    }
    downloadFile(exportToCsv(results), "webhooks-export.csv", "text/csv");
    trackRequestExported("csv", results.length);
    if (results.length >= 200) {
      alert("Exported first 200 requests. Use search filters to narrow the export.");
    }
  }, [currentEndpoint, methodFilter, kindFilter, debouncedSearch, fetchFromClickHouse]);

  // Keyboard shortcuts: use refs for frequently-changing values so the
  // listener doesn't re-register on every state change (rerender-dependencies).
  const displayedItemsRef = useRef(displayedItems);
  // eslint-disable-next-line react-hooks/refs
  displayedItemsRef.current = displayedItems;
  const selectedIdRef = useRef(selectedId);
  // eslint-disable-next-line react-hooks/refs
  selectedIdRef.current = selectedId;
  const displayRequestRef = useRef(displayRequest);
  // eslint-disable-next-line react-hooks/refs, react-hooks/immutability
  displayRequestRef.current = displayRequest;

  // A filter change can hide the selected request: drop it, and the effect
  // above selects the list's newest match instead.
  // Not on the first render: a request named by the URL is kept until the list loads.
  // Compared with the previous filters, not a first-run flag, so StrictMode's
  // second run of the effect does not count as a change.
  const prevSelectionFilters = useRef(`${methodFilter}|${kindFilter}`);
  useEffect(() => {
    const filters = `${methodFilter}|${kindFilter}`;
    if (prevSelectionFilters.current === filters) return;
    prevSelectionFilters.current = filters;
    const id = selectedIdRef.current;
    if (!id) return;
    const visible = displayedItemsRef.current.some(
      (item) => ("_id" in item ? item._id : item.id) === id
    );
    if (!visible) setSelectedId(null);
  }, [methodFilter, kindFilter]);

  // Ref for cURL button (avoids DOM scraping in keyboard handler)
  const curlBtnRef = useRef<HTMLButtonElement>(null);
  // Requests or Settings, from ?view=settings (a held way out stays
  // on Settings); links elsewhere open Settings at a section, kept in ?section=.
  const endpointTab: EndpointTab = held || settingsParam ? "settings" : "requests";
  const [settingsFocus, setSettingsFocus] = useState<SettingsSection | null>(() => {
    const section = searchParams.get("section");
    return isSettingsSection(section) ? section : null;
  });
  const openSettingsAt = useCallback(
    (section: SettingsSection) => {
      setSettingsFocus(section);
      updateParams({ view: "settings", section });
    },
    [updateParams]
  );
  const handleSectionJump = useCallback(
    (section: SettingsSection) => updateParams({ section }),
    [updateParams]
  );
  // Leaving Settings with unsaved edits asks first.
  const [discardPrompt, setDiscardPrompt] = useState<{ proceed: () => void } | null>(null);
  // The same prompt and hold for handlers that outlive a render (a save that
  // finishes later), so each way out is taken once.
  const discardPromptRef = useRef<{ proceed: () => void } | null>(null);
  const askToDiscard = useCallback((prompt: { proceed: () => void } | null) => {
    discardPromptRef.current = prompt;
    setDiscardPrompt(prompt);
  }, []);
  const heldLeaveRef = useRef(heldLeave);
  useEffect(() => {
    heldLeaveRef.current = heldLeave;
  }, [heldLeave]);
  const confirmDiscard = useCallback(
    (proceed: () => void) => {
      if (dirtySectionsRef.current.length > 0) askToDiscard({ proceed });
      else proceed();
    },
    [askToDiscard]
  );
  // A discard remounts the settings, so the edits are gone even when the
  // endpoint that shows next is the same one.
  const [discardCount, setDiscardCount] = useState(0);
  // Goes where the person was going: the prompt's way out, or the held one
  // (whose URL is already there). Does nothing when neither waits any more, so
  // a second call (Discard pressed while a save finishes) is harmless.
  const finishLeave = () => {
    // Nothing is unsaved any more, so the way out is not held or asked about again.
    handleDirtyChange([]);
    const prompt = discardPromptRef.current;
    if (prompt) {
      askToDiscard(null);
      prompt.proceed();
      return;
    }
    if (heldLeaveRef.current) {
      heldLeaveRef.current = null;
      setHeldLeave(null);
      setDiscardCount((count) => count + 1);
    }
  };
  const hasUnsaved = dirtySections.length > 0;
  const askingToLeave = discardPrompt !== null || (heldLeave !== null && !heldLeave.keeping);
  // The last unsaved section was saved while the question was up (its own save
  // was already running): nothing is left to ask about, so the way out is taken.
  const finishLeaveRef = useRef(finishLeave);
  useEffect(() => {
    finishLeaveRef.current = finishLeave;
  });
  useEffect(() => {
    if (askingToLeave && !hasUnsaved) finishLeaveRef.current();
  }, [askingToLeave, hasUnsaved]);
  // Leaving the dashboard for another page asks too: the header's menu goes
  // through the guard (lib/leave-guard.ts), and a link is caught on its click,
  // before Next follows it. Links within the dashboard are held above instead;
  // a full page load gets the browser's own prompt (DirtySectionsProvider).
  useEffect(() => {
    if (!hasUnsaved) return;
    setLeaveGuard((proceed) => askToDiscard({ proceed }));
    return () => setLeaveGuard(null);
  }, [hasUnsaved, askToDiscard]);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // A link to a place on this page (Skip to content) goes nowhere.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      if (hasUnsaved && url.pathname !== pathname) {
        event.preventDefault();
        askToDiscard({
          proceed: () => router.push(`${url.pathname}${url.search}${url.hash}`),
        });
        return;
      }
      // A navigation is on its way: live requests do not write the address meanwhile.
      noteNavigation();
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [hasUnsaved, pathname, router, askToDiscard]);
  const handleOpenSettings = useCallback(() => openSettingsAt("verification"), [openSettingsAt]);
  const handleOpenForwarding = useCallback(() => openSettingsAt("forwarding"), [openSettingsAt]);
  const handleOpenLayouts = useCallback(() => openSettingsAt("layouts"), [openSettingsAt]);
  // From the delivery log: the request, with its Deliveries tab open. A request
  // the list has not loaded (older than a page) is fetched on its own.
  const handleOpenRequestDeliveries = useCallback(
    async (requestId: string) => {
      const loaded =
        recentRequests.some((request) => request._id === requestId) ||
        clickHouseDetailMap.current.has(requestId);
      if (!loaded && accessToken && currentEndpoint) {
        try {
          const fetched = await fetchDashboardRequestById(accessToken, requestId);
          if (fetched) {
            clickHouseDetailMap.current.set(requestId, {
              ...fetched,
              id: fetched._id,
              slug: currentEndpoint.slug,
            });
          }
        } catch {
          // The list may still hold it; otherwise the detail stays empty.
        }
      }
      setSettingsFocus(null);
      setSelectedId(requestId);
      setMobileDetail(true);
      writtenRequestRef.current = requestId;
      updateParams({ view: null, section: null, request: requestId, tab: "deliveries" });
    },
    [recentRequests, accessToken, currentEndpoint, updateParams]
  );
  // The HTTP detail's Deliveries tab: once the endpoint has (or had) a forwarding URL.
  const deliveriesProps = useMemo(
    () =>
      currentEndpoint && (currentEndpoint.forwardEnabled || currentEndpoint.hasForwardSecret)
        ? {
            endpoint: currentEndpoint,
            canRedeliver: currentEndpoint.forwardUrl !== undefined,
            onOpenForwarding: handleOpenForwarding,
          }
        : undefined,
    [currentEndpoint, handleOpenForwarding]
  );
  const handleTabChange = useCallback(
    (tab: EndpointTab) => {
      const go = () => {
        setSettingsFocus(null);
        updateParams({ view: tab === "settings" ? "settings" : null, section: null });
      };
      if (tab === "requests") confirmDiscard(go);
      else go();
    },
    [updateParams, confirmDiscard]
  );

  // A request the URL names that the list has not loaded (older than a page)
  // is fetched on its own; one that is gone, or another endpoint's, is dropped.
  const requestsReady = !!currentSlug && requestsLoadedFor === currentSlug;
  useEffect(() => {
    if (!selectedId || !accessToken || !currentEndpointId || !requestsReady || holding) return;
    if (selectedRecentRequest || clickHouseDetailMap.current.has(selectedId)) return;
    if (lookedUpRequestRef.current === selectedId) return;
    lookedUpRequestRef.current = selectedId;
    const id = selectedId;
    fetchDashboardRequestById(accessToken, id)
      .then((fetched) => {
        if (selectedIdRef.current !== id) return;
        if (fetched && fetched.endpointId === currentEndpointId && currentSlug) {
          const detail = { ...fetched, id: fetched._id, slug: currentSlug };
          clickHouseDetailMap.current.set(id, detail);
          setSelectedClickHouseDetail(detail);
          return;
        }
        setSelectedId(null);
        // On a phone the list shows, not the detail of the newest request
        // that gets selected in its place.
        setMobileDetail(false);
        if (writtenRequestRef.current === id) writeRequestSoon(null);
      })
      .catch(() => {
        // Left selected; the detail stays empty.
      });
  }, [
    selectedId,
    selectedRecentRequest,
    accessToken,
    currentEndpointId,
    currentSlug,
    requestsReady,
    writeRequestSoon,
    holding,
  ]);

  // The account has no endpoint by the slug in the URL: say which one shows
  // instead, once a fresh load of the list agrees.
  const missingSlug =
    endpointSlugParam && allEndpoints && !allEndpoints.some((ep) => ep.slug === endpointSlugParam)
      ? endpointSlugParam
      : null;
  const [missingVerified, setMissingVerified] = useState<string | null>(null);
  const [missingDismissed, setMissingDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!missingSlug || missingVerified === missingSlug) return;
    let cancelled = false;
    void loadEndpoints().then(() => {
      if (!cancelled) setMissingVerified(missingSlug);
    });
    return () => {
      cancelled = true;
    };
  }, [missingSlug, missingVerified, loadEndpoints]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Esc always works
      if (e.key === "Escape") {
        setShortcutsOpen(false);
        if (isInput) {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      // Don't intercept when typing in inputs
      if (isInput) return;
      // Don't intercept when modifiers are held (allow browser shortcuts)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case "?":
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        case "/":
          e.preventDefault();
          (window.matchMedia("(min-width: 768px)").matches
            ? desktopSearchInputRef.current
            : mobileSearchInputRef.current
          )?.focus();
          break;
        case "j":
        case "k": {
          e.preventDefault();
          const items = displayedItemsRef.current;
          if (items.length === 0) break;
          const ids = items.map((item) => ("_id" in item ? item._id : item.id));
          const currentIndex = selectedIdRef.current ? ids.indexOf(selectedIdRef.current) : -1;
          const nextIndex =
            e.key === "j"
              ? Math.min(currentIndex + 1, ids.length - 1)
              : Math.max(currentIndex - 1, 0);
          handleSelect(ids[nextIndex]);
          break;
        }
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          e.preventDefault();
          const tabIndex = parseInt(e.key) - 1;
          setActiveTab(TABS[tabIndex]);
          break;
        }
        case "c":
          if (displayRequestRef.current) {
            e.preventDefault();
            curlBtnRef.current?.click();
          }
          break;
        case "r":
          if (displayRequestRef.current) {
            e.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-shortcut="replay"]')?.click();
          }
          break;
        case "n":
          e.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-shortcut="new-endpoint"]')?.click();
          break;
        case "l":
          e.preventDefault();
          handleToggleLiveMode();
          break;
        case "[":
          e.preventDefault();
          toggleCollapse();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSelect, handleToggleLiveMode, setActiveTab, toggleCollapse]);

  if (authLoading || endpoints === undefined || allEndpoints === undefined) {
    return <DashboardSkeleton />;
  }

  if (allEndpoints.length === 0) {
    return <AutoCreateEndpoint accessToken={accessToken} onCreated={loadEndpoints} />;
  }

  if (endpoints.length === 0 && !linkedEndpoint) {
    return (
      <NoEndpointsHere
        accessToken={accessToken}
        elsewhere={allEndpoints.length}
        ownedElsewhere={allEndpoints
          .filter((endpoint) => ownedSlugs.has(endpoint.slug))
          .map((endpoint) => endpoint.slug)}
        onCreated={loadEndpoints}
      />
    );
  }

  if (!currentEndpoint) return null;

  // Only this endpoint's list counts: right after a switch the previous
  // endpoint's requests are still in state until the new page arrives.
  const requestsLoading = requestsLoadedFor !== currentEndpoint.slug;
  // A search that hides the open request: the detail says so instead of showing it.
  const searchActive = searchInput !== "" || debouncedSearch !== "";
  const selectedHidden =
    searchActive &&
    !searchLoading &&
    selectedId !== null &&
    !displayedItems.some((item) => ("_id" in item ? item._id : item.id) === selectedId);
  const itemNoun = site.key === "mailhooks" || kindFilter === "email" ? "email" : "request";
  const hasRequests = !requestsLoading && recentRequests.length > 0;
  const loadedCount = displayedItems.length;
  const initialCanLoadMore = recentRequests.length >= CLICKHOUSE_PAGE_SIZE;
  const showHasMore = computeShowHasMore({
    searchQuery: debouncedSearch,
    hasMoreFromPagination: hasMore,
    retainedTotalCount,
    loadedCount,
    hasLoadedOlderPage,
    initialCanLoadMore,
  });

  const pageTitle = `${currentEndpoint.name || currentEndpoint.slug}${endpointTab === "settings" ? " settings" : ""} | ${site.name}`;

  return (
    <ErrorBoundary resetKey={currentEndpoint.id}>
      {/* Each endpoint and view gets its own document title (React hoists it into the head). */}
      <title ref={keepTitleFirst}>{pageTitle}</title>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {templateParam && (
        <TemplateImportDialog
          accessToken={accessToken}
          templateId={templateParam}
          endpoints={endpoints.filter(
            (endpoint) => ownedSlugs.has(endpoint.slug) && endpoint.emailAddress
          )}
          onAdded={(slug) => {
            // The endpoint it went into opens at its Layouts.
            setSettingsFocus("layouts");
            router.replace(
              `${pathname}?endpoint=${encodeURIComponent(slug)}&view=settings&section=layouts`
            );
            void loadEndpoints();
          }}
          onClose={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("template");
            const query = params.toString();
            router.replace(query ? `${pathname}?${query}` : pathname);
          }}
        />
      )}

      <DiscardChangesDialog
        sections={dirtySections}
        open={askingToLeave}
        onKeep={() => {
          if (discardPrompt) {
            askToDiscard(null);
            return;
          }
          if (!heldLeave) return;
          // Back to the endpoint being edited, on its Settings.
          setHeldLeave({ ...heldLeave, keeping: true });
          updateParams({ endpoint: heldLeave.slug, view: "settings" });
        }}
        // Discarded, or saved from "Save and leave".
        onDiscard={finishLeave}
      />

      {missingSlug && missingVerified === missingSlug && missingDismissed !== missingSlug && (
        <div className="shrink-0 border-b border-border bg-muted/60 px-4 py-2 text-sm text-muted-foreground flex items-center gap-3">
          <span className="flex-1 min-w-0">
            No endpoint named <span className="font-mono text-foreground">{missingSlug}</span> in
            this account. Showing {currentEndpoint.name || currentEndpoint.slug} instead.
          </span>
          <button
            type="button"
            onClick={() => setMissingDismissed(missingSlug)}
            aria-label="Dismiss"
            className="shrink-0 p-1 rounded-sm hover:bg-muted hover:text-foreground cursor-pointer transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {!listedOn(currentEndpoint.site, site.key) && (
        <ListedElsewhereNotice
          slug={currentEndpoint.slug}
          endpointSite={currentEndpoint.site}
          canList={ownsCurrentEndpoint && ownedSlugs.has(currentEndpoint.slug)}
          onListed={loadEndpoints}
        />
      )}

      <EndpointBar
        name={currentEndpoint.name || currentEndpoint.slug}
        slug={currentEndpoint.slug}
        emailAddress={currentEndpoint.emailAddress}
        tab={endpointTab}
        onTabChange={handleTabChange}
        hasRequests={hasRequests}
        setupState={{
          layout: (currentEndpoint.layouts?.length ?? 0) > 0,
          destination: (currentEndpoint.destinationCount ?? 0) > 0,
          mock: !!currentEndpoint.mockResponse || (currentEndpoint.responseRules?.length ?? 0) > 0,
        }}
        onOpenSettings={openSettingsAt}
        detailOpen={endpointTab === "requests" && mobileDetail && !!displayRequest}
        exportMenu={
          hasRequests ? (
            <ExportDropdown onExportJson={handleExportJson} onExportCsv={handleExportCsv} />
          ) : undefined
        }
        onExport={
          hasRequests
            ? (format) => (format === "json" ? handleExportJson() : handleExportCsv())
            : undefined
        }
      />

      {/* Settings, the split pane, or the empty state */}
      {endpointTab === "settings" ? (
        <DirtySectionsProvider
          key={`${currentEndpoint.id}:${discardCount}`}
          onChange={handleDirtyChange}
          leaving={held !== null}
        >
          <EndpointSettingsPanel
            endpoint={currentEndpoint}
            requestCount={retainedTotalCount ?? recentRequests.length}
            focusSection={settingsFocus}
            onSectionJump={handleSectionJump}
            onOpenRequestDeliveries={(requestId) =>
              confirmDiscard(() => void handleOpenRequestDeliveries(requestId))
            }
          />
        </DirtySectionsProvider>
      ) : hasRequests ? (
        <>
          {/* Desktop: side-by-side with resizable pane */}
          <div className="hidden md:flex flex-1 overflow-hidden">
            {!paneCollapsed && (
              <div
                className="shrink-0 overflow-hidden"
                style={{ width: paneWidth, maxWidth: `${PANE_MAX_SHARE * 100}%` }}
              >
                <RequestList
                  requests={displayedItems}
                  selectedId={selectedId}
                  onSelect={handleSelect}
                  liveMode={liveMode}
                  onToggleLiveMode={handleToggleLiveMode}
                  sortNewest={sortNewest}
                  onToggleSort={handleToggleSort}
                  newCount={newCount}
                  onJumpToNew={handleJumpToNew}
                  totalCount={retainedTotalCount ?? undefined}
                  methodFilter={methodFilter}
                  onMethodFilterChange={setMethodFilter}
                  searchQuery={searchInput}
                  onSearchQueryChange={setSearchInput}
                  onLoadMore={handleLoadMore}
                  hasMore={showHasMore}
                  loadingMore={loadingMore}
                  searchLoading={searchLoading}
                  searchError={searchError}
                  searchInputRef={desktopSearchInputRef}
                  pinnedIds={pinnedIds}
                  onTogglePin={handleTogglePin}
                  noteIds={noteIds}
                  compareId={compareId}
                  onCompareSelect={handleCompareSelect}
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  kindFilter={kindFilter}
                  onKindFilterChange={
                    currentEndpoint.emailAddress ? handleKindFilterChange : undefined
                  }
                  emailAddress={currentEndpoint.emailAddress}
                  parsedById={parsedById}
                  queryById={queryById}
                  layoutsActive={layoutsActive}
                  parseNow={parseClock}
                  parseSince={parseSince}
                  timelineSlot={
                    <RequestTimeline
                      requests={displayedItems}
                      selectedId={selectedId}
                      onSelect={handleSelect}
                    />
                  }
                />
              </div>
            )}
            {/* Drag handle / divider */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize request list"
              aria-valuemin={0}
              aria-valuemax={paneMaxWidthNow}
              aria-valuenow={Math.min(paneWidth, paneMaxWidthNow)}
              aria-valuetext={paneCollapsed ? "Collapsed" : `${paneWidth} pixels`}
              tabIndex={0}
              className="shrink-0 border-r border-border relative group cursor-col-resize select-none touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onPointerDown={handleDragStart}
              onDoubleClick={toggleCollapse}
              onKeyDown={handleDividerKeyDown}
              title={
                paneCollapsed
                  ? "Expand sidebar (Enter)"
                  : "Drag or use the arrow keys to resize, double-click or Enter to collapse"
              }
            >
              <div className="w-1.5 h-full group-hover:bg-primary/20 group-focus-visible:bg-primary/20 transition-colors" />
            </div>
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary resetKey={selectedId ?? undefined}>
                {compareId && compareBase && compareRequest ? (
                  <RequestDiff left={compareBase} right={compareRequest} onExit={exitCompare} />
                ) : selectedHidden ? (
                  <NoMatchingRequest
                    noun={itemNoun}
                    listEmpty={displayedItems.length === 0}
                    onClear={() => setSearchInput("")}
                  />
                ) : displayRequest?.kind === "email" ? (
                  <EmailDetail
                    key={selectedId ?? undefined}
                    request={displayRequest}
                    showExtracts={currentEndpoint.showEmailExtracts !== false}
                    endpoint={currentEndpoint}
                    canManageForwarding={currentEndpoint.forwardUrl !== undefined}
                    onOpenForwarding={handleOpenForwarding}
                    onOpenLayouts={
                      currentEndpoint.forwardUrl !== undefined ? handleOpenLayouts : undefined
                    }
                    note={currentNote}
                    onNoteChange={handleNoteChange}
                    initialTab={activeTab === "deliveries" ? "deliveries" : undefined}
                    onParsed={handleParsed}
                    parseSince={parseSince}
                  />
                ) : displayRequest ? (
                  <RequestDetail
                    request={displayRequest}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    curlBtnRef={curlBtnRef}
                    note={currentNote}
                    onNoteChange={handleNoteChange}
                    onOpenSettings={handleOpenSettings}
                    endpointSlug={currentEndpoint.slug}
                    deliveries={deliveriesProps}
                    schemaCandidates={recentRequests}
                    share={shareProps}
                  />
                ) : (
                  <RequestDetailEmpty slug={currentEndpoint.slug} />
                )}
              </ErrorBoundary>
            </div>
          </div>

          {/* Mobile: list or detail */}
          <div className="md:hidden flex-1 overflow-hidden flex flex-col">
            {mobileDetail && displayRequest ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <button
                  onClick={handleBackToList}
                  className="border-b border-border px-4 py-2 text-sm font-bold hover:bg-muted cursor-pointer transition-colors shrink-0"
                >
                  &larr; Back to list
                </button>
                <div className="flex-1 overflow-hidden">
                  <ErrorBoundary resetKey={selectedId ?? undefined}>
                    {displayRequest.kind === "email" ? (
                      <EmailDetail
                        key={selectedId ?? undefined}
                        request={displayRequest}
                        showExtracts={currentEndpoint.showEmailExtracts !== false}
                        endpoint={currentEndpoint}
                        canManageForwarding={currentEndpoint.forwardUrl !== undefined}
                        onOpenForwarding={handleOpenForwarding}
                        onOpenLayouts={
                          currentEndpoint.forwardUrl !== undefined ? handleOpenLayouts : undefined
                        }
                        note={currentNote}
                        onNoteChange={handleNoteChange}
                        initialTab={activeTab === "deliveries" ? "deliveries" : undefined}
                        onParsed={handleParsed}
                        parseSince={parseSince}
                      />
                    ) : (
                      <RequestDetail
                        request={displayRequest}
                        activeTab={activeTab}
                        onTabChange={setActiveTab}
                        note={currentNote}
                        onNoteChange={handleNoteChange}
                        onOpenSettings={handleOpenSettings}
                        endpointSlug={currentEndpoint.slug}
                        deliveries={deliveriesProps}
                        schemaCandidates={recentRequests}
                        share={shareProps}
                      />
                    )}
                  </ErrorBoundary>
                </div>
              </div>
            ) : (
              <RequestList
                requests={displayedItems}
                selectedId={selectedId}
                onSelect={handleSelect}
                liveMode={liveMode}
                onToggleLiveMode={handleToggleLiveMode}
                sortNewest={sortNewest}
                onToggleSort={handleToggleSort}
                newCount={newCount}
                onJumpToNew={handleJumpToNew}
                totalCount={retainedTotalCount ?? undefined}
                methodFilter={methodFilter}
                onMethodFilterChange={setMethodFilter}
                searchQuery={searchInput}
                onSearchQueryChange={setSearchInput}
                onLoadMore={handleLoadMore}
                hasMore={showHasMore}
                loadingMore={loadingMore}
                searchLoading={searchLoading}
                searchError={searchError}
                searchInputRef={mobileSearchInputRef}
                pinnedIds={pinnedIds}
                onTogglePin={handleTogglePin}
                noteIds={noteIds}
                kindFilter={kindFilter}
                onKindFilterChange={
                  currentEndpoint.emailAddress ? handleKindFilterChange : undefined
                }
                emailAddress={currentEndpoint.emailAddress}
                parsedById={parsedById}
                queryById={queryById}
                layoutsActive={layoutsActive}
                parseNow={parseClock}
                parseSince={parseSince}
              />
            )}
          </div>
        </>
      ) : requestsLoading ? (
        <RequestsSkeleton />
      ) : (
        <WaitingForRequests
          slug={currentEndpoint.slug}
          emailAddress={currentEndpoint.emailAddress ?? null}
          onOpenLayouts={() => openSettingsAt("layouts")}
        />
      )}
    </ErrorBoundary>
  );
}

function ExportDropdown({
  onExportJson,
  onExportCsv,
}: {
  onExportJson: () => void;
  onExportCsv: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Export"
            className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5 shrink-0"
          />
        }
      >
        <Download className="h-3.5 w-3.5" />
        {/* Icon only on phones, where the endpoint bar is narrow. */}
        <span className="hidden sm:inline">Export</span>
        <ChevronDown className="h-3 w-3 hidden sm:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border border-border shadow-float">
        <DropdownMenuItem onClick={onExportJson}>
          <Download className="h-3.5 w-3.5" />
          Export JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onExportCsv}>
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex-1 flex flex-col">
      {/* URL bar skeleton */}
      <div className="border-b border-border bg-card px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 flex-1 max-w-md" />
        </div>
      </div>
      <RequestsSkeleton />
    </div>
  );
}

/** The request list and detail while the first page of requests loads. */
function RequestsSkeleton() {
  return (
    <div className="flex-1 flex flex-col" data-testid="requests-loading">
      <div className="flex-1 flex">
        {/* List skeleton */}
        <div className="w-80 shrink-0 border-r border-border hidden md:block">
          <div className="border-b border-border px-3 py-2">
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="p-3 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-6 w-14" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
        {/* Detail skeleton */}
        <div className="flex-1 p-4 space-y-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-20" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}

/** The detail pane while a search hides the request that was open. */
function NoMatchingRequest({
  noun,
  listEmpty,
  onClear,
}: {
  noun: "request" | "email";
  listEmpty: boolean;
  onClear: () => void;
}) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="text-center space-y-3 max-w-sm">
        <p className="text-sm text-muted-foreground">
          {listEmpty
            ? `No ${noun} matches this search. Clear the search to see all ${noun}s.`
            : `The ${noun} that was open does not match this search. Pick one from the list, or clear the search to see all ${noun}s.`}
        </p>
        <button type="button" onClick={onClear} className="ui-btn-outline py-1.5! px-3! text-xs">
          Clear
        </button>
      </div>
    </div>
  );
}

function CopyLabel({ done }: { done: boolean }) {
  return done ? (
    <>
      <Check className="h-3 w-3" /> Copied
    </>
  ) : (
    <>
      <Copy className="h-3 w-3" /> Copy
    </>
  );
}

function WaitingForRequests({
  slug,
  emailAddress,
  onOpenLayouts,
}: {
  slug: string;
  emailAddress: string | null;
  onOpenLayouts: () => void;
}) {
  // mailhooks.cc leads with the address.
  const mailFirst = useSite().key === "mailhooks" && !!emailAddress;
  const internalTestHeader = "X-Webhooks-CC-Test-Send";
  const { session } = useAuth();
  const [copied, setCopied] = useState<"curl" | "email" | "url" | null>(null);
  const [sending, setSending] = useState<"http" | "email" | null>(null);
  const [sent, setSent] = useState<"http" | "email" | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sentTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    };
  }, []);

  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;
  const curlCmd = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"test": true}'`;

  const handleCopy = async (text: string, key: "curl" | "email" | "url") => {
    if (!(await copyToClipboard(text))) return;
    setCopied(key);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(null), 2000);
  };

  const markSent = (kind: "http" | "email") => {
    setSent(kind);
    if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    sentTimeoutRef.current = setTimeout(() => setSent(null), 3000);
  };

  const handleSendTest = async () => {
    setSending("http");
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [internalTestHeader]: "1",
        },
        body: JSON.stringify({ test: true, sentAt: new Date().toISOString() }),
      });
    } catch {
      // Might be CORS; the request still reaches the receiver.
    } finally {
      markSent("http");
      setSending(null);
    }
  };

  const handleSendEmail = async () => {
    if (!session?.access_token) return;
    setSending("email");
    setEmailError(null);
    try {
      await sendTestEmail(session.access_token, slug);
      markSent("email");
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "The test email failed.");
    } finally {
      setSending(null);
    }
  };

  const emailButton = (primary: boolean) => (
    <button
      onClick={() => void handleSendEmail()}
      disabled={sending === "email"}
      className={cn(
        primary ? "ui-btn-primary" : "ui-btn-outline",
        "self-start flex items-center gap-2 py-2! px-4! text-sm"
      )}
    >
      <Mail className="h-4 w-4" />
      {sending === "email" ? "Sending..." : sent === "email" ? "Sent" : "Send test email"}
    </button>
  );

  // mailhooks.cc: the address is the one card; HTTP and layouts are a line each below it.
  if (mailFirst && emailAddress) {
    return (
      <div className="flex-1 overflow-y-auto flex p-6 md:p-8">
        <div className="m-auto w-full max-w-2xl space-y-4">
          <div className="flex items-center justify-center gap-3 pb-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 motion-reduce:hidden" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
            </span>
            <p className="font-bold">Waiting for the first email</p>
          </div>

          <div className="ui-card ui-card-static p-5! flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between">
              <p className="font-bold">Send an email</p>
              <button
                onClick={() => void handleCopy(emailAddress, "email")}
                aria-label={copied === "email" ? "Copied the address" : "Copy the address"}
                className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
              >
                <CopyLabel done={copied === "email"} />
              </button>
            </div>
            <pre className="ui-code text-sm whitespace-pre-wrap break-words text-left shadow-none!">
              {emailAddress}
            </pre>
            <p className="text-xs text-muted-foreground">
              Forward a sender&apos;s emails here with a rule in your mailbox, or give this address
              to the sender.
            </p>
            {emailButton(true)}
            {emailError && <p className="text-xs text-destructive-ink">{emailError}</p>}

            <div className="border-t border-border/20 pt-3 space-y-2">
              <p className="text-sm font-semibold">Forward a mailbox here</p>
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div>
                  <p className="font-medium">Gmail</p>
                  <ol className="list-decimal pl-5 text-muted-foreground space-y-0.5">
                    <li>Settings › See all settings › Forwarding and POP/IMAP.</li>
                    <li>Add a forwarding address: this endpoint&apos;s address.</li>
                    <li>Gmail&apos;s confirmation code lands here; enter it there.</li>
                  </ol>
                </div>
                <div>
                  <p className="font-medium">Outlook</p>
                  <ol className="list-decimal pl-5 text-muted-foreground space-y-0.5">
                    <li>Settings › Mail › Rules › Add new rule.</li>
                    <li>Pick the sender, then Forward to this address.</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>

          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground text-center">
            <span className="min-w-0 break-all">
              Also accepts HTTP at <span className="font-mono text-foreground">{url}</span>
            </span>
            <button
              onClick={() => void handleCopy(url, "url")}
              aria-label={copied === "url" ? "Copied the HTTP URL" : "Copy the HTTP URL"}
              className="hover:text-foreground cursor-pointer inline-flex items-center gap-1 transition-colors"
            >
              <CopyLabel done={copied === "url"} />
            </button>
          </p>
          <p className="text-xs text-muted-foreground text-center">
            Then read the emails:{" "}
            <Link href="/parse" className="underline font-medium text-foreground">
              start from a ready-made layout
            </Link>
            , or{" "}
            <button
              type="button"
              onClick={onOpenLayouts}
              className="underline font-medium text-foreground cursor-pointer"
            >
              write your own
            </button>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    // m-auto centres the content while it fits and lets it scroll from the top when it
    // does not (centring with the flex container's own alignment cuts off the top).
    <div className="flex-1 overflow-y-auto flex p-6 md:p-8">
      <div className={cn("m-auto w-full space-y-6", emailAddress ? "max-w-5xl" : "max-w-lg")}>
        <div className="flex items-center justify-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 motion-reduce:hidden" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
          </span>
          <p className="font-bold">Waiting for the first request</p>
        </div>

        {/* minmax(0, 1fr): a long curl line scrolls inside its card instead of widening the page. */}
        <div
          className={cn(
            "grid gap-4 grid-cols-[minmax(0,1fr)]",
            emailAddress && "xl:grid-cols-[repeat(2,minmax(0,1fr))]"
          )}
        >
          <div className="ui-card ui-card-static p-5! flex flex-col gap-3 min-w-0">
            <div className="flex items-center justify-between">
              <p className="font-bold">Send an HTTP request</p>
              <button
                onClick={() => void handleCopy(curlCmd, "curl")}
                className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
              >
                <CopyLabel done={copied === "curl"} />
              </button>
            </div>
            {/* Focusable, so the keyboard can scroll a line that does not fit. */}
            <pre
              tabIndex={0}
              aria-label="curl command"
              className="ui-code text-sm whitespace-pre overflow-x-auto text-left shadow-none!"
            >
              {curlCmd}
            </pre>
            <button
              onClick={() => void handleSendTest()}
              disabled={sending === "http"}
              className="ui-btn-primary self-start flex items-center gap-2 py-2! px-4! text-sm"
            >
              <Send className="h-4 w-4" />
              {sending === "http" ? "Sending..." : sent === "http" ? "Sent" : "Send test request"}
            </button>
          </div>

          {emailAddress && (
            <div className="ui-card ui-card-static p-5! flex flex-col gap-3 min-w-0">
              <div className="flex items-center justify-between">
                <p className="font-bold">Send an email</p>
                <button
                  onClick={() => void handleCopy(emailAddress, "email")}
                  className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
                >
                  <CopyLabel done={copied === "email"} />
                </button>
              </div>
              <pre className="ui-code text-sm whitespace-pre-wrap break-words text-left shadow-none!">
                {emailAddress}
              </pre>
              <p className="text-xs text-muted-foreground">
                Put this address in your app&apos;s signup form, or send to it from any mail client.
              </p>
              {emailButton(false)}
              {emailError && <p className="text-xs text-destructive-ink">{emailError}</p>}
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Need signed provider templates? Use{" "}
          <span className="font-bold text-foreground">Send</span> above, or read the{" "}
          <Link
            href="/docs/endpoints/test-webhooks"
            className="underline font-bold text-foreground"
          >
            test webhook docs
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

/** What the dashboard sends when it creates an endpoint: the site it is on, when there are two. */
function siteBody(site: SiteKey): { site?: SiteKey } {
  return twoSites() ? { site } : {};
}

function AutoCreateEndpoint({
  accessToken,
  onCreated,
}: {
  accessToken: string | null;
  onCreated: () => Promise<void>;
}) {
  const site = useSite();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!accessToken || attempted.current) return;
    attempted.current = true;

    createDashboardEndpoint(accessToken, siteBody(site.key))
      .then(() => {
        // The header's endpoint list reloads too.
        emitDashboardEndpointsChanged();
        return onCreated();
      })
      .catch(() => setError("Could not create your first endpoint."));
  }, [accessToken, onCreated, site.key]);

  const handleRetry = useCallback(() => {
    attempted.current = false;
    setError(null);
  }, []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 rounded-md border border-border bg-muted flex items-center justify-center mx-auto mb-2">
            <Send className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-bold tracking-normal">No endpoints yet</h2>
          <p className="text-muted-foreground max-w-sm">{error}</p>
          <button onClick={handleRetry} className="ui-btn-primary">
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <p className="text-muted-foreground animate-pulse">Setting up your first endpoint...</p>
    </div>
  );
}

/**
 * The account has endpoints, but none listed on this site: offer one here,
 * or the other site, where they are (signed in there through the switch).
 */
function NoEndpointsHere({
  accessToken,
  elsewhere,
  ownedElsewhere,
  onCreated,
}: {
  accessToken: string | null;
  elsewhere: number;
  /** The account's own endpoints listed on the other site; only the owner can list them here. */
  ownedElsewhere: string[];
  onCreated: () => Promise<void>;
}) {
  const site = useSite();
  const other = SITES[otherSite(site.key)];
  // The New endpoint dialog, so the endpoint is named before it exists.
  const [creating, setCreating] = useState(false);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listHereToo = () => {
    if (!accessToken || ownedElsewhere.length === 0) return;
    setListing(true);
    setError(null);
    Promise.all(
      ownedElsewhere.map((slug) => updateDashboardEndpoint(accessToken, slug, { site: "both" }))
    )
      .then(() => {
        emitDashboardEndpointsChanged();
        return onCreated();
      })
      .catch(() => {
        setError("Could not show them here. Try again.");
        setListing(false);
      });
  };

  return (
    <div className="flex-1 overflow-y-auto flex p-8">
      <div className="m-auto text-center space-y-4 max-w-md">
        <div className="w-16 h-16 rounded-md border border-border bg-muted flex items-center justify-center mx-auto mb-2">
          {site.key === "mailhooks" ? (
            <Inbox className="h-8 w-8 text-muted-foreground" />
          ) : (
            <Send className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
        <h2 className="text-xl font-bold tracking-normal">
          {site.key === "mailhooks"
            ? "Start receiving email here"
            : `Start capturing on ${site.name}`}
        </h2>
        <p className="text-muted-foreground">
          {/* Addresses are random; the name is what tells endpoints apart. */}
          {site.key === "mailhooks" ? (
            <>
              Each endpoint gets its own address, like{" "}
              <span className="font-mono text-foreground whitespace-nowrap">
                k7m2q9xd4a@mailhooks.cc
              </span>
              . Name it after the sender it is for, and add a +tag to tell sources apart.
            </>
          ) : (
            <>
              Each endpoint gets its own URL, like{" "}
              <span className="font-mono text-foreground whitespace-nowrap">
                {WEBHOOK_BASE_URL.replace(/^https?:\/\//, "")}/w/k7m2q9xd4a
              </span>
              . Name it after the sender it is for, and add a path to tell sources apart.
            </>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          You also have {elsewhere === 1 ? "an endpoint" : `${elsewhere} endpoints`} on {other.name}
          .
        </p>
        {error && <p className="text-sm text-destructive-ink">{error}</p>}
        <button type="button" onClick={() => setCreating(true)} className="ui-btn-primary">
          {site.key === "mailhooks"
            ? "Create an email endpoint"
            : `Create an endpoint on ${site.name}`}
        </button>
        <NewEndpointDialog open={creating} onOpenChange={setCreating} />
        <div className="flex flex-col items-center gap-2">
          {ownedElsewhere.length > 0 && (
            <button
              type="button"
              onClick={listHereToo}
              disabled={listing || creating}
              className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              {listing
                ? "Showing them here..."
                : `Show my ${other.name} ${ownedElsewhere.length === 1 ? "endpoint" : "endpoints"} here too`}
            </button>
          )}
          <button
            type="button"
            onClick={() => void switchSite(other.key, "/dashboard", accessToken)}
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground cursor-pointer"
          >
            Open {other.name}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shown above an endpoint opened here by its link while it is listed on the other site. */
function ListedElsewhereNotice({
  slug,
  endpointSite,
  canList,
  onListed,
}: {
  slug: string;
  endpointSite: DashboardEndpoint["site"];
  /** The owner can list it on both sites from here. */
  canList: boolean;
  onListed: () => Promise<void>;
}) {
  const site = useSite();
  const { session } = useAuth();
  const home = SITES[endpointHomeSite(endpointSite, site.key)];
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listHere = () => {
    const accessToken = session?.access_token;
    if (!accessToken || listing) return;
    setListing(true);
    setError(null);
    updateDashboardEndpoint(accessToken, slug, { site: "both" })
      .then(() => {
        setOpenEndpoint({ slug, site: "both" });
        emitDashboardEndpointsChanged();
        return onListed();
      })
      .catch(() => {
        setError("It could not be listed here. Try again.");
        setListing(false);
      });
  };
  return (
    <div className="shrink-0 border-b border-border bg-muted/60 px-4 py-2 text-sm text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>Listed on {home.name}.</span>
      {canList && (
        <button
          type="button"
          onClick={listHere}
          disabled={listing}
          className="font-medium text-foreground underline underline-offset-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {listing ? "Listing..." : "List it here too"}
        </button>
      )}
      {error && <span className="text-destructive-ink">{error}</span>}
      <button
        type="button"
        onClick={() =>
          void switchSite(
            home.key,
            `/dashboard?endpoint=${encodeURIComponent(slug)}`,
            session?.access_token
          )
        }
        className="underline underline-offset-2 hover:text-foreground cursor-pointer"
      >
        Open it on {home.name}
      </button>
    </div>
  );
}
