import { compileMDX } from "next-mdx-remote/rsc";
import rehypePrettyCode from "rehype-pretty-code";
import { prettyCodeOptions } from "@/lib/code-highlight";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { mdxComponents } from "@/components/docs/mdx-components";
import { rehypeExtractHeadings } from "@/lib/rehype-extract-headings";
import type { TocItem } from "@/components/docs/toc";

export interface CompiledBlogPost {
  content: React.ReactElement;
  headings: TocItem[];
}

export async function compileBlogMDX(source: string): Promise<CompiledBlogPost> {
  const headings: TocItem[] = [];

  const { content } = await compileMDX({
    source,
    components: mdxComponents,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [
          rehypeSlug,
          rehypeExtractHeadings(headings),
          [rehypePrettyCode, prettyCodeOptions],
        ],
      },
    },
  });

  return { content, headings };
}
