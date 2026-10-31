/**
 * A list someone is editing while the saved copy changes elsewhere (another
 * tab, an alert's AI repair): items edited, added or removed here stay as
 * they are here; items left alone here take the saved copy's version (or go,
 * if it removed them); items it added are appended. Matched by `key`.
 */
export function mergeEdits<T>(base: T[], local: T[], incoming: T[], key: (item: T) => string): T[] {
  const same = (a: T | undefined, b: T | undefined) => JSON.stringify(a) === JSON.stringify(b);
  const baseByKey = new Map(base.map((item) => [key(item), item]));
  const incomingByKey = new Map(incoming.map((item) => [key(item), item]));
  const localKeys = new Set(local.map(key));
  const merged: T[] = [];
  for (const item of local) {
    const before = baseByKey.get(key(item));
    if (before !== undefined && same(before, item)) {
      const now = incomingByKey.get(key(item));
      if (now !== undefined) merged.push(now);
    } else {
      merged.push(item);
    }
  }
  for (const item of incoming) {
    const k = key(item);
    if (!baseByKey.has(k) && !localKeys.has(k)) merged.push(item);
  }
  return merged;
}
