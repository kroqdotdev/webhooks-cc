"use client";

import * as React from "react";
import { Menu } from "@base-ui/react/menu";

import { cn, type Styled } from "@/lib/utils";

const DropdownMenu = Menu.Root;

const DropdownMenuTrigger = Menu.Trigger;

const DropdownMenuGroup = Menu.Group;

/**
 * How a menu is drawn. `panel` is the padded popover with rounded items;
 * `list` is the dashboard's bordered list, each item a full-width row in small
 * bold type (give every item but the last `border-b`).
 */
export type MenuLook = "panel" | "list";

const CONTENT_LOOK: Record<MenuLook, string> = {
  panel:
    "min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
  list: "min-w-[160px] overflow-hidden rounded-lg border bg-background shadow-float outline-none",
};

const ITEM_LOOK: Record<MenuLook, string> = {
  panel:
    "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  list: "flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-left text-xs font-bold outline-none transition-colors data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50",
};

/** The classes of a menu panel in the given look, for the context menu too. */
export function menuContentClass(look: MenuLook, className?: string) {
  return cn(CONTENT_LOOK[look], className);
}

/** The classes of a menu item in the given look. */
export function menuItemClass(look: MenuLook, className?: string) {
  return cn(ITEM_LOOK[look], className);
}

type DropdownMenuContentProps = Styled<Menu.Popup.Props> &
  Pick<Menu.Positioner.Props, "align" | "side" | "sideOffset" | "collisionAvoidance"> & {
    look?: MenuLook;
  };

/** The menu panel, placed against its trigger (below it, 4px away, by default). */
function DropdownMenuContent({
  className,
  align,
  side,
  sideOffset = 4,
  collisionAvoidance,
  look = "panel",
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
        <Menu.Popup className={menuContentClass(look, className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function DropdownMenuItem({
  className,
  look = "panel",
  ...props
}: Styled<Menu.Item.Props> & { look?: MenuLook }) {
  return <Menu.Item className={menuItemClass(look, className)} {...props} />;
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
