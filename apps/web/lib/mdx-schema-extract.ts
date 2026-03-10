// -------------------------------------------------------------------
// Extract structured data from raw MDX for JSON-LD schemas.
// Runs at build time (server component) — parses source strings,
// not rendered React trees.
// -------------------------------------------------------------------

import type { FAQItem as FAQSchemaItem, HowToStep } from "./schemas";

/**
 * Strip MDX/HTML tags, code fences, and extra whitespace from a string.
 * Returns plain text suitable for JSON-LD answer/step descriptions.
 */
function stripToText(raw: string): string {
  let result = raw
    // Remove code fences (```...```)
    .replace(/```[\s\S]*?```/g, "")
    // Strip backticks but keep inline code text
    .replace(/`([^`]+)`/g, "$1")
    // Remove markdown links but keep text: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove markdown bold/italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");

  // Remove HTML/JSX tags — loop until stable to handle nested/broken tags
  let prev;
  do {
    prev = result;
    result = result.replace(/<[^>]*>/g, "");
  } while (result !== prev);

  // Remove any remaining angle brackets (e.g. unclosed <script)
  result = result.replace(/</g, "").replace(/>/g, "");

  // Collapse whitespace
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Extract FAQ items from raw MDX source.
 * Matches `<FAQItem question="...">...content...</FAQItem>`
 */
export function extractFaqItems(source: string): FAQSchemaItem[] {
  const items: FAQSchemaItem[] = [];
  const re = /<FAQItem\s+question="([^"]+)"[^>]*>([\s\S]*?)<\/FAQItem>/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const question = match[1];
    const answer = stripToText(match[2]);
    if (question && answer) {
      items.push({ question, answer });
    }
  }
  return items;
}

/**
 * Extract HowTo steps from raw MDX source.
 * Matches `<Step title="...">...content...</Step>`
 */
export function extractHowToSteps(source: string): HowToStep[] {
  const steps: HowToStep[] = [];
  const re = /<Step\s+title="([^"]+)"[^>]*>([\s\S]*?)<\/Step>/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const text = stripToText(match[2]);
    if (name) {
      steps.push({ name, text: text || name });
    }
  }
  return steps;
}
