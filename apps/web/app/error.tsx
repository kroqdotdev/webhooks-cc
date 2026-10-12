"use client";

import { useEffect } from "react";
import { reportBoundaryError } from "@/lib/observability-browser";

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
  }, [error]);

  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h2>Something went wrong</h2>
      <button onClick={() => reset()} style={{ marginTop: "1rem" }}>
        Try again
      </button>
    </div>
  );
}
