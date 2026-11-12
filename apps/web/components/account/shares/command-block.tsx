"use client";

import { CopyButton } from "@/components/ui/copy-button";
import { CodeBox } from "@/components/ui/code";

/** One shell command with a copy button, as the install and start steps show them. */
export function CommandBlock({ command }: { command: string }) {
  return (
    <div className="relative">
      <CodeBox
        className="overflow-x-auto rounded-md py-2 pl-3 pr-10 font-mono text-xs shadow-none!"
        render={<pre />}
      >
        <code>{command}</code>
      </CodeBox>
      <CopyButton
        text={command}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
      />
    </div>
  );
}
