import { BANNER_HEIGHT } from "@/lib/announcements";

export function isMaintenanceBannerEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_ENABLED === "true" &&
    !!process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT
  );
}

export function MaintenanceBanner() {
  if (!isMaintenanceBannerEnabled()) return null;

  const content = (
    <div
      className="flex items-center justify-center bg-yellow-100 border-b-strong border-yellow-400 text-yellow-900 dark:bg-yellow-900/30 dark:border-yellow-600 dark:text-yellow-200 px-4 text-center text-sm font-medium"
      style={{ height: BANNER_HEIGHT }}
    >
      {process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT}
    </div>
  );

  return (
    <>
      <div role="status" aria-live="polite" className="fixed top-0 left-0 right-0 z-[60]">
        {content}
      </div>
      {/* Invisible duplicate to reserve matching height in the document flow */}
      <div className="invisible" aria-hidden="true">
        {content}
      </div>
    </>
  );
}
