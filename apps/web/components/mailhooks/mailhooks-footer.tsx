import Link from "next/link";
import { CookieSettingsLink } from "@/components/providers/cookie-consent";
import { MAILHOOKS_FEATURES } from "@/lib/mailhooks-features";
import { webhooksOrigin } from "@/lib/site";

/** mailhooks.cc's footer: its own pages and the docs, and webhooks.cc's legal pages. */
export function MailhooksFooter() {
  const webhooks = webhooksOrigin();
  const columns = [
    {
      title: "Product",
      links: [
        { href: "/parse", label: "Layout gallery" },
        { href: "/guides", label: "Guides" },
        { href: "/pricing", label: "Pricing" },
        { href: "/login", label: "Sign in" },
      ],
    },
    {
      title: "Features",
      links: MAILHOOKS_FEATURES.map((feature) => ({ href: feature.path, label: feature.name })),
    },
    {
      title: "Docs",
      links: [
        { href: "/docs/layouts", label: "Layout docs" },
        { href: "/docs/email-capture", label: "Email capture" },
        { href: "/docs/forwarding", label: "Destinations" },
        { href: "/docs/plans-limits", label: "Plans and limits" },
      ],
    },
    {
      title: "Company",
      links: [
        { href: "/support", label: "Support" },
        { href: webhooks, label: "webhooks.cc" },
        { href: `${webhooks}/privacy`, label: "Privacy" },
        { href: `${webhooks}/terms`, label: "Terms" },
        { href: `${webhooks}/subprocessors`, label: "Subprocessors" },
      ],
    },
  ];
  return (
    <footer className="border-t-strong border-line py-12 px-4">
      <div className="max-w-6xl mx-auto grid md:grid-cols-3 lg:grid-cols-5 gap-8">
        <div>
          <p className="font-bold text-lg mb-4">mailhooks.cc</p>
          <p className="text-muted-foreground text-sm">
            Email into structured data. Part of webhooks.cc: the same account, endpoints and plans
            on both sites.
          </p>
        </div>
        {columns.map((column) => (
          <div key={column.title}>
            <p className="font-bold mb-4">{column.title}</p>
            <ul className="space-y-0.5 text-sm">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="inline-block py-1.5 text-muted-foreground hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              {column.title === "Company" ? (
                <li>
                  <CookieSettingsLink className="inline-block py-1.5 text-muted-foreground hover:text-foreground" />
                </li>
              ) : null}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
