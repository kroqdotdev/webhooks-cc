import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import { later } from "@/lib/tunnels/later";
import { createFlag, tellStaffOfReport } from "@/lib/tunnels/reports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The edge saw a page that looks like phishing: a password or card field with
 * a bank or brand in the title, in the page as sent or, for a page built in
 * the browser, as a visitor's browser saw it (`seenIn: "browser"`). It becomes
 * a report for staff to look at; nothing is blocked by it.
 */
export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  const body = (await request.json().catch(() => ({}))) as {
    shareId?: unknown;
    url?: unknown;
    signals?: unknown;
    seenIn?: unknown;
  };
  if (typeof body.shareId !== "string" || !UUID.test(body.shareId) || typeof body.url !== "string")
    return Response.json({ error: "Missing shareId or url." }, { status: 400 });
  const signals = Array.isArray(body.signals)
    ? body.signals
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.slice(0, 200))
        .slice(0, 5)
    : [];
  const flag = await createFlag({
    shareId: body.shareId,
    url: body.url,
    signals: signals.length > 0 ? signals : ["signs of phishing"],
    inBrowser: body.seenIn === "browser",
  });
  if (flag) later(() => tellStaffOfReport(flag.id, "flag"));
  return Response.json({ ok: true, flagged: flag !== null });
}
