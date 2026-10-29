import type { Layout, ParsedAttachment, ParsedEmail } from "@webhooks-cc/sdk/email";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import type { Json } from "@/lib/supabase/database";
import { emailFieldValues, storedEmailFields } from "@/lib/email-fields";
import { planEntitlements, teamEntitlements } from "@/lib/entitlements";
import { reportError } from "@/lib/observability";
import { attachmentKey } from "@/lib/storage/attachments";
import { getObjectBytes, isObjectStorageConfigured, putObject } from "@/lib/storage/object-store";
import { clipText, fitParsed } from "./fit";
import {
  attachmentMatcher,
  chooseLayout,
  layoutFieldValues,
  lineItemsFromSheets,
  lineItemsFromText,
  storedLayouts,
  type LineItems,
} from "./layouts";
import {
  MAX_PAGES_PER_FILE,
  MAX_PARSE_BYTES,
  parserFormatFor,
  runParser,
  type ParserFormat,
  type ParserOutput,
} from "./parser";

/**
 * Parses emails for endpoints with layouts (migration 00069). capture_webhook()
 * queues a job per email instead of its deliveries; this loop leases jobs
 * (fairly: one in flight per account), picks the layout, finds its fields
 * and line items, parses the attachments it asks for in the sandboxed
 * parser, charges each file's pages once (charge_parsed_file), stores each
 * file's full parse beside the email (m/{id}/p/{index}.json, failures too,
 * so a replay or the preview reads it again instead of parsing) and
 * completes the job with its claim, which queues the deliveries.
 *
 * Every step is bounded: a job has a time budget across its files and its
 * layout work, the result kept inline is cut to about 1 MB (fit.ts), and a
 * job whose process keeps dying is given up by the claim after five tries.
 */

const POLL_MS = 1000;
const CONCURRENCY = 2;
/** Longer than the most a job can take (its budget plus a parse), so a lease never runs out mid-job. */
const LEASE_SECONDS = 600;
/** After this many tries a job completes without a result, so its deliveries still go. */
const MAX_ATTEMPTS = 5;
/** Attachments parsed per email at most. */
const MAX_FILES = 20;
/** One job's time across its files and layouts. */
const JOB_BUDGET_MS = 90_000;
/** Rows of each sheet kept in the result inline; the rest stay in the stored parse. */
const INLINE_ROWS = 1000;
const INLINE_TEXT = 256 * 1024;
const SPREADSHEETS = new Set<ParserFormat>(["csv", "tsv", "xlsx", "xls", "ods"]);

function parsedKey(requestId: string, index: number): string {
  return `m/${requestId}/p/${index}.json`;
}

export interface Account {
  userId: string | null;
  teamId: string | null;
  layoutsCap: number;
}

/** The account the email was billed to; a failed read throws, so the job is retried rather than billed to the wrong account. */
export async function accountOf(
  requestId: string,
  endpointUserId: string | null
): Promise<Account> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("requests")
    .select("team_id, user_id")
    .eq("id", requestId)
    .maybeSingle<{ team_id: string | null; user_id: string | null }>();
  if (error) throw error;
  const teamId = data?.team_id ?? null;
  if (teamId) {
    const { data: team, error: teamError } = await admin
      .from("teams")
      .select("business")
      .eq("id", teamId)
      .maybeSingle<{ business: boolean }>();
    if (teamError) throw teamError;
    return {
      userId: null,
      teamId,
      layoutsCap: teamEntitlements(team?.business ?? false).layoutsPerEndpoint,
    };
  }
  const userId = data?.user_id ?? endpointUserId;
  if (!userId) return { userId: null, teamId: null, layoutsCap: 0 };
  const { data: user, error: userError } = await admin
    .from("users")
    .select("plan")
    .eq("id", userId)
    .maybeSingle<{ plan: string }>();
  if (userError) throw userError;
  return { userId, teamId: null, layoutsCap: planEntitlements(user?.plan).layoutsPerEndpoint };
}

/** What a file's stored parse holds: the parser's output and the page cap it ran with. */
type StoredParse = ParserOutput & { maxPages?: number };

