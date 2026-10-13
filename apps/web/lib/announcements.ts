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
 * Returns the base top offset for the maintenance banner only.
 * The announcement banner offset is handled via the `--ann-h` CSS variable,
 * which is set client-side by the AnnouncementBanner component and an inline
 * script in the root layout (so it responds to dismissal in real time).
 */
export function getMaintenanceTopOffset(): string {
  const maintenance =
    process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_ENABLED === "true" &&
    !!process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT;
  return maintenance ? "3.5rem" : "1rem";
}
