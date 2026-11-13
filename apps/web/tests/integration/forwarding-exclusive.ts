import { createClient } from "@supabase/supabase-js";

/**
 * Global setup for the forwarding suites (vitest.config.ts). They run the
 * forwarding worker themselves and assert on what it claims and sends, but
 * the queue is one table: a web server running against the same database
 * (`next dev`, which other suites need for their API calls) has its own worker
 * that claims the suites' deliveries first and sends them through the notify
 * proxy, which cannot reach the suites' local servers. The tests then fail at
 * random. So before they start, one delivery is queued to an address nothing
 * answers, and if anyone claims it while no suite is running, the run stops
 * and says why, instead of failing somewhere else later.
 */

/** Three idle polls of the worker (IDLE_POLL_MS in lib/forwarding/worker.ts). */
const WATCH_MS = 3_000;

export default async function setup(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // The suites refuse to start on their own without these.
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email: `test-forwarding-canary-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (userError) throw userError;
  const userId = created.user!.id;
  const slug = `fwd-canary-${Date.now().toString(36)}`;

  try {
    const { data: endpoint, error: endpointError } = await admin
      .from("endpoints")
      .insert({ slug, name: "forwarding canary", user_id: userId })
      .select("id")
      .single();
    if (endpointError) throw endpointError;
    const { error: destinationError } = await admin.from("endpoint_destinations").insert({
      endpoint_id: endpoint.id,
      position: 0,
      url: "http://127.0.0.1:9/forwarding-canary",
      http: true,
      email: false,
      retry_seconds: 0,
    });
    if (destinationError) throw destinationError;

    const { error: captureError } = await admin.rpc("capture_webhook", {
      p_slug: slug,
      p_method: "POST",
      p_path: "/",
      p_headers: { "content-type": "application/json" },
      p_body: "{}",
      p_query_params: {},
      p_content_type: "application/json",
      p_ip: "192.0.2.10",
      p_received_at: new Date().toISOString(),
    });
    if (captureError) throw captureError;

    const deadline = Date.now() + WATCH_MS;
    while (Date.now() < deadline) {
      const { data: rows, error } = await admin
        .from("email_deliveries")
        .select("attempts")
        .eq("endpoint_id", endpoint.id);
      if (error) throw error;
      if (rows.length === 0) {
        throw new Error("The forwarding canary queued no delivery; check its destination.");
      }
      if (rows.some((row) => row.attempts > 0)) {
        throw new Error(
          "Another forwarding worker is draining this database's queue, most likely a web " +
            "server started with `next dev`. The forwarding suites drive the worker " +
            "themselves, so start that server with EMAIL_FORWARDING_WORKER=false for " +
            "integration runs, or stop it."
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    // As the suites clean up: the counts are zeroed first, so deleting the
    // endpoint adds nothing to the site's totals (site_stats.deleted_webhooks).
    const { data: endpoint } = await admin
      .from("endpoints")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (endpoint) {
      await admin.from("requests").delete().eq("endpoint_id", endpoint.id);
      await admin.from("endpoints").update({ request_count: 0 }).eq("id", endpoint.id);
      await admin.from("endpoints").delete().eq("id", endpoint.id);
    }
    await admin.auth.admin.deleteUser(userId);
  }
}