/** The summary of a parse that goes in the result (and the email JSON); fitParsed cuts it to size. */
function summary(
  index: number,
  filename: string | null,
  output: ParserOutput,
  pages: number
): ParsedAttachment {
  return {
    index,
    filename,
    format: output.format,
    pages,
    ...(output.sheets.length > 0
      ? {
          sheets: output.sheets.slice(0, 50).map((sheet) => ({
            name: sheet.name,
            rows: sheet.rows.slice(0, INLINE_ROWS),
            rowCount: sheet.rowCount,
            truncated: sheet.truncated || sheet.rows.length > INLINE_ROWS,
          })),
        }
      : {}),
    ...(output.text !== null ? { text: clipText(output.text, INLINE_TEXT) } : {}),
    truncated: output.truncated,
    error: output.error?.code ?? null,
  };
}

interface FileResult {
  parsed: ParsedAttachment;
  /** Sheets, kept only for line items read from a spreadsheet. */
  sheets: ParserOutput["sheets"];
}

interface ParseOptions {
  /** Charge and run the parser; a preview only reads stored parses. */
  mayCharge: boolean;
  /** Which attachments to parse (the line items' spreadsheet), or every parseable one. */
  only?: (filename: string | null, format: ParserFormat) => boolean;
  /** Stop after the first file whose parse has rows (line items read one spreadsheet). */
  firstWithRows?: boolean;
  /** When the job's time runs out. */
  deadline: number;
}

/** The request was deleted while it was being parsed: nothing to store or complete. */
class GoneError extends Error {}

async function requestStillExists(requestId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("requests")
    .select("id")
    .eq("id", requestId)
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  return data !== null;
}

