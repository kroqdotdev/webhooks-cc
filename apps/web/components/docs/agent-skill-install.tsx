import Link from "next/link";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { CodeBox } from "@/components/ui/code";

export const CLAUDE_PLUGIN_INSTALL =
  "/plugin install webhooks-cc --marketplace kroqdotdev/webhooks-cc";
export const SKILLS_CLI_INSTALL = "npx skills add kroqdotdev/webhooks-cc";

function Command({ children }: { children: string }) {
  return (
    <div className="relative">
      <CopyButton text={children} />
      <CodeBox
        className="text-sm overflow-x-auto whitespace-pre-wrap break-words pr-10"
        render={<pre />}
      >
        {children}
      </CodeBox>
    </div>
  );
}

/** The Claude Code plugin and the agent skill, shown above the local server's setups. */
export function AgentSkillInstall({ headingClassName }: { headingClassName?: string }) {
  const heading = cn("font-bold mb-3", headingClassName ?? "text-lg");
  return (
    <>
      <section>
        <h3 className={heading}>Claude Code plugin</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Installs the MCP server together with the webhooks.cc skill, which tells Claude what
          webhooks.cc can do and when to reach for it: signed test sends to your local handler,
          email codes in tests, forwarding, tunnels and preview links. It runs the local server:
          Claude Code asks for your API key when you enable it; leave it empty to start in the
          keyless sandbox.
        </p>
        <Command>{CLAUDE_PLUGIN_INSTALL}</Command>
      </section>

      <section>
        <h3 className={heading}>Agent skill for Cursor, Codex, Copilot and others</h3>
        <p className="text-sm text-muted-foreground mb-3">
          The same skill for every agent that reads <code>SKILL.md</code>. Add the MCP server as
          well: the remote server above, or a local one below.
        </p>
        <Command>{SKILLS_CLI_INSTALL}</Command>
        <p className="text-sm text-muted-foreground mt-2">
          More on what the skill does:{" "}
          <Link href="/docs/mcp/skills" className="text-primary hover:underline font-bold">
            Agent skill docs
          </Link>
          .
        </p>
      </section>
    </>
  );
}
