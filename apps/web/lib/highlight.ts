import Prism from "prismjs";
Prism.manual = true;
import "prismjs/components/prism-json";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import type { BodyFormat } from "./format";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getLanguage(format: BodyFormat): "json" | "markup" | "plain" {
  if (format === "json") return "json";
  if (format === "xml") return "markup";
  return "plain";
}

export function highlightBody(body: string, format: BodyFormat): string {
  const language = getLanguage(format);
  if (language === "plain") return escapeHtml(body);
  const grammar = Prism.languages[language];
  if (!grammar) return escapeHtml(body);
  return Prism.highlight(body, grammar, language);
}

export function getHighlightLanguage(format: BodyFormat): string {
  const language = getLanguage(format);
  if (language === "plain") return "text";
  return language;
}

/** Highlight generated source; the output is escaped HTML. */
export function highlightCode(code: string, language: "typescript" | "python" | "json"): string {
  const grammar = Prism.languages[language];
  if (!grammar) return escapeHtml(code);
  return Prism.highlight(code, grammar, language);
}
