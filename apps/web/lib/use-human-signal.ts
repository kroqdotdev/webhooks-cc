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

    const markHuman = () => setSignal("human");
    const options: AddEventListenerOptions = { once: true, passive: true, capture: true };
    for (const event of SIGNAL_EVENTS) {
      window.addEventListener(event, markHuman, options);
    }
    return () => {
      for (const event of SIGNAL_EVENTS) {
        window.removeEventListener(event, markHuman, { capture: true });
      }
    };
  }, []);

  return signal;
}
