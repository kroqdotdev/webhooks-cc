import { z } from "zod";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKey, getClientIp, rateLimitIpBucket } from "@/lib/rate-limit";
import { tunnelConfig } from "@/lib/tunnels/config";
import { isReportKind } from "@/lib/tunnels/report-kinds";
import {
  confirmReceived,
  createReport,
  reportedNameOf,
  tellStaffOfReport,
} from "@/lib/tunnels/reports";
import { passedTurnstile } from "@/lib/turnstile";

/*
 * What the EU Digital Services Act (article 16) asks of a notice: why the
 * content is illegal, its exact address, the reporter's name and email, and
 * a statement made in good faith. Reports of child sexual abuse may be
 * anonymous, and need no description.
 */
const input = z
  .object({
    url: z.string().trim().min(1, "Paste the preview's address.").max(2000),
    kind: z.string().refine(isReportKind, "Choose what's wrong with it."),
    details: z.string().trim().max(2000, "Keep it under 2,000 characters."),
    name: z.string().trim().max(200, "Keep your name under 200 characters."),
    email: z.union([
      z.literal(""),
      z.string().trim().email("That email address doesn't look right.").max(320),
    ]),
    agree: z.literal(true, {
      error: "Confirm that the report is accurate to your knowledge.",
    }),
    turnstile: z.string().max(2048).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "csam") return;
    if (!v.details)
      ctx.addIssue({ code: "custom", message: "Say what you saw and why it's wrong." });
    else if (!v.name) ctx.addIssue({ code: "custom", message: "Add your name." });
    else if (!v.email) ctx.addIssue({ code: "custom", message: "Add your email." });
  });

const fail = (error: string, status = 400) => Response.json({ error }, { status });

/**
 * A report from /report: checked, kept, mailed to staff (without its
 * contents) and confirmed to the reporter. The cheap checks come first, so a
 * typo neither spends the Turnstile token nor counts against the hourly
 * limit.
 */
export async function POST(request: Request) {
  if (!tunnelConfig()) return fail("Reports are not taken here.", 404);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Send the form again.");
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const parsed = input.safeParse({
    url: typeof raw.url === "string" ? raw.url : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    details: typeof raw.details === "string" ? raw.details : "",
    name: typeof raw.name === "string" ? raw.name : "",
    email: typeof raw.email === "string" ? raw.email.trim() : "",
    agree: raw.agree === true,
    turnstile: typeof raw.turnstile === "string" ? raw.turnstile : undefined,
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const name = reportedNameOf(parsed.data.url);
  if (!name) {
    const host = tunnelConfig()?.previewOrigin.host ?? "";
    return fail(`That isn't a preview. Preview addresses end in .${host}.`);
  }
  const address = getClientIp(request);
  if (!(await passedTurnstile(parsed.data.turnstile ?? null, address)))
    return fail("The browser check didn't pass. Send the report again.", 403);
  // Counted once the browser check passed, so bots sharing a network cannot
  // use up a real reporter's allowance.
  if (await checkRateLimitByKey(`tunnels:report:${rateLimitIpBucket(address)}`, 5, 3_600_000))
    return fail(
      "You've sent several reports in the last hour. Write to support@webhooks.cc instead.",
      429
    );
  try {
    const kind = parsed.data.kind as Parameters<typeof createReport>[0]["kind"];
    const report = await createReport({
      url: parsed.data.url,
      name,
      kind,
      details: parsed.data.details,
      reporterName: parsed.data.name || null,
      reporterEmail: parsed.data.email || null,
      goodFaith: true,
      source: "form",
    });
    const [, receipt] = await Promise.all([
      tellStaffOfReport(report.id, "form", kind),
      confirmReceived(report),
    ]);
    return Response.json(
      { ok: true, receiptTo: receipt ? report.reporter_email : null },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    reportError("[report] saving a report failed", error);
    return fail("The report could not be saved. Try again, or write to support@webhooks.cc.", 500);
  }
}
