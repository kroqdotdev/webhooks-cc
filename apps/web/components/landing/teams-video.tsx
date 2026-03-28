"use client";

import { useRef, useEffect, useState } from "react";

export function TeamsVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);

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
    if (visible) {
      ref.current?.play();
    }
  }, [visible]);

  return (
    <video
      ref={ref}
      loop
      muted
      playsInline
      preload="none"
      src={visible ? "/video/TeamsFeature.mp4" : undefined}
      className="w-full h-auto block"
      aria-label="Demo of team collaboration features: creating a team, inviting members, and sharing endpoints"
    />
  );
}
