import Link from "next/link";
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
    <Link
      href={href}
      className="block my-3 p-4 border-2 border-foreground bg-card shadow-neo-sm hover:shadow-neo hover:translate-x-[-2px] hover:translate-y-[-2px] transition-all no-underline"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-bold text-foreground mb-1">{title}</p>
          <p className="text-sm text-muted-foreground m-0">{description}</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </div>
    </Link>
  );
}