async function pagesAvailable(account: Account): Promise<number> {
  const { data, error } = await createAdminClient().rpc("parsed_pages_available", {
    p_user_id: account.userId,
    p_team_id: account.teamId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Charges a file's pages once (charge_parsed_file); the pages newly charged, or null when refused. */
async function chargeFile(
  request: RequestRecord,
  index: number,
  account: Account,
  pages: number
): Promise<number | null> {
  const { data, error } = await createAdminClient().rpc("charge_parsed_file", {
    p_request_id: request.id,
    p_index: index,
    p_user_id: account.userId,
    p_team_id: account.teamId,
    p_pages: pages,
  });
  if (error) throw error;
  const result = data as { granted?: boolean; charged?: number } | null;
  return result?.granted ? Number(result.charged ?? 0) : null;
}

/** Parses (or reads the stored parse of) the email's attachments. */
async function parseAttachments(
  request: RequestRecord,
  account: Account,
  options: ParseOptions
): Promise<{ results: FileResult[]; pages: number }> {
  const email = request.email!;
  const results: FileResult[] = [];
  let pages = 0;
  for (const [index, attachment] of email.attachments.entries()) {
    if (results.length >= MAX_FILES) break;
    const format = parserFormatFor(attachment.filename, attachment.contentType);
    if (!format) continue;
    if (options.only && !options.only(attachment.filename, format)) continue;
    const base = { index, filename: attachment.filename, format, pages: 0 };
    // Records a file's outcome; true when the caller wants no more files.
    const keep = (parsed: ParsedAttachment, output: ParserOutput | null): boolean => {
      results.push({
        parsed,
        sheets: output && SPREADSHEETS.has(format) ? output.sheets : [],
      });
      return (
        options.firstWithRows === true &&
        output !== null &&
        output.sheets.some((sheet) => sheet.rows.length > 1)
      );
    };
    if (!email.stored || !isObjectStorageConfigured()) {
      keep({ ...base, error: "not_kept" }, null);
      continue;
    }
    if (attachment.size > MAX_PARSE_BYTES) {
      keep({ ...base, error: "too_large" }, null);
      continue;
    }

    // Parsed before (a retry, a replay or the preview): read it again,
    // unless it was cut off at a balance that has room for more now.
    const storedBytes = await getObjectBytes(parsedKey(request.id, index));
    const stored = storedBytes ? (JSON.parse(storedBytes.toString("utf8")) as StoredParse) : null;
    let available: number | null = null;
    const cutAtBalance =
      stored !== null &&
      !stored.error &&
      stored.truncated &&
      stored.maxPages !== undefined &&
      stored.maxPages < MAX_PAGES_PER_FILE;
    if (cutAtBalance && options.mayCharge) available = await pagesAvailable(account);
    if (stored && !(cutAtBalance && available !== null && available > 0)) {
      if (!options.mayCharge) {
        if (keep(summary(index, attachment.filename, stored, 0), stored)) break;
        continue;
      }
      // Charges only what this file did not pay for yet (nothing on a retry).
      const charged = await chargeFile(request, index, account, stored.error ? 0 : stored.pages);
      if (charged === null) {
        keep({ ...base, error: "limit" }, null);
        continue;
      }
      pages += charged;
      if (keep(summary(index, attachment.filename, stored, charged), stored)) break;
      continue;
    }
    if (!options.mayCharge) {
      keep({ ...base, error: "not_parsed" }, null);
      continue;
    }
    if (Date.now() > options.deadline) {
      keep({ ...base, error: "time" }, null);
      continue;
    }
    // Pages this file already paid for count toward what it may use again.
    available ??= await pagesAvailable(account);
    const paid = stored?.pages ?? 0;
    if (available + paid <= 0) {
      keep({ ...base, error: "limit" }, null);
      continue;
    }
    const bytes = await getObjectBytes(attachmentKey(request.id, index));
    if (!bytes) {
      keep({ ...base, error: "not_kept" }, null);
      continue;
    }
    const maxPages = Math.min(MAX_PAGES_PER_FILE, available + paid);
    const output = await runParser(bytes, format, maxPages, options.deadline - Date.now());
    // Stored before charging, failures too: a retry or a replay reads it
    // instead of parsing again, and charge_parsed_file charges it once.
    if (!(await requestStillExists(request.id))) throw new GoneError();
    const storedParse: StoredParse = { ...output, maxPages };
    await putObject(parsedKey(request.id, index), JSON.stringify(storedParse), "application/json");
    if (output.error || output.pages === 0) {
      if (keep(summary(index, attachment.filename, output, 0), null)) break;
      continue;
    }
    const charged = await chargeFile(request, index, account, output.pages);
    if (charged === null) {
      // Another email used the last pages meanwhile.
      keep({ ...base, error: "limit" }, null);
      continue;
    }
    pages += charged;
    if (keep(summary(index, attachment.filename, output, charged), output)) break;
  }
  return { results, pages };
}

/**
 * The parsed email for a request and its endpoint's layouts. With
 * `mayCharge` it parses and charges pages; without (the preview) it only
 * reads parses stored earlier.
 */
export async function parseEmail(
  request: RequestRecord,
  layouts: Layout[],
  emailFields: Json,
  account: Account,
  mayCharge = true,
  deadline = Date.now() + JOB_BUDGET_MS
): Promise<{ result: ParsedEmail; pages: number }> {
  const fieldValues = emailFieldValues(request, storedEmailFields(emailFields), { cache: false });
  const layout = chooseLayout(layouts, account.layoutsCap, request, fieldValues, deadline);
  if (!layout) {
    return {
      result: {
        status: "no_layout",
        layout: null,
        fields: {},
        lineItems: [],
        lineItemColumns: [],
        attachments: [],
        pages: 0,
      },
      pages: 0,
    };
  }
  const spec = layout.lineItems ?? null;
  const files =
    layout.parseAttachments === true
      ? await parseAttachments(request, account, { mayCharge, deadline })
      : spec?.from === "attachment"
        ? // Only the spreadsheet the line items read, and only until one has rows.
          await parseAttachments(request, account, {
            mayCharge,
            deadline,
            only: (filename, format) =>
              SPREADSHEETS.has(format) && attachmentMatcher(spec.attachment)(filename ?? ""),
            firstWithRows: true,
          })
        : { results: [], pages: 0 };
  let lineItems: LineItems = { rows: [], columns: [] };
  if (spec && Date.now() <= deadline) {
    lineItems =
      spec.from === "attachment"
        ? lineItemsFromSheets(
            spec,
            files.results.map((item) => ({ parsed: item.parsed, sheets: item.sheets }))
          )
        : lineItemsFromText(request, spec);
  }
  const fields = Date.now() <= deadline ? layoutFieldValues(request, layout) : {};
  return {
    result: fitParsed({
      status: "matched",
      layout: { id: layout.id, name: layout.name },
      fields,
      lineItems: lineItems.rows,
      lineItemColumns: lineItems.columns,
      attachments: files.results.map((item) => item.parsed),
      pages: files.pages,
      ...(Date.now() > deadline ? { truncated: true } : {}),
    }),
    pages: files.pages,
  };
}

type Job = { request_id: string; endpoint_id: string; attempts: number; claim: string };

async function complete(
  job: Job,
  status: "done" | "failed",
  result: ParsedEmail | null,
  pages: number,
  error: string | null = null
): Promise<void> {
  const { error: rpcError } = await createAdminClient().rpc("complete_request_parse", {
    p_request_id: job.request_id,
    p_claim: job.claim,
    p_status: status,
    p_result: result as unknown as Json,
    p_pages: pages,
    p_error: error,
  });
  if (rpcError) throw rpcError;
}

/** Parses one leased job and completes it with its claim. */
export async function parseJob(job: Job): Promise<void> {
  const admin = createAdminClient();
  try {
    const [request] = await getRequestsByIds([job.request_id]);
    const { data: endpoint, error } = await admin
      .from("endpoints")
      .select("layouts, email_fields, user_id")
      .eq("id", job.endpoint_id)
      .maybeSingle<{ layouts: Json; email_fields: Json; user_id: string | null }>();
    if (error) throw error;
    if (!request || request.kind !== "email" || !request.email || !endpoint) {
      await complete(job, "failed", null, 0, "The email or its endpoint is gone.");
      return;
    }
    const account = await accountOf(request.id, endpoint.user_id);
    const { result, pages } = await parseEmail(
      request,
      storedLayouts(endpoint.layouts),
      endpoint.email_fields,
      account
    );
    await complete(job, "done", result, pages);
  } catch (error) {
    if (error instanceof GoneError) return;
    reportError("[parsing] parse failed", error, { attempts: job.attempts });
    if (job.attempts >= MAX_ATTEMPTS) {
      // Never hold the deliveries back for good.
      await complete(job, "failed", null, 0, "The email could not be parsed.").catch(
        (completeError) => reportError("[parsing] could not complete a failed parse", completeError)
      );
    }
  }
}

async function claim(limit: number): Promise<Job[]> {
  const { data, error } = await createAdminClient().rpc("claim_request_parses", {
    p_limit: limit,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  return (data ?? []) as Job[];
}

/** Claims and parses up to `limit` jobs; resolves once all are done. */
export async function runParseBatch(limit = CONCURRENCY): Promise<number> {
  const jobs = await claim(limit);
  await Promise.all(jobs.map((job) => parseJob(job)));
  return jobs.length;
}

const globalForParsing = globalThis as unknown as { __parseWorker?: NodeJS.Timeout };

/**
 * CONCURRENCY slots, each taking the next job as soon as its last one is
 * done, so one slow email never holds back the other slot.
 */
export function startParseWorker(): void {
  if (globalForParsing.__parseWorker) return;
  let busy = 0;
  let claiming = false;
  const fill = async () => {
    if (claiming || busy >= CONCURRENCY) return;
    claiming = true;
    try {
      const jobs = await claim(CONCURRENCY - busy);
      for (const job of jobs) {
        busy++;
        void parseJob(job).finally(() => {
          busy--;
          void fill();
        });
      }
    } catch (error) {
      reportError("[parsing] claim failed", error);
    } finally {
      claiming = false;
    }
  };
  globalForParsing.__parseWorker = setInterval(() => void fill(), POLL_MS);
  globalForParsing.__parseWorker.unref();
  void fill();
}
