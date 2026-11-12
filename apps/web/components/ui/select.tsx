"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn, type Styled } from "@/lib/utils";

type SelectOption = { value: unknown; label: React.ReactNode };

/** Every SelectItem under these children, as base-ui's `items`: value and label. */
function itemsOf(children: React.ReactNode, out: SelectOption[] = []): SelectOption[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as { value?: unknown; children?: React.ReactNode };
    if (child.type === SelectItem) out.push({ value: props.value, label: props.children });
    else if (props.children) itemsOf(props.children, out);
  });
  return out;
}

/**
 * A single choice. The trigger shows the chosen item's label, read from the
 * SelectItems among the children (pass `items` to say it differently). Every
 * option has a value, so a change never reports null.
 */
function Select<Value>({
  onValueChange,
  items,
  children,
  ...props
}: Omit<SelectPrimitive.Root.Props<Value>, "onValueChange"> & {
  onValueChange?: (value: Value) => void;
}) {
  return (
    <SelectPrimitive.Root
      {...props}
      items={items ?? itemsOf(children)}
      onValueChange={(value) => {
        if (value !== null) onValueChange?.(value as Value);
      }}
    >
      {children}
    </SelectPrimitive.Root>
  );
}

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

/** `field` draws the trigger in the field look (`FieldControl`'s) instead of its own. */
function SelectTrigger({
  className,
  children,
  field = false,
  ...props
}: Styled<SelectPrimitive.Trigger.Props> & { field?: boolean }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground [&>span]:line-clamp-1",
        field && "ui-input",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex">
        <ChevronDown className="h-4 w-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** Shown at an end of a list that scrolls further that way; hovering it scrolls. */
const SCROLL_ARROW = "z-[1] flex w-full cursor-default items-center justify-center bg-popover py-1";

/** The list, below its trigger and at least as wide (its border outside the trigger's width), scrolling past 24rem. */
function SelectContent({ className, children, ...props }: Styled<SelectPrimitive.Popup.Props>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="z-50 outline-none"
        alignItemWithTrigger={false}
        side="bottom"
        align="start"
        sideOffset={4}
      >
        <SelectPrimitive.Popup
          className={cn(
            "relative flex max-h-[min(24rem,var(--available-height))] min-w-[max(8rem,calc(var(--anchor-width)+2px))] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none",
            className
          )}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className={SCROLL_ARROW + " top-0"}>
            <ChevronUp className="h-4 w-4" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List className="min-h-0 flex-1 overflow-y-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {children}
          </SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className={SCROLL_ARROW + " bottom-0"}>
            <ChevronDown className="h-4 w-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: Styled<SelectPrimitive.GroupLabel.Props>) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold", className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: Styled<SelectPrimitive.Item.Props>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: Styled<SelectPrimitive.Separator.Props>) {
  return (
    <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
  );
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
};
