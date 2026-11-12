"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

/**
 * An on/off control (`role="switch"`). Unstyled parts: Root (listen with
 * `onCheckedChange`; with `nativeButton` and `render={<button />}` its `id`
 * lands on the button, so a sibling `<label htmlFor>` names it) and Thumb.
 * The settings' drawn switch is `Switch` in components/dashboard/settings-primitives.
 */
const SwitchRoot = SwitchPrimitive.Root;
const SwitchThumb = SwitchPrimitive.Thumb;

export { SwitchRoot, SwitchThumb };
