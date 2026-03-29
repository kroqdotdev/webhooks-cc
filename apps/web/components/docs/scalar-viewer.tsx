"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/components/providers/theme-provider";

/**
 * Scalar CSS variable overrides that map to our site's design tokens.
 * Uses `theme: "none"` so only our overrides apply.
 */
const scalarStyles = `
  .light-mode,
  .dark-mode {
    --scalar-font: var(--font-sans), system-ui, sans-serif;
    --scalar-font-code: var(--font-mono), monospace;
    --scalar-radius: 0;
    --scalar-radius-lg: 0;
    --scalar-radius-xl: 0;
  }

  .light-mode {
    --scalar-background-1: #fafaf9;
    --scalar-background-2: #f0f0ed;
    --scalar-background-3: #e7e7e4;
    --scalar-background-accent: #00d19220;

    --scalar-color-1: #000000;
    --scalar-color-2: #404040;
    --scalar-color-3: #595959;
    --scalar-color-accent: #00d192;
    --scalar-color-green: #00d192;

    --scalar-border-color: #00000020;

    --scalar-sidebar-background-1: #fafaf9;
    --scalar-sidebar-color-1: #000000;
    --scalar-sidebar-color-2: #595959;
    --scalar-sidebar-item-hover-background: #e7e7e4;
    --scalar-sidebar-search-background: #f0f0ed;
    --scalar-sidebar-search-border-color: #00000020;

    --scalar-button-1: #00d192;
    --scalar-button-1-hover: #00b87f;
    --scalar-button-1-color: #000000;
  }

  .dark-mode {
    --scalar-background-1: #18181b;
    --scalar-background-2: #222226;
    --scalar-background-3: #303036;
    --scalar-background-accent: #00e6a120;

    --scalar-color-1: #fafaf9;
    --scalar-color-2: #b6b6af;
    --scalar-color-3: #8a8a84;
    --scalar-color-accent: #00e6a1;
    --scalar-color-green: #00e6a1;

    --scalar-border-color: #fafaf920;

    --scalar-sidebar-background-1: #18181b;
    --scalar-sidebar-color-1: #fafaf9;
    --scalar-sidebar-color-2: #b6b6af;
    --scalar-sidebar-item-hover-background: #303036;
    --scalar-sidebar-search-background: #222226;
    --scalar-sidebar-search-border-color: #fafaf920;

    --scalar-button-1: #00e6a1;
    --scalar-button-1-hover: #00d192;
    --scalar-button-1-color: #000000;
  }
`;

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
    <>
      <style>{scalarStyles}</style>
      <Component
        configuration={{
          spec: {
            url: "/openapi.yaml",
          },
          hideModels: false,
          hideDownloadButton: false,
          darkMode: resolvedTheme === "dark",
          theme: "none",
          withDefaultFonts: false,
          defaultHttpClient: {
            targetKey: "node",
            clientKey: "fetch",
          },
        }}
      />
    </>
  );
}
