import type { Layout, ParsedAttachment, ParsedEmail } from "@webhooks-cc/sdk/email";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import type { Json } from "@/lib/supabase/database";
import { emailFieldValues, storedEmailFields } from "@/lib/email-fields";
import { planEntitlements, teamEntitlements } from "@/lib/entitlements";
import { reportError } from "@/lib/observability";
import { attachmentKey } from "@/lib/storage/attachments";
import { getObjectBytes, isObjectStorageConfigured, putObject } from "@/lib/storage/object-store";
import {
  chooseLayout,
  layoutFieldValues,
  lineItemsFromSheets,
  lineItemsFromText,
  storedLayouts,
} from "./layouts";
import {
  MAX_PAGES_PER_FILE,
  MAX_PARSE_BYTES,
  parserFormatFor,
  runParser,
  type ParserOutput,
} from "./parser";

/**
 * Parses emails for endpoints with layouts (migration 00069). capture_webhook()
 * queues a job per email instead of its deliveries; this loop leases jobs,
 * picks the layout, finds its fields and line items, parses the attachments
 * it asks for in the sandboxed parser (charging the pages first-come from
 * the account's allowance, credits and overage), stores the full parse of
 * each file beside the email (m/{id}/p/{index}.json, so a replay never
 * charges again) and completes the job, which queues the deliveries.
 */

const POLL_MS = 1000;
const CONCURRENCY = 2;
const LEASE_SECONDS = 120;
/** After this many tries a job completes without a result, so its deliveries still go. */
const MAX_ATTEMPTS = 5;
/** Attachments parsed per email at most. */
const MAX_FILES = 20;
/** Rows of each sheet kept in the result inline; the rest stay in the stored parse. */
const INLINE_ROWS = 1000;
const INLINE_TEXT = 256 * 1024;

function parsedKey(requestId: string, index: number): string {
  return `m/${requestId}/p/${index}.json`;
}

export interface Account {
  userId: string | null;
  teamId: string | null;
  layoutsCap: number;
}

export async function accountOf(
  requestId: string,
  endpointUserId: string | null
): Promise<Account> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("requests")
    .select("team_id, user_id")
    .eq("id", requestId)
    .maybeSingle<{ team_id: string | null; user_id: string | null }>();
  const teamId = data?.team_id ?? null;
  if (teamId) {
    const { data: team } = await admin
      .from("teams")
      .select("business")
      .eq("id", teamId)
      .maybeSingle<{ business: boolean }>();
    return {
      userId: null,
      teamId,
      layoutsCap: teamEntitlements(team?.business ?? false).layoutsPerEndpoint,
    };
  }
  const userId = data?.user_id ?? endpointUserId;
  const { data: user } = userId
    ? await admin.from("users").select("plan").eq("id", userId).maybeSingle<{ plan: string }>()
    : { data: null };
  return { userId, teamId: null, layoutsCap: planEntitlements(user?.plan).layoutsPerEndpoint };
}

/** The summary of a parse that goes in the result (and the email JSON). */
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
          sheets: output.sheets.map((sheet) => ({
            name: sheet.name,
            rows: sheet.rows.slice(0, INLINE_ROWS),
            rowCount: sheet.rowCount,
            truncated: sheet.truncated || sheet.rows.length > INLINE_ROWS,
          })),
        }
      : {}),
    ...(output.text !== null ? { text: output.text.slice(0, INLINE_TEXT) } : {}),
    truncated: output.truncated,
    error: output.error?.code ?? null,
  };
}

/**
 * Parses (or reuses the stored parse of) the email's attachments. A preview
 * (`mayCharge: false`) only reads stored parses: it never runs the parser or
 * uses pages.
 */
