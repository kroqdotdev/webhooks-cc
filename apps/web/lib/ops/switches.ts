import { reportError } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OpsSwitchName } from "@/lib/supabase/database";

/**
 * Features staff turn off for everyone from /ops (migration 00113), without
 * a deploy or an env change. A switch is read with a short per-process
 * cache, because the reads sit on routes the dashboard calls often; what
 * must hold at once is held in SQL as well (take_ai_assist() answers
 * 'paused' while AI assists are off), so a stale cache can only show a
 * button a moment longer, never let one more ask start.
 */

export const OPS_SWITCHES: readonly {
  name: OpsSwitchName;
  label: string;
  /** What turning it off does, for the page. */
  off: string;
}[] = [
  {
    name: "ai_assists",
    label: "AI assists",
    off: "AI setup and repair are hidden everywhere, new asks are refused, and approvals agents asked for earlier are refused when approved (they can be approved again once it is back on, until they expire). No new ask starts; one already under way may finish its first request to Anthropic, but is not sent a second, and an ask cut short that way is given back. Allowances are kept.",
  },
];

export interface OpsSwitch {
  name: OpsSwitchName;
  off: boolean;
  reason: string | null;
  changedBy: string | null;
  changedAt: string | null;
}

/** How long a process trusts what it read. */
const CACHE_MS = 10_000;
const cache = new Map<OpsSwitchName, { off: boolean; until: number }>();
/**
 * Moves on every change this process makes, so a read that started before
 * the change and answers after it does not put the old state back.
 */
const generation = new Map<OpsSwitchName, number>();

const COLUMNS = "name, off, reason, changed_by, changed_at";

type Row = {
  name: OpsSwitchName;
  off: boolean;
  reason: string | null;
  changed_by: string | null;
  changed_at: string;
};

function fromRow(name: OpsSwitchName, row: Row | undefined | null): OpsSwitch {
  return {
    name,
    off: row?.off === true,
    reason: row?.reason ?? null,
    changedBy: row?.changed_by ?? null,
    changedAt: row?.changed_at ?? null,
  };
}

function remember(name: OpsSwitchName, off: boolean): void {
  cache.set(name, { off, until: Date.now() + CACHE_MS });
}

export function isOpsSwitchName(value: unknown): value is OpsSwitchName {
  return OPS_SWITCHES.some((entry) => entry.name === value);
}

/**
 * Whether a feature is switched off. A failed read counts as what was last
 * read, else as on, and is reported; it is cached like a good one, so a
 * missing table (a release before its migration) or a sick database costs
 * one read per process every 10 seconds, not one per request. The SQL side
 * refuses on its own while the row says off.
 */
export async function switchedOff(name: OpsSwitchName): Promise<boolean> {
  const cached = cache.get(name);
  if (cached && cached.until > Date.now()) return cached.off;
  const state = await readSwitch(name);
  return state === "unknown" ? (cached?.off ?? false) : state === "off";
}

/**
 * The switch as the database has it now, past the cache: for a check right
 * before something the switch stops that SQL does not guard (a second
 * request to the model). "unknown" when it could not be read, which such a
 * check treats as not on.
 */
export async function freshSwitchState(name: OpsSwitchName): Promise<"on" | "off" | "unknown"> {
  // Once more after a failed read, so a single blip does not cut an ask
  // short whose first request was already paid for.
  const state = await readSwitch(name);
  return state === "unknown" ? readSwitch(name) : state;
}

async function readSwitch(name: OpsSwitchName): Promise<"on" | "off" | "unknown"> {
  const started = generation.get(name) ?? 0;
  const { data, error } = await createAdminClient()
    .from("ops_switches")
    .select("off")
    .eq("name", name)
    .maybeSingle();
  const cached = cache.get(name);
  if (error) {
    reportError(`[ops] reading the ${name} switch failed`, error);
    // Cached too, keeping what was known, so a sick database is not read on
    // every request.
    if ((generation.get(name) ?? 0) === started) remember(name, cached?.off ?? false);
    return "unknown";
  }
  const off = data?.off === true;
  if ((generation.get(name) ?? 0) === started) remember(name, off);
  return off ? "off" : "on";
}

/** Every switch, for /ops; a missing row reads as on. */
export async function listSwitches(): Promise<OpsSwitch[]> {
  const { data, error } = await createAdminClient().from("ops_switches").select(COLUMNS);
  if (error) throw error;
  return OPS_SWITCHES.map(({ name }) =>
    fromRow(
      name,
      (data as Row[] | null)?.find((entry) => entry.name === name)
    )
  );
}

/**
 * Turns a feature off or back on, and makes this process see what the row
 * now says at once. Only a change is written: asking for the state it
 * already has (a second tab, a double click, another staff member first)
 * keeps the recorded reason and answers changed: false. A change answers
 * from the row it wrote, so nothing read after it can turn a saved change
 * into a failure the route would not audit.
 */
export async function setSwitch(
  name: OpsSwitchName,
  off: boolean,
  reason: string,
  staffId: string
): Promise<{ changed: boolean; switch: OpsSwitch }> {
  const admin = createAdminClient();
  const row = { off, reason, changed_by: staffId, changed_at: new Date().toISOString() };
  generation.set(name, (generation.get(name) ?? 0) + 1);

  const { data: updated, error } = await admin
    .from("ops_switches")
    .update(row)
    .eq("name", name)
    .eq("off", !off)
    .select(COLUMNS);
  if (error) throw error;
  let written = (updated as Row[] | null)?.[0];
  // No row yet (the migration seeds one): a missing row reads as on, so
  // only turning it off needs one.
  if (!written && off) {
    const { data: inserted, error: insertError } = await admin
      .from("ops_switches")
      .upsert({ name, ...row }, { onConflict: "name", ignoreDuplicates: true })
      .select(COLUMNS);
    if (insertError) throw insertError;
    written = (inserted as Row[] | null)?.[0];
  }
  // Moved again once the write has landed: a read that started after the
  // first move but ran before the write committed holds the old state.
  generation.set(name, (generation.get(name) ?? 0) + 1);
  if (written) {
    remember(name, written.off);
    return { changed: true, switch: fromRow(name, written) };
  }

  // Already so: what the row says, as it stands.
  const { data: current, error: readError } = await admin
    .from("ops_switches")
    .select(COLUMNS)
    .eq("name", name)
    .maybeSingle();
  if (readError) throw readError;
  const now = fromRow(name, current as Row | null);
  remember(name, now.off);
  return { changed: false, switch: now };
}

/** For tests: forget what was read. */
export function resetSwitchCache(): void {
  cache.clear();
  generation.clear();
}
