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

/** Dialog for creating a new webhook endpoint with optional mock response configuration. */
export function NewEndpointDialog() {
  const router = useRouter();
  const mailFirst = useSite().key === "mailhooks";
  // The form lives in the dialog's content, which unmounts on close, so it starts fresh each time.
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          data-shortcut="new-endpoint"
          className="ui-btn-primary py-1.5! px-3! text-xs flex shrink-0 items-center gap-1.5 whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" />
          New endpoint
        </button>
      </DialogTrigger>
      <DialogContent className="border-strong border-line shadow-raised">
        <DialogHeader>
          <DialogTitle className="font-bold caps">Create endpoint</DialogTitle>
          <DialogDescription>{newEndpointDescription(mailFirst)}</DialogDescription>
        </DialogHeader>

        <NewEndpointForm
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
