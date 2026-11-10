import {
  DocPage,
  docMetadata,
  docStaticParams,
  type DocPageProps,
} from "@/components/docs/doc-page";

// The same docs as webhooks.cc's /docs (app/docs), at the same paths on
// mailhooks.cc. Every doc is known at build time; anything else is
// mailhooks.cc's 404 page.
export const dynamicParams = false;

export const generateStaticParams = docStaticParams;

// One canonical URL for each doc, on webhooks.cc.
export function generateMetadata(props: DocPageProps) {
  return docMetadata(props, { absoluteCanonical: true });
}

export default function MailhooksDocsPage(props: DocPageProps) {
  return <DocPage {...props} />;
}
