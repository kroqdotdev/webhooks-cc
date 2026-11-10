import { DocsShell } from "@/components/docs/docs-shell";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";

/** webhooks.cc's docs on mailhooks.cc, under its header and footer (app/mailhooks/layout.tsx sets the site). */
export default function MailhooksDocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell footer={<MailhooksFooter />}>{children}</DocsShell>;
}
