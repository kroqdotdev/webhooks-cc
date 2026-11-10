import { DocsShell } from "@/components/docs/docs-shell";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell searchIndexed>{children}</DocsShell>;
}
