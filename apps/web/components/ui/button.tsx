"use client";

import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { joinClasses } from "./render-as";

/** The fixed-height control buttons: dialogs, forms and account pages. */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

/**
 * The padded surface buttons used across the dashboard and the site, drawn by
 * the `ui-btn` rules in globals.css. Those sit in the components layer, so
 * any utility a call site passes (padding, text size, colour) wins over them;
 * their classes are joined, never merged.
 */
const SURFACES = {
  /** Pine fill: the one main action. */
  primary: "ui-btn-primary",
  /** White with the control edge (3:1 against the page). Not the control `outline`, which has a fixed height. */
  surface: "ui-btn-outline",
  /** White with the light hairline. */
  hairline: "ui-btn",
  /** Muted fill that lifts on hover. */
  soft: "ui-btn-secondary",
} as const;

type Surface = keyof typeof SURFACES;

/**
 * A control button lifted by the surface shadow, as the dialogs' actions are.
 * The shadow is set as the property itself, so a focus ring replaces it
 * rather than adding to it.
 */
const RAISED = "[box-shadow:var(--elevation-sm)] cursor-pointer";
const RAISED_FILL = `border border-transparent ${RAISED}`;
type ControlVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export interface ButtonProps
  extends
    Omit<useRender.ComponentProps<"button">, "ref">,
    Omit<VariantProps<typeof buttonVariants>, "variant"> {
  variant?: ControlVariant | Surface | null;
  /** For the control variants: lifted by the surface shadow (see RAISED). */
  raised?: boolean;
  ref?: React.Ref<HTMLElement>;
}

function isSurface(variant: ButtonProps["variant"]): variant is Surface {
  return !!variant && variant in SURFACES;
}

/**
 * A button in one of the shared looks. Pass `render` to draw it as another
 * element with the same look, such as a link: `<Button render={<Link href="/" />}>`.
 */
function Button({ className, variant, size, raised = false, render, ref, ...props }: ButtonProps) {
  return useRender({
    defaultTagName: "button",
    render,
    ref,
    props: mergeProps<"button">(
      {
        className: isSurface(variant)
          ? joinClasses(SURFACES[variant], className)
          : cn(
              buttonVariants({ variant, size }),
              raised && (variant === "outline" ? RAISED : RAISED_FILL),
              className
            ),
      },
      props
    ),
  });
}

export { Button, buttonVariants };
