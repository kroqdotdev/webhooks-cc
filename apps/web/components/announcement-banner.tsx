"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { X } from "lucide-react";
import { ANNOUNCEMENTS } from "@/lib/announcements";
import { isMaintenanceBannerEnabled } from "@/components/maintenance-banner";

function setAnnOffset(h: string) {
  document.documentElement.style.setProperty("--ann-h", h);
}

export function AnnouncementBanner() {
  const announcement = ANNOUNCEMENTS[0];
  const announcementId = announcement?.id;
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  const isDashboard = pathname.startsWith("/dashboard");

  useEffect(() => {
    if (!announcementId || isDashboard) {
      setAnnOffset("0px");
      return;
    }
    if (!localStorage.getItem(announcementId)) {
      setVisible(true);
      setAnnOffset("42px");
    } else {
      setAnnOffset("0px");
    }
  }, [announcementId, isDashboard]);

  if (!visible || !announcement) return null;

  function dismiss() {
    localStorage.setItem(announcement.id, "1");
    setVisible(false);
    setAnnOffset("0px");
  }

  const maintenanceActive = isMaintenanceBannerEnabled();

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className={`fixed left-0 right-0 z-[55] ${maintenanceActive ? "top-[42px]" : "top-0"}`}
      >
        <div className="bg-primary border-b-2 border-foreground text-primary-foreground px-4 py-2 text-center text-sm font-medium">
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
