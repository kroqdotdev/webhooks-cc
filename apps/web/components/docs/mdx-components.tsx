import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { CodeBlock } from "./mdx/code-block";
import { Callout } from "./mdx/callout";
import { Steps, Step } from "./mdx/steps";
import { Tabs, Tab } from "./mdx/tabs";
import { LinkCard } from "./mdx/link-card";
import { ProviderCard } from "./mdx/provider-card";
import { ApiMethod, ParamTable } from "./mdx/api-method";
import { FAQ, FAQItem } from "./mdx/faq";
import { McpInstallGuide } from "./mdx/mcp-setup";

export const mdxComponents: MDXComponents = {
  // --- HTML element overrides ---

  pre: (props: React.ComponentProps<"pre">) => <CodeBlock {...props} />,

  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    if (href?.startsWith("/") || href?.startsWith("#")) {
      return (
        <Link href={href} className="text-primary hover:underline font-bold" {...props}>
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline font-bold"
        {...props}
      >
        {children}
      </a>
    );
  },

  table: (props: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-6 overflow-x-auto border-2 border-foreground shadow-neo-sm">
      <table className="w-full text-sm" {...props} />
    </div>
  ),
  th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="text-left font-bold py-2 px-3 border-b-2 border-foreground bg-muted"
      {...props}
    />
  ),
  td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="py-2 px-3 border-b border-foreground/20" {...props} />
  ),

  // --- Custom components ---
  Callout,
  Steps,
  Step,
  Tabs,
  Tab,
  LinkCard,
  ProviderCard,
  ApiMethod,
  ParamTable,
  FAQ,
  FAQItem,
  McpInstallGuide,
};
