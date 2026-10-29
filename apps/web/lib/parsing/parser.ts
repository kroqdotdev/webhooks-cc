import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Runs the attachment parser (apps/parser-rs, binary webhooks-parser) on one
 * file. The parser is a separate process that sandboxes itself (no network,
 * no files, memory and CPU limits; see its main.rs) and reads the file from
 * stdin; this side adds a wall-clock limit and a cap on what it may print.
 * Anything it cannot read comes back as an error, never an exception: a
 * crash, a timeout or a limit reads as "malformed".
 */

export type ParserFormat = "csv" | "tsv" | "xlsx" | "xls" | "ods" | "pdf" | "text";

export interface ParserSheet {
  name: string | null;
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

export interface ParserOutput {
  format: ParserFormat;
  pages: number;
  truncated: boolean;
  sheets: ParserSheet[];
  text: string | null;
  pageTexts: string[] | null;
  error: { code: string; message: string } | null;
}

/** The most pages one file may use. */
export const MAX_PAGES_PER_FILE = 100;
/** The most bytes one file may have to be parsed. */
export const MAX_PARSE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

/** The parser's path: PARSER_BIN, the copy in the image, or a local build. */
export function parserPath(): string | null {
  const candidates = [
    process.env.PARSER_BIN,
    "/app/bin/webhooks-parser",
    path.resolve(process.cwd(), "../parser-rs/target/release/webhooks-parser"),
    path.resolve(process.cwd(), "../../apps/parser-rs/target/release/webhooks-parser"),
    path.resolve(process.cwd(), "../parser-rs/target/debug/webhooks-parser"),
  ].filter((candidate): candidate is string => !!candidate);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Which parser format a file is, from its name and declared type; null when it is none. */
export function parserFormatFor(filename: string | null, contentType: string): ParserFormat | null {
  const extension = filename?.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (extension === "csv" || type === "text/csv") return "csv";
  if (extension === "tsv" || type === "text/tab-separated-values") return "tsv";
  if (
    extension === "xlsx" ||
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  if (extension === "xls" || type === "application/vnd.ms-excel") return "xls";
  if (extension === "ods" || type === "application/vnd.oasis.opendocument.spreadsheet")
    return "ods";
  if (extension === "pdf" || type === "application/pdf") return "pdf";
  if (
    ["txt", "json", "xml", "ics"].includes(extension) ||
    ["text/plain", "application/json", "application/xml", "text/xml", "text/calendar"].includes(
      type
    )
  ) {
    return "text";
  }
  return null;
}

function failed(format: ParserFormat, code: string, message: string): ParserOutput {
  return {
    format,
    pages: 0,
    truncated: false,
    sheets: [],
    text: null,
    pageTexts: null,
    error: { code, message },
  };
}

export async function runParser(
  bytes: Uint8Array,
  format: ParserFormat,
  maxPages: number
): Promise<ParserOutput> {
  const bin = parserPath();
  if (!bin) return failed(format, "unavailable", "The parser is not installed on this server.");
  if (bytes.byteLength > MAX_PARSE_BYTES)
    return failed(format, "too_large", "The file is too large to parse.");
  const pages = Math.max(1, Math.min(Math.floor(maxPages), MAX_PAGES_PER_FILE));
  return new Promise((resolve) => {
    const child = spawn(bin, ["--format", format, "--max-pages", String(pages)], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {} as NodeJS.ProcessEnv,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (output: ParserOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(failed(format, "malformed", "The file took too long to parse."));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(failed(format, "too_large", "The file has too much content to parse."));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(failed(format, "unavailable", "The parser could not start.")));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(failed(format, "malformed", "The file could not be read."));
        return;
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ParserOutput);
      } catch {
        finish(failed(format, "malformed", "The file could not be read."));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(bytes));
  });
}
