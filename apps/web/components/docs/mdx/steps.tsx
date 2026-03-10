import { Children, isValidElement } from "react";

export function Steps({ children }: { children: React.ReactNode }) {
  const steps = Children.toArray(children).filter(isValidElement);
  return (
    <div className="my-8">
      {steps.map((child, i) => (
        <div
          key={i}
          className="relative pl-10 pb-8 border-l-2 border-foreground/20 last:border-l-0 last:pb-0"
        >
          <div className="absolute left-0 -translate-x-1/2 w-8 h-8 border-2 border-foreground bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm">
            {i + 1}
          </div>
          {child}
        </div>
      ))}
    </div>
  );
}

export function Step({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="font-bold text-lg mb-3 pt-0.5">{title}</h3>
      <div className="[&>p]:mb-3 [&>pre]:my-3">{children}</div>
    </div>
  );
}
