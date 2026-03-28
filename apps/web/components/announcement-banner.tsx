"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { ANNOUNCEMENTS } from "@/lib/announcements";

export function AnnouncementBanner() {
  const announcement = ANNOUNCEMENTS[0];
  const announcementId = announcement?.id;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (announcementId && !localStorage.getItem(announcementId)) {
      setVisible(true);
    }
  }, [announcementId]);

  if (!visible || !announcement) return null;

  function dismiss() {
    localStorage.setItem(announcement.id, "1");
    setVisible(false);
  }

  return (
    <>
      <div role="status" aria-live="polite" className="fixed top-0 left-0 right-0 z-[55]">
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
      {/* Invisible spacer to reserve height in document flow */}
      <div className="invisible h-[42px]" aria-hidden="true" />
    </>
  );
}
