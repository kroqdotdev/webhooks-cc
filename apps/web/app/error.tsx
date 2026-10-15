"use client";

import { useEffect } from "react";
import {
  isChunkLoadError,
  reportBoundaryError,
  tryReloadOnChunkError,
} from "@/lib/observability-browser";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    reportBoundaryError(error, "app");
    tryReloadOnChunkError(error);
  }, [error]);

  const isChunk = isChunkLoadError(error);

  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h2>Something went wrong</h2>
      <button
        onClick={() => {
          if (isChunk && typeof window !== "undefined") {
            window.location.reload();
          } else {
            reset();
          }
        }}
        style={{ marginTop: "1rem" }}
      >
        {isChunk ? "Reload page" : "Try again"}
      </button>
    </div>
  );
}
