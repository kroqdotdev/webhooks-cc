import { SiteLink } from "@/components/nav/site-link";
import { ArrowRight } from "lucide-react";

export function LinkCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <SiteLink
      href={href}
      className="block my-3 p-4 rounded-lg border border-border bg-card shadow-xs hover:shadow-md transition-all no-underline"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-bold text-foreground mb-1">{title}</p>
          <p className="text-sm text-muted-foreground m-0">{description}</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </div>
    </SiteLink>
  );
}
