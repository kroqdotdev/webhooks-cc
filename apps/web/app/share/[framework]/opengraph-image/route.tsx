import { ogImageNotFound, ogImageResponse } from "@/lib/og/image";
import { getShareFrameworkPage, SHARE_FRAMEWORK_SLUGS } from "@/lib/share-framework-pages";

// One Open Graph image per framework page, all made at build time like the pages.
export const dynamicParams = false;

export function generateStaticParams() {
  return SHARE_FRAMEWORK_SLUGS.map((framework) => ({ framework }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ framework: string }> }
) {
  const { framework } = await params;
  const page = getShareFrameworkPage(framework);
  if (!page) return ogImageNotFound();

  return ogImageResponse({
    kind: "Share localhost",
    title: `Share a ${page.label} dev server`,
    subtitle: `whk share ${page.port}: a public HTTPS link to localhost`,
    path: `/share/${page.slug}`,
  });
}
