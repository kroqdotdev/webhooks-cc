"use client";

import * as React from "react";
import { Menu } from "@base-ui/react/menu";

import { cn, type Styled } from "@/lib/utils";

const DropdownMenu = Menu.Root;

const DropdownMenuTrigger = Menu.Trigger;

const DropdownMenuGroup = Menu.Group;

type DropdownMenuContentProps = Styled<Menu.Popup.Props> &
  Pick<Menu.Positioner.Props, "align" | "side" | "sideOffset" | "collisionAvoidance">;

/** The menu panel, placed against its trigger (below it, 4px away, by default). */
function DropdownMenuContent({
  className,
  align,
  side,
  sideOffset = 4,
  collisionAvoidance,
  ...props
}: DropdownMenuContentProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        className="z-50 outline-none"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
      >
        <Menu.Popup
          className={cn(
            "min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            className
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: Styled<Menu.Item.Props>) {
  return (
    <Menu.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  );
}

/** A heading inside the menu. Not tied to a group, so it can head any run of items. */
function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />;
}

function DropdownMenuSeparator({ className, ...props }: Styled<Menu.Separator.Props>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
};
