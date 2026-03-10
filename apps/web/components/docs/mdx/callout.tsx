import { Info, AlertTriangle, Lightbulb, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const CALLOUT_STYLES = {
  info: { border: "border-l-primary", icon: Info },
  warning: { border: "border-l-secondary", icon: AlertTriangle },
  tip: { border: "border-l-[hsl(142,71%,45%)]", icon: Lightbulb },
  danger: { border: "border-l-destructive", icon: ShieldAlert },
} as const;

export function Callout({
  type = "info",
  children,
}: {
  type?: keyof typeof CALLOUT_STYLES;
  children: React.ReactNode;
}) {
  const style = CALLOUT_STYLES[type];
  const Icon = style.icon;

  return (
    <div className={cn("my-6 border-2 border-foreground border-l-[6px] p-4 bg-card", style.border)}>
      <div className="flex gap-3">
        <Icon className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm [&>p]:m-0">{children}</div>
      </div>
    </div>
  );
}
