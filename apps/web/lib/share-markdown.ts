import { shareCommand, type ShareFrameworkPage } from "@/lib/share-framework-pages";

/** The canonical HTML URL of a framework's share guide. */
export function sharePageUrl(appUrl: string, slug: string): string {
  return `${appUrl}/share/${slug}`;
}

/** The markdown twin of a framework's share guide. */
export function shareMarkdownUrl(appUrl: string, slug: string): string {
  return `${appUrl}/share/${slug}.md`;
}

/** A fence long enough that the code inside cannot close it. */
function fence(code: string, language = ""): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${language}\n${code}\n${marks}`;
}

/**
 * The markdown twin of a /share/<framework> page, for agents: the same
 * content the page renders (at a glance, sections, questions, sources) as
 * plain markdown, with frontmatter naming the canonical HTML page.
 */
export function buildShareMarkdown(page: ShareFrameworkPage, appUrl: string): string {
  const command = shareCommand(page);
  const glance: [string, string][] = [
    ["Dev server", `\`${page.devCommand}\`, port ${page.port}`],
    ["Share it", `\`${command}\``],
    ["Setting to add", page.hostSetting],
    ["Without it", page.withoutIt],
    ["Hot reload", page.hotReload],
    ["URLs and cookies", page.urlsAndCookies],
  ];

  const lines: string[] = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `canonical: ${sharePageUrl(appUrl, page.slug)}`,
    `last_updated: ${page.updated}`,
    "---",
    "",
    `# ${page.h1}`,
    "",
    page.intro,
    "",
    fence(
      ["# terminal 1: the dev server", page.devCommand, "", "# terminal 2: the link", command].join(
        "\n"
      ),
      "bash"
    ),
    "",
    `The link is \`https://<name>.sharehooks.cc\` and works until you press Ctrl-C. No \`whk\` yet? [Install it and log in](${appUrl}/share#install), which takes a minute.`,
    "",
    `## ${page.label} at a glance`,
    "",
    ...glance.map(([label, value]) => `- **${label}**: ${value}`),
    "",
    `Your dev server gets each request with \`Host: localhost:${page.port}\`; the public name travels in \`X-Forwarded-Host\`, with \`X-Forwarded-Proto: https\`. [What your server sees](${appUrl}/share#what-your-server-sees) has the rest.`,
  ];

  for (const section of page.sections) {
    lines.push("", `## ${section.heading}`, "");
    lines.push(section.body.join("\n\n"));
    if (section.snippet) {
      lines.push("");
      if (section.snippet.file) lines.push(`\`${section.snippet.file}\``, "");
      lines.push(fence(section.snippet.code));
    }
    if (section.after) lines.push("", section.after);
  }

  lines.push("", `## ${page.label} questions`);
  for (const item of page.faq) lines.push("", `### ${item.question}`, "", item.answer);

  lines.push(
    "",
    "## Sources",
    "",
    `The ${page.label} settings and messages on this page are from the official documentation${page.fromSource ? " and source" : ""} for ${page.label} ${page.version}, read on ${page.checked}. What the link does to a request is from the [whk share docs](${appUrl}/docs/share).`,
    "",
    ...page.sources.map((source) => `- [${source.label}](${source.href})`)
  );

  return `${lines.join("\n")}\n`;
}
