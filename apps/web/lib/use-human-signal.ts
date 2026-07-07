"use client";

import { useEffect, useState } from "react";

export type HumanSignal = "pending" | "human" | "automated";

const SIGNAL_EVENTS = [
  "pointermove",
  "pointerdown",
  "touchstart",
  "wheel",
  "keydown",
  "scroll",
] as const;

/**
 * Resolves to "human" on the first input signal (pointer, touch, key, scroll)
 * and to "automated" when the browser is driven by automation. Crawlers render
 * pages but don't produce input events, so they stay "pending" — use this to
 * gate side effects (like guest endpoint creation) that shouldn't run for bots.
 */
export function useHumanSignal(): HumanSignal {
  const [signal, setSignal] = useState<HumanSignal>("pending");

  useEffect(() => {
    if (navigator.webdriver) {
      setSignal("automated");
      return;
    }

    // Only trusted (user-agent generated) events count — synthetic events
    // dispatched from page scripts must not flip the gate. No `once` option:
    // an untrusted event would otherwise consume the listener for free.
    const detach = () => {
      for (const event of SIGNAL_EVENTS) {
        window.removeEventListener(event, markHuman, { capture: true });
      }
    };
    function markHuman(event: Event) {
      if (!event.isTrusted) return;
      setSignal("human");
      detach();
    }
    const options: AddEventListenerOptions = { passive: true, capture: true };
    for (const event of SIGNAL_EVENTS) {
      window.addEventListener(event, markHuman, options);
    }
    return detach;
  }, []);

  return signal;
}
