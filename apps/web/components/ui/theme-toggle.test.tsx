import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  it("renders without a ThemeProvider", () => {
    // Next renders not-found.tsx without the root layout for some requests;
    // the header's toggle must not throw there.
    const html = renderToString(<ThemeToggle />);
    expect(html).toContain('aria-label="System theme"');
    expect(html).toMatch(/aria-label="System theme" aria-pressed="true"/);
  });

  it("renders inside a ThemeProvider", () => {
    const html = renderToString(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    expect(html).toContain('aria-label="Light mode"');
  });
});
