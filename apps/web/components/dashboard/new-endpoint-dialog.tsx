"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useSite } from "@/components/providers/site-provider";
import { NewEndpointForm, newEndpointDescription } from "./new-endpoint-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";

/**
 * Dialog for creating a new webhook endpoint with optional mock response
 * configuration. With `open` it is controlled and has no button of its own
 * (an empty state's call to action opens it).
 */
export function NewEndpointDialog({
  open: controlledOpen,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const router = useRouter();
  const mailFirst = useSite().key === "mailhooks";
  // The form lives in the dialog's content, which unmounts on close, so it starts fresh each time.
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <button
            data-shortcut="new-endpoint"
            className="ui-btn-primary py-1.5! px-3! text-xs flex shrink-0 items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            New endpoint
          </button>
        </DialogTrigger>
      )}
      <DialogContent className="border-strong border-line shadow-raised">
        <DialogHeader>
          <DialogTitle className="font-bold caps">Create endpoint</DialogTitle>
          <DialogDescription>{newEndpointDescription(mailFirst)}</DialogDescription>
        </DialogHeader>

        <NewEndpointForm
          autoFocusName
          onCreated={(slug) => {
            setOpen(false);
            router.push(`/dashboard?endpoint=${slug}`);
          }}
          cancel={
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="ui-btn-outline"
            >
              Cancel
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
