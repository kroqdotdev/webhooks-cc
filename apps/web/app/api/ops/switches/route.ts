import { aiOffered } from "@/lib/ai/model";
import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { OPS_SWITCHES, isOpsSwitchName, listSwitches, setSwitch } from "@/lib/ops/switches";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { opsBody, reasonOf } from "@/lib/tunnels/ops-request";

/** Whether the feature behind a switch is set up on this server at all. */
function configured(name: string): boolean {
  return name === "ai_assists" ? aiOffered() : true;
}

/** The email of each staff member who changed a switch; one gone reads as unknown. */
async function staffEmails(ids: (string | null)[]): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const found = await Promise.all(
    unique.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      return [id, data.user?.email ?? null] as const;
    })
  );
  return new Map(found.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}

/** Every switch: on or off, who changed it last (and their email), when and why. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  try {
    const switches = await listSwitches();
    const emails = await staffEmails(switches.map((entry) => entry.changedBy));
    return opsJson({
      switches: switches.map((entry) => {
        const about = OPS_SWITCHES.find((item) => item.name === entry.name)!;
        return {
          ...entry,
          changedByEmail: entry.changedBy ? (emails.get(entry.changedBy) ?? null) : null,
          label: about.label,
          offText: about.off,
          configured: configured(entry.name),
        };
      }),
    });
  } catch (error) {
    reportError("[ops] listing switches failed", error);
    return opsJson({ error: "The switches could not be loaded." }, { status: 500 });
  }
}

/**
 * { name, off, reason }: turns a feature off for everyone, or back on. Asking
 * for the state it already has changes and audits nothing (changed: false).
 */
export async function POST(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const body = await opsBody(request);
  if (body instanceof Response) return body;
  if (!isOpsSwitchName(body.name)) return opsJson({ error: "Unknown switch." }, { status: 400 });
  if (typeof body.off !== "boolean") {
    return opsJson({ error: "Say whether it is off (off: true or false)." }, { status: 400 });
  }
  const reason = reasonOf(body.reason);
  if (!reason) return opsJson({ error: "Say why, in a few words." }, { status: 400 });
  try {
    const saved = await setSwitch(body.name, body.off, reason, auth.userId);
    if (saved.changed) {
      await auditUserAction(request, auth.userId, {
        action: body.off ? "ops.switch_off" : "ops.switch_on",
        status: 200,
        targetId: body.name,
        reason,
      });
    }
    return opsJson({ ok: true, changed: saved.changed, switch: saved.switch });
  } catch (error) {
    reportError("[ops] changing a switch failed", error);
    return opsJson({ error: "The switch could not be changed." }, { status: 500 });
  }
}
