import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { deletePrefix, isObjectStorageConfigured } from "./object-store";

/**
 * Deletes the stored objects of deleted requests. A trigger on `requests`
 * queues the prefix of every deleted row that has objects (migration 00067),
 * whatever deleted it: retention, the API, an endpoint or account going. This
 * loop leases a batch (claim_storage_deletions), deletes each prefix's objects
 * and removes the rows it finished. A failed prefix stays queued and comes
 * back when its lease runs out; the bucket's lifecycle rule is the backstop
 * for anything that never goes through.
 */

const POLL_MS = 15_000;
const BATCH = 50;
const LEASE_SECONDS = 300;

const globalForDeleter = globalThis as unknown as {
  __storageDeleter?: ReturnType<typeof setInterval>;
};

/** One pass: returns how many prefixes were deleted. */
export async function deleteQueuedObjects(limit = BATCH): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_storage_deletions", {
    p_limit: limit,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  const claims = data ?? [];
  if (claims.length === 0) return 0;

  const done: number[] = [];
  let failures = 0;
  await Promise.all(
    claims.map(async (claim) => {
      try {
        await deletePrefix(claim.prefix);
        done.push(claim.id);
      } catch {
        failures++;
      }
    })
  );
  if (failures > 0) {
    reportError("[storage] deleting stored objects failed", undefined, {
      failed: failures,
      claimed: claims.length,
    });
  }
  if (done.length > 0) {
    const { error: completeError } = await admin.rpc("complete_storage_deletions", {
      p_ids: done,
    });
    if (completeError) throw completeError;
  }
  return done.length;
}

export function startStorageDeleter(): void {
  if (globalForDeleter.__storageDeleter || !isObjectStorageConfigured()) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Drain what is due, a batch at a time, then wait for the next poll.
      while ((await deleteQueuedObjects()) === BATCH) {
        // keep going
      }
    } catch (error) {
      reportError("[storage] deletion pass failed", error);
    } finally {
      running = false;
    }
  };
  globalForDeleter.__storageDeleter = setInterval(() => void tick(), POLL_MS);
  globalForDeleter.__storageDeleter.unref();
  void tick();
}
