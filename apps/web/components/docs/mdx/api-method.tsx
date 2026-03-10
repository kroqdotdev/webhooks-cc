import { cn } from "@/lib/utils";

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-primary text-primary-foreground",
  POST: "bg-secondary text-secondary-foreground",
  PUT: "bg-accent text-accent-foreground",
  PATCH: "bg-accent text-accent-foreground",
  DELETE: "bg-destructive text-destructive-foreground",
};

export function ApiMethod({
  method,
  path,
  title,
  children,
}: {
  method: string;
  path: string;
  title: string;
  children: React.ReactNode;
}) {
  const color = METHOD_COLORS[method.toUpperCase()] ?? "bg-muted text-foreground";

  return (
    <div className="my-8 border-2 border-foreground bg-card shadow-neo-sm">
      <div className="border-b-2 border-foreground p-4">
        <div className="flex items-center gap-3 mb-1">
          <span
            className={cn(
              "px-2 py-0.5 text-xs font-bold uppercase border-2 border-foreground",
              color
            )}
          >
            {method}
          </span>
          <code className="font-mono text-sm font-bold">{path}</code>
        </div>
        <h3 className="font-bold text-lg mt-2">{title}</h3>
      </div>
      <div className="p-4 [&>p]:mb-3">{children}</div>
    </div>
  );
}

export function ParamTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto my-4 [&>table]:w-full [&>table]:text-sm [&_th]:text-left [&_th]:font-bold [&_th]:py-2 [&_th]:px-3 [&_th]:border-b-2 [&_th]:border-foreground [&_td]:py-2 [&_td]:px-3 [&_td]:border-b [&_td]:border-foreground/20 [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_code]:font-mono [&_code]:border [&_code]:border-foreground/20">
      {children}
    </div>
  );
}
