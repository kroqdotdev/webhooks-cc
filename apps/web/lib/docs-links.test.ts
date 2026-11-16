import { describe, expect, it } from "vitest";
import { getAllDocSlugs, getDocBySlug } from "./docs";
import { MOVED_ANCHORS } from "./docs-moved-anchors";

/** Heading ids as rehype-slug (github-slugger) makes them, repeats numbered. */
function headingIds(source: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  let fenced = false;
  for (const line of source.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fenced = !fenced;
    const match = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  return ids;
}

function proseOf(source: string): string {
  let fenced = false;
  return source
    .split("\n")
    .filter((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n");
}

async function loadDocs() {
  const slugs = await getAllDocSlugs();
  const docs = new Map<string, string>();
  for (const slug of slugs) docs.set(slug, (await getDocBySlug(slug))!.content);
  return docs;
}

describe("links in the docs", () => {
  it("point at docs that exist, and at headings that exist in them", async () => {
    const docs = await loadDocs();
    const ids = new Map([...docs].map(([slug, source]) => [slug, headingIds(source)]));
    const broken: string[] = [];
    for (const [slug, source] of docs) {
      const prose = proseOf(source);
      // Markdown links, and JSX href props (<LinkCard href="/docs/...">).
      for (const match of prose.matchAll(
        /\]\((\/docs[^)\s]*|#[^)\s]*)\)|\bhref=["'](\/docs[^"'\s]*|#[^"'\s]*)["']/g
      )) {
        const href = match[1] ?? match[2];
        const [path, hash] = href.split("#");
        const target = href.startsWith("#")
          ? slug
          : path.replace(/^\/docs\/?/, "").replace(/\/$/, "");
        if (!docs.has(target)) {
          broken.push(`${slug || "(root)"}: ${href} (no such doc)`);
        } else if (hash && !ids.get(target)!.has(hash)) {
          broken.push(`${slug || "(root)"}: ${href} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("never point at the wrong GitHub organisation or a retired docs path", async () => {
    const docs = await loadDocs();
    for (const [slug, source] of docs) {
      expect(source, slug).not.toContain("github.com/webhooks-cc/");
      expect(source, slug).not.toContain("/docs/providers/");
    }
  });
});

describe("MOVED_ANCHORS", () => {
  it("only names headings that exist on the page they point to", async () => {
    const docs = await loadDocs();
    for (const [from, anchors] of Object.entries(MOVED_ANCHORS)) {
      expect(docs.has(from), from).toBe(true);
      const own = headingIds(docs.get(from)!);
      for (const [id, target] of Object.entries(anchors)) {
        const targetSlug = target.replace(/^\/docs\//, "");
        expect(docs.has(targetSlug), target).toBe(true);
        expect(headingIds(docs.get(targetSlug)!).has(id), `${target}#${id}`).toBe(true);
        // A heading still on the old page needs no redirect.
        expect(own.has(id), `${from}#${id} is still on the old page`).toBe(false);
      }
    }
  });
});
