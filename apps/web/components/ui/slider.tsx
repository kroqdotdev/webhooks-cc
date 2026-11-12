"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn, type Styled } from "@/lib/utils";

/** A single-thumb slider; its aria-label names the thumb, which is the input. */
function Slider<Value extends number | readonly number[]>({
  className,
  "aria-label": ariaLabel,
  ...props
}: Styled<SliderPrimitive.Root.Props<Value>> & { "aria-label"?: string }) {
  return (
    <SliderPrimitive.Root
      className={cn("relative w-full data-disabled:opacity-50", className)}
      // The thumb stays within the track at either end.
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none select-none items-center">
        <SliderPrimitive.Track className="relative h-2 w-full grow rounded-full border border-border bg-muted">
          <SliderPrimitive.Indicator className="rounded-l-full bg-primary" />
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            className="block h-5 w-5 rounded-full border border-border bg-background shadow-surface transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 ring-offset-background"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
