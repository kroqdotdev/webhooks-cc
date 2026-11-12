import * as React from "react";
import { cn } from "@/lib/utils";

/** The control input look (forms on the account pages, dialogs). */
export const CONTROL_INPUT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/** `field` adds the field look (`FieldControl`'s) over the control's own. */
const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input"> & { field?: boolean }
>(({ className, type, field = false, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(CONTROL_INPUT_CLASS, field && "ui-input", className)}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
