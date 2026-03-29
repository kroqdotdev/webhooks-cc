"use client";

import { useEffect, useState } from "react";

export function ScalarViewer() {
  const [Component, setComponent] = useState<React.ComponentType<{
    configuration: Record<string, unknown>;
  }> | null>(null);

  useEffect(() => {
    import("@scalar/api-reference-react").then((mod) => {
      setComponent(() => mod.ApiReferenceReact);
    });
    // Load styles
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
    <div className="-mx-6 md:-mx-10">
      <Component
        configuration={{
          spec: {
            url: "/openapi.yaml",
          },
          hideModels: false,
          hideDownloadButton: false,
          darkMode: true,
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
