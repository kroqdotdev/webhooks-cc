export interface Announcement {
  /** Unique id — also used as the localStorage dismissal key. */
  id: string;
  /** Short text shown in the banner. */
  text: string;
  /** Call-to-action link. */
  cta: { label: string; href: string };
  /** Also show as a banner inside the dashboard. */
  dashboard: boolean;
}

/**
 * Active announcements. Remove entries when the promotion is over.
 * The first entry is used for the public-facing top banner;
 * entries with `dashboard: true` are shown in the dashboard.
 */
export const ANNOUNCEMENTS: Announcement[] = [
  {
    id: "teams-launch",
    text: "Team collaboration — invite members, share endpoints.",
    cta: { label: "Try Teams", href: "/for-teams" },
    dashboard: true,
  },
];

/**
 * The fixed banners are sized to exactly this, so everything laid out
 * beneath them can rely on the number rather than measure.
 */
export const BANNER_HEIGHT = "42px";

/**
 * Height of the fixed maintenance banner, or none. The announcement banner's
 * height travels as the `--ann-h` CSS variable instead, set client-side by
 * the AnnouncementBanner component so it responds to dismissal at once.
 */
export function getMaintenanceBannerHeight(): string {
  const maintenance =
    process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_ENABLED === "true" &&
    !!process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT;
  return maintenance ? BANNER_HEIGHT : "0px";
}

/** The site header's height, for anything sticky that has to clear it. */
export const SITE_HEADER_HEIGHT = "3.5rem";

/** Offset of the site header's top edge: the fixed banners above it, when shown. */
export function siteHeaderTop(): string {
  return `calc(${getMaintenanceBannerHeight()} + var(--ann-h, 0px))`;
}
