import { Fragment, type ReactNode } from "react";

/**
 * The little markdown a ticket message needs: paragraphs, line breaks,
 * lists, fenced code, `inline code`, **bold**, and links. Everything becomes
 * React elements, so nothing a person writes is ever HTML; only http(s)
 * links are made clickable, and never images, which would load from an
 * address the writer chose and tell them when the message was read.
 */

type Block =
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const match = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!match) break;
        items.push(match[1]);
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function link(href: string, label: ReactNode, key: number) {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      className="text-primary underline underline-offset-2 break-words"
    >
      {label}
    </a>
  );
}

export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (match[1]) {
      nodes.push(
        <code key={key++} className="ui-code rounded-sm px-1 py-0.5 font-mono text-[0.85em]">
          {match[1].slice(1, -1)}
        </code>
      );
    } else if (match[2]) {
      nodes.push(<strong key={key++}>{match[2].slice(2, -2)}</strong>);
    } else if (match[3]) {
      const label = match[3].slice(1, match[3].indexOf("]("));
      nodes.push(link(match[4], label, key++));
    } else if (match[5]) {
      nodes.push(link(match[5], match[5], key++));
    }
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function withBreaks(text: string): ReactNode[] {
  return text.split("\n").map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {renderInline(line)}
    </Fragment>
  ));
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={className ?? "space-y-3 text-sm leading-relaxed break-words"}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="ui-code overflow-x-auto rounded-md border border-line p-3 font-mono text-xs leading-relaxed"
            >
              {block.text}
            </pre>
          );
        }
        if (block.type === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag
              key={index}
              className={block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </Tag>
          );
        }
        return <p key={index}>{withBreaks(block.text)}</p>;
      })}
    </div>
  );
}
