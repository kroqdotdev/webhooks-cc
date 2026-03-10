import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

interface NavLink {
  title: string;
  href: string;
  section: string;
}

export function PrevNextNav({ prev, next }: { prev: NavLink | null; next: NavLink | null }) {
  if (!prev && !next) return null;

  return (
    <nav aria-label="Page navigation" className="mt-16 pt-8 border-t-2 border-foreground">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {prev ? (
          <Link
            href={prev.href}
            className="group flex items-center gap-3 p-4 border-2 border-foreground bg-card shadow-neo-sm hover:shadow-neo hover:translate-x-[-2px] hover:translate-y-[-2px] transition-all no-underline"
          >
            <ArrowLeft className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
            <div className="text-right flex-1">
              <p className="text-xs text-muted-foreground mb-0.5">{prev.section}</p>
              <p className="font-bold text-foreground">{prev.title}</p>
            </div>
          </Link>
        ) : (
          <div />
        )}
        {next ? (
          <Link
            href={next.href}
            className="group flex items-center gap-3 p-4 border-2 border-foreground bg-card shadow-neo-sm hover:shadow-neo hover:translate-x-[-2px] hover:translate-y-[-2px] transition-all no-underline"
          >
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">{next.section}</p>
              <p className="font-bold text-foreground">{next.title}</p>
            </div>
            <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors ml-auto" />
          </Link>
        ) : (
          <div />
        )}
      </div>
    </nav>
  );
}
