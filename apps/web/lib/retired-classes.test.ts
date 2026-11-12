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

// caps is also an English word, so comments are skipped and only a caps
// inside a string (a class list, wherever its line breaks fall) counts.
const COMMENT = /^\s*(?:\/\/|\*|\/\*|\{\/\*)/;
const CAPS_IN_STRING = /["'`][^"'`\n]*(?<![\w-])caps(?:-wide)?(?![\w-])[^"'`\n]*["'`]/;

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
          if (!COMMENT.test(line) && CAPS_IN_STRING.test(line)) {
            violations.push(`${where} has caps, which no longer exists`);
          }
        });
    }
    expect(violations).toEqual([]);
  });

  // The shared looks are drawn by components (Button, Card, CodeBox,
  // FieldControl, and the field prop on Input, Textarea and SelectTrigger);
  // their classes in globals.css belong to components/ui alone. A selector
  // that reaches into one of them (`[&_.ui-card>p]`) is fine.
  it("leaves the shared look classes to the components", () => {
    const LOOK =
      /(?<![\w.-])ui-(?:card(?:-static)?|btn(?:-primary|-secondary|-outline)?|code|input)(?![\w-])/;
    const violations = files
      .filter((file) => !file.includes(`${path.sep}components${path.sep}ui${path.sep}`))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ line, where: `${path.relative(ROOT, file)}:${index + 1}` }))
          .filter(({ line }) => !COMMENT.test(line) && LOOK.test(line))
          .map(({ line, where }) => `${where} has ${line.match(LOOK)![0]}; use its component`)
      );
    expect(violations).toEqual([]);
  });

  // Menus, dialogs, tabs, radio groups, switches and meters are Base UI parts
  // (components/ui), which bring their keyboard, focus and dismiss rules; a
  // widget role written by hand outside components/ui means one was rebuilt.
  // The cookie banner is the one exception: a non-modal notice that must be
  // answered, with no keyboard or dismiss behaviour of its own to replace.
  it("builds its widgets on the Base UI parts", () => {
    // role="menu", role={"menu"}, role={open ? "menu" : undefined} and a props
    // object's role: "menu" alike.
    const WIDGET =
      /\brole(?:=|=\{[^}]*?|\s*:\s*)["'`](?:radio|radiogroup|switch|checkbox|progressbar|meter|slider|menu|menuitem(?:radio|checkbox)?|menubar|tab|tablist|tabpanel|dialog|alertdialog|tooltip|combobox)["'`]|aria-modal/;
    const ALLOWED = new Set([path.join("components", "providers", "cookie-consent.tsx")]);
    const violations = files
      .filter((file) => !file.includes(`${path.sep}components${path.sep}ui${path.sep}`))
      .filter((file) => !ALLOWED.has(path.relative(ROOT, file)))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ line, where: `${path.relative(ROOT, file)}:${index + 1}` }))
          .filter(({ line }) => !COMMENT.test(line) && WIDGET.test(line))
          .map(
            ({ line, where }) => `${where} has ${line.match(WIDGET)![0]}; use a components/ui part`
          )
      );
    expect(violations).toEqual([]);
  });

  it("keeps globals.css free of the retired tokens", () => {
    const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
    for (const token of [
      /--line(?![\w-])/,
      /--action(?![\w-])/,
      /--press(?![\w-])/,
      /--primary-ink(?![\w-])/,
      /data-style/,
      /(?<![\w-])caps(?![\w-])/,
    ]) {
      expect(css).not.toMatch(token);
    }
  });
});
