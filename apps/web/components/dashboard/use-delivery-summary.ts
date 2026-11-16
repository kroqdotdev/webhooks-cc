"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { fetchDeliverySummary, type DeliverySummary } from "@/lib/dashboard-api";
import { subscribeToEndpointRequestChanges } from "@/lib/supabase/realtime";

/** Whether an element is in the viewport, for polling only what is on screen. */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

/** Whether the document is visible, so a background tab stops polling. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * The endpoint's delivery counts (with `destinationId`, that destination's
 * alone), re-read every `intervalMs` while `active`,
 * and at once (then again shortly after, when the worker has had its turn)
 * whenever the endpoint's Realtime request signal fires. There is no signal
 * per delivery, so polling is what keeps the numbers live.
 */
export function useDeliverySummary(
  slug: string,
  endpointId: string,
  active: boolean,
  destinationId: string | null = null,
  intervalMs = 5000
): { summary: DeliverySummary | null; refresh: () => Promise<void> } {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  // The counts on screen belong to this key; a read for another one is dropped.
  const key = `${slug}\n${destinationId ?? ""}`;
  const currentKey = useRef(key);
  const inFlight = useRef<string | null>(null);

  useEffect(() => {
    currentKey.current = key;
    // Another destination's counts would read as this one's until the next poll.
    setSummary(null);
  }, [key]);

  const refresh = useCallback(async () => {
    if (!accessToken || inFlight.current === key) return;
    inFlight.current = key;
    try {
      const fresh = await fetchDeliverySummary(accessToken, slug, destinationId);
      if (currentKey.current === key) setSummary(fresh);
    } catch {
      // Keep the last counts; the next poll tries again.
    } finally {
      if (inFlight.current === key) inFlight.current = null;
    }
  }, [accessToken, slug, destinationId, key]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, refresh]);

  useEffect(() => {
    if (!active) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeToEndpointRequestChanges(endpointId, () => {
      void refresh();
      clearTimeout(settle);
      settle = setTimeout(() => void refresh(), 2500);
    });
    return () => {
      clearTimeout(settle);
      unsubscribe();
    };
  }, [active, endpointId, refresh]);

  return { summary, refresh };
}
