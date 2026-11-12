"use client";

import { Meter as MeterPrimitive } from "@base-ui/react/meter";

/**
 * How much of a known amount is used, such as a quota (`role="meter"`).
 * Unstyled: the call site draws the bar inside it. `value` is a percentage
 * unless `max` says otherwise; `aria-label` names it.
 */
const Meter = MeterPrimitive.Root;

export { Meter };
