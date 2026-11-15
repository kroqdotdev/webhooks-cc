/**
 * Keeps only the newest of overlapping calls: each `begin()` supersedes
 * every call begun before it, and returns a check that says whether this
 * call is still the newest. A panel that reads and saves the same value
 * applies an answer only while its check passes, so a slow read begun
 * before a save never puts back what the save replaced.
 */
export function createLatestCall(): { begin(): () => boolean } {
  let newest = 0;
  return {
    begin() {
      const mine = ++newest;
      return () => mine === newest;
    },
  };
}

/**
 * Settles a write that succeeded. While it is still the newest call its
 * answer is applied. Otherwise a call begun after it superseded it, and that
 * call may have read the value before the write landed, so the value is read
 * again (a fresh, newest call) rather than left showing what the write
 * replaced.
 */
export function settleWrite(current: () => boolean, apply: () => void, reload: () => void): void {
  if (current()) apply();
  else reload();
}
