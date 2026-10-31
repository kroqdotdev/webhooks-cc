"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { X } from "lucide-react";
import { ANNOUNCEMENTS, BANNER_HEIGHT } from "@/lib/announcements";
import { isMaintenanceBannerEnabled } from "@/components/maintenance-banner";
import { siteForHost } from "@/lib/site";

function setAnnOffset(h: string) {
  document.documentElement.style.setProperty("--ann-h", h);
}

/** Browsers that block storage throw on access; treat that as not dismissed. */
function wasDismissed(id: string): boolean {
  try {
    return Boolean(localStorage.getItem(id));
  } catch {
    return false;
  }
}

export function AnnouncementBanner() {
  const announcement = ANNOUNCEMENTS[0];
  const announcementId = announcement?.id;
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  const isDashboard = pathname.startsWith("/dashboard");

  useEffect(() => {
    // Client navigation into the dashboard keeps this component mounted, so
    // hide the banner there as well as dropping its offset.
    // The announcements are webhooks.cc's news.
    const onMailhooks = siteForHost(window.location.host) === "mailhooks";
    const show = !!announcementId && !isDashboard && !onMailhooks && !wasDismissed(announcementId);
    setVisible(show);
    setAnnOffset(show ? BANNER_HEIGHT : "0px");
  }, [announcementId, isDashboard]);

  if (!visible || !announcement) return null;

  function dismiss() {
    try {
      localStorage.setItem(announcement.id, "1");
    } catch {
      // Storage is blocked: the banner closes for this page view only.
    }
    setVisible(false);
    setAnnOffset("0px");
  }

  const maintenanceActive = isMaintenanceBannerEnabled();

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="fixed left-0 right-0 z-[55]"
        style={{ top: maintenanceActive ? BANNER_HEIGHT : 0 }}
      >
        <div
          className="flex items-center justify-center bg-primary border-b-strong border-line text-primary-foreground px-4 text-center text-sm font-medium"
          style={{ height: BANNER_HEIGHT }}
        >
          <div className="flex items-center justify-center gap-2">
            <span>
              <span className="font-bold">New:</span> {announcement.text}{" "}
              <Link href={announcement.cta.href} className="underline hover:opacity-80">
                {announcement.cta.label} &rarr;
              </Link>
            </span>
            <button
              onClick={dismiss}
              className="ml-2 p-0.5 hover:opacity-70 transition-opacity flex-shrink-0"
              aria-label="Dismiss announcement"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      {/* Spacer to push page content below the fixed banner */}
      <div style={{ height: "var(--ann-h, 0px)" }} />
    </>
  );
}
