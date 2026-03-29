"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/components/providers/theme-provider";

export function ScalarViewer() {
  const { resolvedTheme } = useTheme();
  const [Component, setComponent] = useState<React.ComponentType<{
    configuration: Record<string, unknown>;
  }> | null>(null);

  useEffect(() => {
    import("@scalar/api-reference-react").then((mod) => {
      setComponent(() => mod.ApiReferenceReact);
    });
    import("@scalar/api-reference-react/style.css");
  }, []);

  if (!Component) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        Loading API reference...
      </div>
    );
  }

  return (
    <div>
      <Component
        configuration={{
          spec: {
            url: "/openapi.yaml",
          },
          hideModels: false,
          hideDownloadButton: false,
          darkMode: resolvedTheme === "dark",
          theme: "kepler",
          defaultHttpClient: {
            targetKey: "node",
            clientKey: "fetch",
          },
        }}
      />
    </div>
  );
}
