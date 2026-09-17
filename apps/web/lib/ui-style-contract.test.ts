import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The web app renders in two visual styles (see app/globals.css). Utilities
 * that hardcode the classic look would leave those spots neobrutalist in the
 * clean style, so component code must use the style-aware vocabulary instead.
 */
const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "components"];

const BANNED: { pattern: RegExp; use: string }[] = [
  { pattern: /\bborder-(?:[trblxy]-)?2\b/, use: "border-strong (or border-t-strong, ...)" },
  { pattern: /\bborder-foreground\b(?!\/)/, use: "border-line" },
  { pattern: /\bdivide-foreground\b(?!\/)/, use: "divide-line" },
  { pattern: /\bshadow-neo/, use: "shadow-raised-sm, shadow-raised, or shadow-raised-lg" },
  { pattern: /\bneo-(?:card|btn|input|code)/, use: "ui-card, ui-btn-*, ui-input, or ui-code" },
  { pattern: /\btransition-neo\b/, use: "transition-all duration-150 ease-out" },
  { pattern: /\brounded-none!/, use: "nothing: radius is already zero in classic" },
  { pattern: /\btranslate-[xy]-\[-?2px\]/, use: "translate-x-(--press) and translate-y-(--press)" },
];

// uppercase paired with tracking is the classic label treatment; use caps or caps-wide.
// Monospace data such as claim codes may stay uppercase and tracked in both styles.
const CLASSIC_LABEL = /\buppercase\b[^"'`]*\btracking-wide|\btracking-wide[^"'`]*\buppercase\b/;
const MONO = /\bfont-mono\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("UI style contract", () => {
  const files = SCAN_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));

  it("finds the component sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses style-aware utilities instead of classic-only ones", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const where = `${path.relative(ROOT, file)}:${index + 1}`;
        for (const { pattern, use } of BANNED) {
          const match = line.match(pattern);
          if (match) violations.push(`${where} has ${match[0]}, use ${use}`);
        }
        if (CLASSIC_LABEL.test(line) && !MONO.test(line)) {
          violations.push(`${where} pairs uppercase with tracking, use caps or caps-wide`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
