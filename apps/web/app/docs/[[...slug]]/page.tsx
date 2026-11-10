import {
  DocPage,
  docMetadata,
  docStaticParams,
  type DocPageProps,
} from "@/components/docs/doc-page";

// Every doc is known at build time; anything else is the static 404 page.
export const dynamicParams = false;

export const generateStaticParams = docStaticParams;

export function generateMetadata(props: DocPageProps) {
  return docMetadata(props);
}

export default function DocsCatchAllPage(props: DocPageProps) {
  return <DocPage {...props} />;
}
