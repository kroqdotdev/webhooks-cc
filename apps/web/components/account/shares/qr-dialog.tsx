"use client";

import { useMemo, useState } from "react";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { qrPath } from "@/lib/qr";

/** A preview's link as a QR code, for opening it on a phone. Drawn here, never by a third party. */
export function QrDialog({ url, label }: { url: string; label: string }) {
  const [open, setOpen] = useState(false);
  const code = useMemo(() => (open ? qrPath(url) : null), [open, url]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="QR code" aria-label={`QR code for ${label}`}>
          <QrCode className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="ph-no-capture max-w-sm border border-border shadow-md">
        <DialogHeader>
          <DialogTitle>Open on a phone</DialogTitle>
          <DialogDescription>Point the phone&apos;s camera at the code.</DialogDescription>
        </DialogHeader>
        {code && (
          <div className="space-y-3">
            {/* Always dark on white: a camera needs the contrast in dark mode too. */}
            <svg
              viewBox={`0 0 ${code.size} ${code.size}`}
              role="img"
              aria-label={`QR code for ${url}`}
              className="mx-auto block w-64 max-w-full rounded-md bg-white"
              shapeRendering="crispEdges"
            >
              <path d={code.d} fill="#000" />
            </svg>
            <p className="ph-no-capture break-all text-center font-mono text-xs text-muted-foreground">
              {url}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
