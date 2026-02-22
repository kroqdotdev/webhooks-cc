"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SITE_URL } from "@/lib/seo";

const BREADCRUMB_LABELS: Record<string, string> = {
  "/docs": "Docs",
  "/docs/endpoints": "Endpoints",
  "/docs/requests": "Requests",
  "/docs/mock-responses": "Mock Responses",
  "/docs/cli": "CLI",
  "/docs/cli/commands": "Commands",
  "/docs/cli/tunnel": "Tunneling",
  "/docs/sdk": "SDK",
  "/docs/sdk/api": "API Reference",
  "/docs/sdk/testing": "Testing",
  "/docs/mcp": "MCP Server",
  "/installation": "Installation",
};

export function DocsBreadcrumbs() {
  const pathname = usePathname();
  if (!pathname) return null;

  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { name: string; path: string }[] = [{ name: "Home", path: "/" }];

  let accumulated = "";
  for (const segment of segments) {
    accumulated += `/${segment}`;
    const label = BREADCRUMB_LABELS[accumulated];
    if (label) {
      crumbs.push({ name: label, path: accumulated });
    }
  }

  if (crumbs.length < 2) return null;

  const breadcrumbJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: crumb.path === "/" ? SITE_URL : `${SITE_URL}${crumb.path}`,
    })),
  }).replace(/</g, "\\u003c");

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: breadcrumbJson }} />
      <nav aria-label="Breadcrumb" className="mb-6 flex items-center justify-between">
        <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li key={crumb.path} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    /
                  </span>
                )}
                {isLast ? (
                  <span aria-current="page" className="text-foreground font-bold">
                    {crumb.name}
                  </span>
                ) : (
                  <Link href={crumb.path} className="hover:text-foreground transition-colors">
                    {crumb.name}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
        <span className="text-xs text-muted-foreground hidden sm:block">Updated Feb 2026</span>
      </nav>
    </>
  );
}
