import type { Root, Element } from "hast";
import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import type { TocItem } from "@/components/docs/toc";

export function rehypeExtractHeadings(headings: TocItem[]) {
  return () => (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "h2" || node.tagName === "h3") {
        const id = node.properties?.id;
        if (typeof id === "string") {
          headings.push({
            id,
            text: toString(node),
            level: parseInt(node.tagName[1]) as 2 | 3,
          });
        }
      }
    });
  };
}
