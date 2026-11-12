import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `field` adds the field class (`ui-input`) under the control's own utilities,
 * which win everywhere they overlap: it brings only the field's 150ms border
 * and ring transition, and the box keeps the control look.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea"> & { field?: boolean }
>(({ className, field = false, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        field && "ui-input",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
