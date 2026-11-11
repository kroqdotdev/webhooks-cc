import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The classic style is gone, and with it the utilities and tokens that
 * switched between the two styles. Tailwind emits nothing for a class it does
 * not know, so one of these coming back (from an old branch, say) would
 * silently drop a border, a shadow or a colour instead of failing the build.
 */
const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib", "types"];

const RETIRED: { pattern: RegExp; use: string }[] = [
  { pattern: /(?<![\w-])border(?:-[trblxy])?-strong(?![\w-])/, use: "border (or border-t, ...)" },
  {
    pattern: /(?<![\w-])(?:border|divide|ring|outline|decoration)(?:-[trblxy])?-line(?![\w-])/,
    use: "border-border (the default border colour)",
  },
  {
    pattern: /(?<![\w-])(?:bg|text|border|ring|fill|stroke)-action(?:-foreground)?(?![\w-])/,
    use: "bg-primary, text-primary-foreground, ...",
  },
  {
    pattern: /(?<![\w-])(?:text|fill|stroke|decoration)-primary-ink(?![\w-])/,
    use: "text-primary",
  },
  { pattern: /(?<![\w-])text-kind-email-ink(?![\w-])/, use: "text-kind-email" },
  {
    pattern: /(?<![\w-])shadow-raised(?:-sm|-lg)?(?![\w-])/,
    use: "shadow-surface or shadow-float",
  },
  { pattern: /\(--press\)/, use: "nothing: there is no press offset" },
  { pattern: /(?<![\w-])(?:clean|classic):[\w[!-]/, use: "the class without the variant" },
  { pattern: /data-style/, use: "nothing: there is one style" },
];

// caps was also an English word in comments, so only class lists are checked for it.
const CAPS = /(?<![\w-])caps(?:-wide)?(?![\w-])/;
const CLASS_LIST = /className=|\bcn\(|\bcva\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("retired style classes", () => {
  const files = SCAN_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).filter(
    // Old release notes describe the classic style in prose.
    (file) => !file.endsWith(path.join("lib", "changelog.ts"))
  );

  it("finds the component sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses none of the classic-era utilities or tokens", () => {
    const violations: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const where = `${path.relative(ROOT, file)}:${index + 1}`;
          for (const { pattern, use } of RETIRED) {
            const match = line.match(pattern);
            if (match) violations.push(`${where} has ${match[0]}, use ${use}`);
          }
          if (CLASS_LIST.test(line) && CAPS.test(line)) {
            violations.push(`${where} has caps, which no longer exists`);
          }
        });
    }
    expect(violations).toEqual([]);
  });

  it("keeps globals.css free of the retired tokens", () => {
    const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
    for (const token of ["--line", "--action", "--press", "--primary-ink", "data-style", "caps"]) {
      expect(css, token).not.toMatch(new RegExp(`${token.replace(/[-]/g, "\\-")}(?![\\w-])`));
    }
  });
});
