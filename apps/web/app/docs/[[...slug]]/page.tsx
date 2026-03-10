import { notFound } from "next/navigation";
import { compileMDX } from "next-mdx-remote/rsc";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { getAllDocSlugs, getDocBySlug } from "@/lib/docs";
import { createPageMetadata } from "@/lib/seo";
import { mdxComponents } from "@/components/docs/mdx-components";
import { PrevNextNav } from "@/components/docs/prev-next";
import { getPrevNext } from "@/lib/docs-nav";
import { rehypeExtractHeadings } from "@/lib/rehype-extract-headings";
import { TableOfContents, type TocItem } from "@/components/docs/toc";
import { JsonLd, faqSchema, howToSchema } from "@/lib/schemas";
import { extractFaqItems, extractHowToSteps } from "@/lib/mdx-schema-extract";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export async function generateStaticParams() {
  const slugs = await getAllDocSlugs();
  return slugs.map((slug) => ({
    slug: slug ? slug.split("/") : [],
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const slugPath = slug?.join("/") ?? "";
  const doc = await getDocBySlug(slugPath);

  if (!doc) return {};

  const { frontmatter: fm } = doc;
  return createPageMetadata({
    title: fm.seo?.ogTitle ?? fm.title,
    description: fm.seo?.ogDescription ?? fm.description,
    path: `/docs/${slugPath}`,
    keywords: fm.keywords,
  });
}

export default async function DocsCatchAllPage({ params }: PageProps) {
  const { slug } = await params;
  const slugPath = slug?.join("/") ?? "";
  const doc = await getDocBySlug(slugPath);

  if (!doc) notFound();

  const { content, frontmatter: fm } = doc;

  const headings: TocItem[] = [];

  const { content: mdxContent } = await compileMDX({
    source: content,
    components: mdxComponents,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [
          rehypeSlug,
          rehypeExtractHeadings(headings),
          [
            rehypePrettyCode,
            {
              theme: {
                light: "github-light",
                dark: "github-dark",
              },
              keepBackground: false,
            },
          ],
        ],
      },
    },
  });

  const href = slugPath ? `/docs/${slugPath}` : "/docs";
  const { prev, next } = getPrevNext(href);

  // Build JSON-LD from frontmatter schema field
  let schemaData: Record<string, unknown> | null = null;
  if (fm.schema === "faq") {
    const items = extractFaqItems(content);
    if (items.length > 0) {
      schemaData = faqSchema(items);
    }
  } else if (fm.schema === "howto") {
    const steps = extractHowToSteps(content);
    if (steps.length > 0) {
      schemaData = howToSchema({
        name: fm.title,
        description: fm.description,
        steps,
      });
    }
  }

  return (
    <div className="flex gap-10">
      {schemaData && <JsonLd data={schemaData} />}
      <article className="max-w-3xl flex-1 min-w-0">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">{fm.title}</h1>
        <p className="text-lg text-muted-foreground mb-10">{fm.description}</p>
        {mdxContent}
        <PrevNextNav prev={prev} next={next} />
      </article>
      <TableOfContents headings={headings} />
    </div>
  );
}