async function parseAttachments(
  request: RequestRecord,
  account: Account,
  mayCharge = true
): Promise<{
  results: { parsed: ParsedAttachment; output: ParserOutput | null }[];
  pages: number;
}> {
  const email = request.email!;
  const results: { parsed: ParsedAttachment; output: ParserOutput | null }[] = [];
  let pages = 0;
  const admin = createAdminClient();
  for (const [index, attachment] of email.attachments.entries()) {
    if (results.length >= MAX_FILES) break;
    const format = parserFormatFor(attachment.filename, attachment.contentType);
    if (!format) continue;
    const base = { index, filename: attachment.filename, format, pages: 0 };
    if (!email.stored || !isObjectStorageConfigured()) {
      results.push({ parsed: { ...base, error: "not_kept" }, output: null });
      continue;
    }
    if (attachment.size > MAX_PARSE_BYTES) {
      results.push({ parsed: { ...base, error: "too_large" }, output: null });
      continue;
    }
    // Parsed before (a replay): reuse it, charge nothing.
    const stored = await getObjectBytes(parsedKey(request.id, index));
    if (stored) {
      const output = JSON.parse(stored.toString("utf8")) as ParserOutput;
      results.push({ parsed: summary(index, attachment.filename, output, 0), output });
      continue;
    }
    if (!mayCharge) {
      results.push({ parsed: { ...base, error: "not_parsed" }, output: null });
      continue;
    }
    const { data: available, error } = await admin.rpc("parsed_pages_available", {
      p_user_id: account.userId,
      p_team_id: account.teamId,
    });
    if (error) throw error;
    if (!available || Number(available) <= 0) {
      results.push({ parsed: { ...base, error: "limit" }, output: null });
      continue;
    }
    const bytes = await getObjectBytes(attachmentKey(request.id, index));
    if (!bytes) {
      results.push({ parsed: { ...base, error: "not_kept" }, output: null });
      continue;
    }
    const output = await runParser(bytes, format, Math.min(MAX_PAGES_PER_FILE, Number(available)));
    if (output.error || output.pages === 0) {
      results.push({ parsed: summary(index, attachment.filename, output, 0), output: null });
      continue;
    }
    const { data: charge, error: chargeError } = await admin.rpc("take_parsed_pages", {
      p_user_id: account.userId,
      p_team_id: account.teamId,
      p_pages: output.pages,
    });
    if (chargeError) throw chargeError;
    if (!(charge as { granted?: boolean } | null)?.granted) {
      // Another email used the last pages meanwhile.
      results.push({ parsed: { ...base, error: "limit" }, output: null });
      continue;
    }
    pages += output.pages;
    await putObject(parsedKey(request.id, index), JSON.stringify(output), "application/json");
    results.push({ parsed: summary(index, attachment.filename, output, output.pages), output });
  }
  return { results, pages };
}

/** The parsed email for a request and its endpoint's layouts, charging pages as it goes. */
export async function parseEmail(
  request: RequestRecord,
  layouts: Layout[],
  emailFields: Json,
  account: Account,
  mayCharge = true
): Promise<{ result: ParsedEmail; pages: number }> {
  const fieldValues = emailFieldValues(request, storedEmailFields(emailFields), { cache: false });
  const layout = chooseLayout(layouts, account.layoutsCap, request, fieldValues);
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
  const wantsFiles = layout.parseAttachments === true || layout.lineItems?.from === "attachment";
  const files = wantsFiles
    ? await parseAttachments(request, account, mayCharge)
    : { results: [], pages: 0 };
  const spec = layout.lineItems ?? null;
  const lineItems = !spec
    ? { rows: [], columns: [] }
    : spec.from === "attachment"
      ? lineItemsFromSheets(
          spec,
          files.results.map((item) => ({ parsed: item.parsed, sheets: item.output?.sheets ?? [] }))
        )
      : lineItemsFromText(request, spec);
  return {
    result: {
      status: "matched",
      layout: { id: layout.id, name: layout.name },
      fields: layoutFieldValues(request, layout),
      lineItems: lineItems.rows,
      lineItemColumns: lineItems.columns,
      attachments: files.results.map((item) => item.parsed),
      pages: files.pages,
    },
    pages: files.pages,
  };
}

async function complete(
  requestId: string,
  status: "done" | "failed",
  result: ParsedEmail | null,
  pages: number,
  error: string | null = null
): Promise<void> {
  const { error: rpcError } = await createAdminClient().rpc("complete_request_parse", {
    p_request_id: requestId,
    p_status: status,
    p_result: result as unknown as Json,
    p_pages: pages,
    p_error: error,
  });
  if (rpcError) throw rpcError;
}

/** Parses one leased job and completes it. */
export async function parseJob(job: {
  request_id: string;
  endpoint_id: string;
  attempts: number;
}): Promise<void> {
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
      await complete(job.request_id, "failed", null, 0, "The email or its endpoint is gone.");
      return;
    }
    const account = await accountOf(request.id, endpoint.user_id);
    const { result, pages } = await parseEmail(
      request,
      storedLayouts(endpoint.layouts),
      endpoint.email_fields,
      account
    );
    await complete(job.request_id, "done", result, pages);
  } catch (error) {
    reportError("[parsing] parse failed", error, { attempts: job.attempts });
    if (job.attempts >= MAX_ATTEMPTS) {
      // Never hold the deliveries back for good.
      await complete(job.request_id, "failed", null, 0, "The email could not be parsed.").catch(
        (completeError) => reportError("[parsing] could not complete a failed parse", completeError)
      );
    }
  }
}

/** Claims and parses up to `limit` jobs; resolves once all are done. */
export async function runParseBatch(limit = CONCURRENCY): Promise<number> {
  const { data, error } = await createAdminClient().rpc("claim_request_parses", {
    p_limit: limit,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  const jobs = data ?? [];
  await Promise.all(jobs.map((job) => parseJob(job)));
  return jobs.length;
}

const globalForParsing = globalThis as unknown as { __parseWorker?: NodeJS.Timeout };

export function startParseWorker(): void {
  if (globalForParsing.__parseWorker) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while ((await runParseBatch()) === CONCURRENCY) {
        // more are due
      }
    } catch (error) {
      reportError("[parsing] claim failed", error);
    } finally {
      running = false;
    }
  };
  globalForParsing.__parseWorker = setInterval(() => void tick(), POLL_MS);
  globalForParsing.__parseWorker.unref();
  void tick();
}
