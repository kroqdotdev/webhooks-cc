"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { buildFixPrompt, t3CodeLink, type FixPromptDelivery } from "@/lib/fix-prompt";
import { useCopyWithFeedback } from "@/hooks/use-copy-with-feedback";
import { Button } from "@/components/ui/button";

/**
 * Under a failed delivery: hand it to a coding agent. Copy prompt is the
 * agent-neutral action (any agent with the MCP server or `whk`); Open in T3
 * Code opens the same prompt there as a draft, in the endpoint's repository
 * when one is set. The prompt holds ids and the status only (lib/fix-prompt.ts),
 * and both controls carry ph-no-capture so session recordings and autocapture
 * never keep it.
 */
export function FixPromptActions({
  delivery,
  agentRepo,
  canRedeliver = true,
}: {
  delivery: FixPromptDelivery;
  agentRepo?: string | null;
  /** Only the owner redelivers; a team member's prompt asks the owner to. */
  canRedeliver?: boolean;
}) {
  const { copy, isCopied } = useCopyWithFeedback();
  const prompt = buildFixPrompt(delivery, { canRedeliver });
  if (!prompt) return null;
  const copied = isCopied();
  return (
    <div className="mt-3.5 pt-3 border-t border-border/20 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="flex-1 min-w-[200px] text-[13px] text-muted-foreground">
        Hand it to a coding agent. The prompt names this delivery and its request by id, nothing
        more.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          type="button"
          className="ph-no-capture py-1! px-2.5! text-xs flex items-center gap-1.5"
          onClick={() => void copy(prompt)}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy prompt"}
        </Button>
        <Button
          variant="hairline"
          className="ph-no-capture py-1! px-2.5! text-xs flex items-center gap-1.5"
          render={
            <a
              href={t3CodeLink(prompt, agentRepo)}
              target="_blank"
              rel="noopener noreferrer"
              title={
                agentRepo
                  ? `Opens a draft in T3 Code for ${agentRepo}`
                  : "Opens a draft in T3 Code; set the endpoint's agent repository to pick the project"
              }
            />
          }
        >
          <ExternalLink className="h-3 w-3" />
          Open in T3 Code
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Prompt copied" : ""}
      </span>
    </div>
  );
}
