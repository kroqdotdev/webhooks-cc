export function isMaintenanceBannerEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_ENABLED === "true" &&
    !!process.env.NEXT_PUBLIC_MAINTENANCE_BANNER_TEXT
  );
}

export function MaintenanceBanner() {
  if (!isMaintenanceBannerEnabled()) return null;

  const content = (
    <div className="bg-yellow-100 border-b-2 border-yellow-400 text-yellow-900 dark:bg-yellow-900/30 dark:border-yellow-600 dark:text-yellow-200 px-4 py-2 text-center text-sm font-medium">
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
