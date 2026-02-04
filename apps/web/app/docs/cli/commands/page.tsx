import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CLI Commands - webhooks.cc Docs",
  description: "Full command reference for the webhooks.cc CLI.",
};

interface CommandDef {
  name: string;
  description: string;
  usage: string;
  flags?: { name: string; description: string }[];
}

const COMMANDS: CommandDef[] = [
  {
    name: "auth login",
    description: "Log in to webhooks.cc. Opens your browser to verify a device code. Credentials are stored at ~/.config/whk/token.json.",
    usage: "whk auth login",
  },
  {
    name: "auth logout",
    description: "Remove stored credentials from your machine.",
    usage: "whk auth logout",
  },
  {
    name: "auth status",
    description: "Show current authentication status and email.",
    usage: "whk auth status",
  },
  {
    name: "create",
    description: "Create a new endpoint. An optional name can be provided; the slug is auto-generated.",
    usage: "whk create [name]",
  },
  {
    name: "list",
    description: "List all your endpoints with their slugs, names, and URLs.",
    usage: "whk list",
  },
  {
    name: "delete",
    description: "Delete an endpoint. Prompts for confirmation unless --force is set.",
    usage: "whk delete <slug>",
    flags: [
      { name: "--force, -f", description: "Skip the confirmation prompt" },
    ],
  },
  {
    name: "tunnel",
    description: "Forward webhooks to a local port. Creates a new endpoint unless --endpoint is set.",
    usage: "whk tunnel <port>",
    flags: [
      { name: "--endpoint", description: "Use an existing endpoint instead of creating one" },
      { name: "--ephemeral, -e", description: "Delete the endpoint when the tunnel exits" },
      { name: "--header, -H", description: "Add a custom header to forwarded requests (repeatable, format: Key:Value)" },
    ],
  },
  {
    name: "listen",
    description: "Stream incoming requests for an endpoint to the terminal without forwarding them.",
    usage: "whk listen <slug>",
  },
  {
    name: "replay",
    description: "Replay a captured request to a target URL.",
    usage: "whk replay <request-id>",
    flags: [
      { name: "--to", description: "Target URL for replay (default: http://localhost:8080)" },
    ],
  },
  {
    name: "--version",
    description: "Print the CLI version.",
    usage: "whk --version",
  },
];

export default function CommandsPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Command Reference</h1>
      <p className="text-lg text-muted-foreground mb-10">
        All available commands for the <code className="font-mono font-bold">whk</code> CLI.
      </p>

      <div className="space-y-10">
        {COMMANDS.map((cmd) => (
          <section key={cmd.name}>
            <h2 className="text-xl font-bold mb-2">
              <code className="font-mono">{cmd.name}</code>
            </h2>
            <p className="text-muted-foreground mb-3">{cmd.description}</p>
            <pre className="neo-code text-sm mb-3">{cmd.usage}</pre>
            {cmd.flags && (
              <div className="neo-code text-sm overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-foreground/20">
                      <th className="text-left py-1.5 pr-4 font-bold">Flag</th>
                      <th className="text-left py-1.5 font-bold">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmd.flags.map((flag) => (
                      <tr key={flag.name} className="border-b border-foreground/20 last:border-0">
                        <td className="py-1.5 pr-4 whitespace-nowrap">
                          <code>{flag.name}</code>
                        </td>
                        <td className="py-1.5 text-muted-foreground">{flag.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
    </article>
  );
}
