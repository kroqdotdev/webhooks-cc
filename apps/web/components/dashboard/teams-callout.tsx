"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Megaphone, X } from "lucide-react";
import { ANNOUNCEMENTS } from "@/lib/announcements";

export function DashboardAnnouncement() {
  const announcement = ANNOUNCEMENTS.find((a) => a.dashboard);
  const announcementId = announcement?.id;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (announcementId && !localStorage.getItem(`dash-${announcementId}`)) {
      setVisible(true);
    }
  }, [announcementId]);

  if (!visible || !announcement) return null;

  const { id, text, cta } = announcement;

  function dismiss() {
    localStorage.setItem(`dash-${id}`, "1");
    setVisible(false);
  }

  return (
    <div className="bg-card border-2 border-primary px-4 py-3">
      <div className="flex items-start gap-3">
        <Megaphone className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="flex-1 space-y-1">
          <p className="text-sm font-medium">
            <span className="font-bold">New:</span> {text}
          </p>
          <p className="text-sm text-muted-foreground">
            <Link
              href={cta.href}
              className="underline font-medium text-foreground hover:opacity-80"
            >
              {cta.label} &rarr;
            </Link>
          </p>
        </div>
        <button
          onClick={dismiss}
          className="p-0.5 hover:opacity-70 transition-opacity flex-shrink-0"
          aria-label="Dismiss announcement"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
