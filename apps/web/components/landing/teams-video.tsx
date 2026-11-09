"use client";

import { useRef, useEffect, useState } from "react";

export function TeamsVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (visible && !reducedMotion) {
      void ref.current?.play().catch(() => {});
    }
  }, [visible, reducedMotion]);

  return (
    <video
      ref={ref}
      loop={!reducedMotion}
      muted
      playsInline
      controls={reducedMotion}
      preload="none"
      src={visible ? "/video/TeamsFeature.mp4" : undefined}
      className="w-full aspect-video block bg-muted"
      aria-label="Demo of team collaboration features: creating a team, inviting members, and sharing endpoints"
    />
  );
}
