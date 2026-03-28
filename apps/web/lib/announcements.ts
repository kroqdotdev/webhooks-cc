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
    cta: { label: "Try Teams", href: "/teams" },
    dashboard: true,
  },
];

/** True when there is at least one active announcement (used by the navbar for positioning). */
export const ANNOUNCEMENT_BANNER_ENABLED = ANNOUNCEMENTS.length > 0;

/**
 * Returns the appropriate Tailwind `top-*` class for fixed navigation elements,
 * accounting for active maintenance and announcement banners.
 */
export function getNavbarTopClass(): string {
  // Avoid circular dependency — inline the maintenance check.
  const maintenance =
    process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_ENABLED === "true" &&
    !!process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT;
  const announcement = ANNOUNCEMENT_BANNER_ENABLED;
  if (maintenance && announcement) return "top-24";
  if (maintenance || announcement) return "top-14";
  return "top-4";
}
