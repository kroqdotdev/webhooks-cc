/*
 * PostgREST takes an `.in()` filter in the GET URL and echoes the query back
 * in `Content-Location`. Past about 420 uuids that header passes undici's
 * 16 KiB cap and supabase-js answers "fetch failed"; past about 650 the
 * gateway itself refuses the URL. Lists that can grow with the number of
 * runs, accounts or names (the edge's sync, plan enforcement, ops pages) are
 * therefore read in chunks of IN_CHUNK, or passed to an RPC in the body.
 * Chunks are read one after another, so a query over chunks is not one
 * consistent read: use it only where each row stands on its own.
 */

/** The most values one `.in()` filter carries. */
export const IN_CHUNK = 200;

/** Splits a list into consecutive pieces of at most `size`. */
export function chunked<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Runs `query` once per chunk of `values` (each chunk at most `size`) and
 * joins the rows. Throws the first error. An empty list runs no query.
 */
export async function inChunks<R, E>(
  values: readonly string[],
  query: (chunk: string[]) => PromiseLike<{ data: R[] | null; error: E | null }>,
  size = IN_CHUNK
): Promise<R[]> {
  const rows: R[] = [];
  for (const chunk of chunked([...new Set(values)], size)) {
    const { data, error } = await query(chunk);
    if (error) throw error;
    if (data) rows.push(...data);
  }
  return rows;
}
