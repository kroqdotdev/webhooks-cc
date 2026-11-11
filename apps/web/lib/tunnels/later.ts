import { after } from "next/server";

/**
 * Runs work after the answer has gone out (Next's `after`), so the edge never
 * waits on an email. Outside a request (tests, scripts) it runs the work in
 * the background instead.
 */
export function later(work: () => Promise<unknown>): void {
  try {
    after(work);
  } catch {
    void work().catch(() => undefined);
  }
}
