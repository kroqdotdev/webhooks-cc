/**
 * The line under AI setup that says how many assists are left. Assists
 * count over a rolling 30 days (migration 00075), not per billing period,
 * so the line says when the next one comes back rather than a reset date.
 */
export function assistsLeftText(
  info: { allowed: number; used: number; nextAt?: string | null },
  now: Date = new Date(),
  locale?: string
): string {
  const left = Math.max(info.allowed - info.used, 0);
  const next = info.nextAt ? new Date(info.nextAt) : null;
  const when = next && !Number.isNaN(next.getTime()) ? returnsAt(next, now, locale) : null;
  if (left === 0) {
    return when ? `No AI assists left. The next one comes back ${when}.` : "No AI assists left.";
  }
  const count = `${left} of ${info.allowed} AI assists left.`;
  if (info.used === 0 || !when) return `${count} Each one counts for 30 days.`;
  return `${count} Each one counts for 30 days; the next comes back ${when}.`;
}

/** "today at 14:05", "tomorrow at 09:30", "on Nov 14", or "shortly" once the time has passed. */
function returnsAt(next: Date, now: Date, locale?: string): string {
  if (next.getTime() <= now.getTime()) return "shortly";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(next) - day(now)) / 86_400_000);
  const time = next.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${next.toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}
