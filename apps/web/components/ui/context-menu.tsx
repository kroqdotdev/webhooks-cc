"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import type { Styled } from "@/lib/utils";
import { menuContentClass, menuItemClass, type MenuLook } from "./dropdown-menu";

/**
 * A menu opened by a right click, the keyboard's menu key or a long press
 * inside its trigger, at the pointer. The trigger is a `<div>`; give it
 * `render` to make an existing element the area. To act on the row that was
 * pressed, read `details.event.target` in `onOpenChange` (a long press on iOS
 * fires no `contextmenu` event, so a row's own handler would miss it).
 *
 * Modal, as the browser's own context menu is: a press outside only closes it
 * (Base UI ignores `modal` on a context menu).
 */
const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

/** The menu panel, its top left corner at the pointer. Drawn as a `list` menu by default. */
function ContextMenuContent({
  className,
  look = "list",
  ...props
}: Styled<ContextMenuPrimitive.Popup.Props> & { look?: MenuLook }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 outline-none" alignOffset={0} sideOffset={0}>
        <ContextMenuPrimitive.Popup className={menuContentClass(look, className)} {...props} />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  look = "list",
  ...props
}: Styled<ContextMenuPrimitive.Item.Props> & { look?: MenuLook }) {
  return <ContextMenuPrimitive.Item className={menuItemClass(look, className)} {...props} />;
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem };
