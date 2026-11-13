import { parse } from "yaml";

/**
 * Front matter: a YAML block between `---` lines at the very start of a
 * file. Dates stay Date objects (the YAML 1.1 `timestamp` type), as they were
 * when gray-matter read these files, and `<<` merge keys still merge.
 */
const BLOCK = /^---[^\S\r\n]*\r?\n(?:([\s\S]*?)\r?\n)?---[^\S\r\n]*(?:\r?\n|$)/;

export interface Frontmatter<T> {
  /** The block's fields, unchecked: `T` only names what the caller expects. */
  data: T;
  content: string;
}

export function parseFrontmatter<T = Record<string, unknown>>(source: string): Frontmatter<T> {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = BLOCK.exec(text);
  if (!match) return { data: {} as T, content: text };
  const data: unknown = parse(match[1] ?? "", { customTags: ["timestamp"], merge: true });
  return {
    data: (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as T,
    content: text.slice(match[0].length),
  };
}
