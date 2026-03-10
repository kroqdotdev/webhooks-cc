import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface DocFrontmatter {
  title: string;
  description: string;
  section: string;
  order: number;
  lastUpdated: string | Date;
  schema: "howto" | "faq" | "tech-article" | "none";
  keywords?: string[];
  seo?: {
    ogTitle?: string;
    ogDescription?: string;
  };
}

export interface DocPage {
  slug: string;
  frontmatter: DocFrontmatter;
  content: string; // raw MDX content (without frontmatter)
}

export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

// -------------------------------------------------------------------
// Content directory resolution
// -------------------------------------------------------------------

const CONTENT_DIR = path.resolve(process.cwd(), "../../content/docs");

function slugToFilePath(slug: string): string {
  const file = slug === "" ? "index" : slug;
  return path.join(CONTENT_DIR, `${file}.mdx`);
}

// -------------------------------------------------------------------
// Read a single doc page
// -------------------------------------------------------------------

export async function getDocBySlug(slug: string): Promise<DocPage | null> {
  const filePath = slugToFilePath(slug);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { data, content } = matter(raw);
    return {
      slug,
      frontmatter: data as DocFrontmatter,
      content,
    };
  } catch (err: unknown) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) throw err;
    // Also try index.mdx for directory paths
    if (slug !== "") {
      const indexPath = path.join(CONTENT_DIR, slug, "index.mdx");
      try {
        const raw = await fs.readFile(indexPath, "utf-8");
        const { data, content } = matter(raw);
        return {
          slug,
          frontmatter: data as DocFrontmatter,
          content,
        };
      } catch (err2: unknown) {
        if (!(err2 && typeof err2 === "object" && "code" in err2 && err2.code === "ENOENT"))
          throw err2;
        return null;
      }
    }
    return null;
  }
}

// -------------------------------------------------------------------
// Read frontmatter only (for metadata, sitemap, navigation)
// -------------------------------------------------------------------

export async function getDocFrontmatter(slug: string): Promise<DocFrontmatter | null> {
  const doc = await getDocBySlug(slug);
  return doc?.frontmatter ?? null;
}

// -------------------------------------------------------------------
// List all doc slugs (for sitemap, static generation)
// -------------------------------------------------------------------

export async function getAllDocSlugs(): Promise<string[]> {
  const slugs: string[] = [];

  async function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".mdx") && !entry.name.startsWith("_")) {
        const name = entry.name.replace(/\.mdx$/, "");
        if (name === "index") {
          slugs.push(prefix.replace(/\/$/, "") || "");
        } else {
          slugs.push(`${prefix}${name}`);
        }
      }
    }
  }

  await walk(CONTENT_DIR, "");
  return slugs;
}
