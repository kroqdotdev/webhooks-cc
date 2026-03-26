const STORAGE_PREFIX = "pinned_requests_";

function getKey(endpointSlug: string): string {
  return `${STORAGE_PREFIX}${endpointSlug}`;
}

export function getPinnedIds(endpointSlug: string): Set<string> {
  try {
    const stored = localStorage.getItem(getKey(endpointSlug));
    if (!stored) return new Set();
    return new Set(JSON.parse(stored) as string[]);
  } catch {
    return new Set();
  }
}

function persist(endpointSlug: string, ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem(getKey(endpointSlug));
    } else {
      localStorage.setItem(getKey(endpointSlug), JSON.stringify([...ids]));
    }
  } catch {
    // localStorage unavailable
  }
}

export function togglePin(endpointSlug: string, requestId: string): Set<string> {
  const ids = getPinnedIds(endpointSlug);
  if (ids.has(requestId)) {
    ids.delete(requestId);
  } else {
    ids.add(requestId);
  }
  persist(endpointSlug, ids);
  return ids;
}

export function isPinned(endpointSlug: string, requestId: string): boolean {
  return getPinnedIds(endpointSlug).has(requestId);
}
