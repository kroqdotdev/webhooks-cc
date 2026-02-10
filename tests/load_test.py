#!/usr/bin/env python3
"""
End-to-end load test for the Rust webhook receiver.

Creates 500 users (2 endpoints each, limit=100 requests/user) in Convex,
seeds Redis caches, fires 150 requests per endpoint (to test quota enforcement),
then verifies:
  1. Throughput (RPS)
  2. Quota enforcement (429s appear near the limit)
  3. Overrun tolerance (no more than 50 extra requests accepted per user)
  4. All accepted requests actually land in Convex
  5. requestsUsed matches accepted count per user

Usage:
  # Make sure Convex dev, Redis, and the Rust receiver are running, then:
  python3 tests/load_test.py

  # Or with options:
  python3 tests/load_test.py --receiver-url http://localhost:3001 --skip-cleanup
"""

import argparse
import json
import random
import subprocess
import sys
import time
import urllib.request
import urllib.error
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

# ─── Configuration ───────────────────────────────────────────────────────────

USER_COUNT = 500
ENDPOINTS_PER_USER = 2
REQUESTS_PER_ENDPOINT = 150  # 100 limit + 50 over
REQUEST_LIMIT_PER_USER = 100
MAX_ACCEPTABLE_OVERRUN = 50  # burst tolerance per user

RECEIVER_URL = "http://localhost:3001"
REDIS_HOST = "127.0.0.1"
REDIS_PORT = 6380
HTTP_CONCURRENCY = 200
FLUSH_WAIT_SECS = 120  # wait for flush workers to deliver to Convex


# ─── Helpers ─────────────────────────────────────────────────────────────────

def redis_cmd(*args: str) -> str:
    """Run a redis-cli command and return stdout."""
    result = subprocess.run(
        ["redis-cli", "-h", REDIS_HOST, "-p", str(REDIS_PORT)] + list(args),
        capture_output=True, text=True
    )
    return result.stdout.strip()


def convex_run(fn: str, args_json: str = "{}", timeout: int = 600) -> dict:
    """Run a Convex function via npx convex run.

    Uses a temp file for stdout to avoid 64KB pipe buffer truncation
    on large outputs (e.g. seed returns 153KB of JSON).
    """
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.json', delete=True) as tmp:
        with open(tmp.name, 'w') as stdout_file:
            result = subprocess.run(
                ["npx", "convex", "run", fn, args_json],
                stdout=stdout_file, stderr=subprocess.PIPE,
                text=True, timeout=timeout
            )
        if result.returncode != 0:
            print(f"  convex run {fn} failed: {result.stderr[:500]}", file=sys.stderr)
            return {}

        with open(tmp.name, 'r') as f:
            output = f.read().strip()

    lines = output.split("\n")

    json_start = -1
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            json_start = i
            break

    if json_start >= 0:
        json_text = "\n".join(lines[json_start:])
        try:
            return json.loads(json_text)
        except json.JSONDecodeError:
            pass

    # Fallback: try each line individually
    for line in reversed(lines):
        line = line.strip()
        if line.startswith("{") or line.startswith("["):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return {}


@dataclass
class EndpointResult:
    slug: str
    user_idx: int
    ok_count: int = 0
    rejected_count: int = 0
    error_count: int = 0
    latencies_ms: list = field(default_factory=list)


def send_request(url: str) -> tuple[int, float]:
    """Send a POST request. Returns (status_code, latency_ms)."""
    data = b'{"event":"load_test","ts":' + str(int(time.time() * 1000)).encode() + b'}'
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
            return resp.status, (time.monotonic() - start) * 1000
    except urllib.error.HTTPError as e:
        return e.code, (time.monotonic() - start) * 1000
    except Exception:
        return 0, (time.monotonic() - start) * 1000


# ─── Phases ──────────────────────────────────────────────────────────────────

def phase_clean_redis():
    """Phase 0: Clean all Redis data for a fresh start."""
    print("\n" + "=" * 70)
    print("PHASE 0: Cleaning Redis")
    print("=" * 70)
    result = redis_cmd("FLUSHDB")
    print(f"  FLUSHDB: {result}")


def phase_seed():
    """Phase 1: Create test users and endpoints in Convex."""
    print("\n" + "=" * 70)
    print("PHASE 1: Seeding test data in Convex")
    print("=" * 70)
    print(f"  Creating {USER_COUNT} users with {ENDPOINTS_PER_USER} endpoints each...")
    print(f"  Request limit per user: {REQUEST_LIMIT_PER_USER}")
    print(f"  (seed also resets requestsUsed to 0 for all test users)")

    start = time.monotonic()
    result = convex_run("loadTest:seed")
    elapsed = time.monotonic() - start

    if not result or "users" not in result:
        print("  ERROR: Seed failed! Result:", result)
        sys.exit(1)

    users = result["users"]
    total_endpoints = sum(len(u["slugs"]) for u in users)
    print(f"  Created {len(users)} users, {total_endpoints} endpoints in {elapsed:.1f}s")

    return users


def phase_seed_redis(users):
    """Phase 2: Populate Redis caches for all endpoints."""
    print("\n" + "=" * 70)
    print("PHASE 2: Seeding Redis caches")
    print("=" * 70)

    start = time.monotonic()
    pipe_cmds = []

    seeded_user_ids = set()

    for user_data in users:
        user_id = user_data["userId"]
        slugs = user_data["slugs"]
        endpoint_ids = user_data["endpointIds"]

        for slug, ep_id in zip(slugs, endpoint_ids):
            # Endpoint cache
            ep_info = json.dumps({
                "endpointId": ep_id,
                "userId": user_id,
                "isEphemeral": False,
                "expiresAt": None,
                "mockResponse": None,
                "error": "",
            })
            pipe_cmds.append(f"SET ep:{slug} '{ep_info}' EX 600")

            # Slug-level pointer: maps slug -> userId for cache warmer
            pipe_cmds.extend([
                f"HSET quota:{slug} userId {user_id}",
                f"EXPIRE quota:{slug} 600",
            ])

        # Per-user quota key (shared across all user's endpoints)
        if user_id not in seeded_user_ids:
            seeded_user_ids.add(user_id)
            pipe_cmds.extend([
                f"HSET quota:user:{user_id} remaining {REQUEST_LIMIT_PER_USER} limit {REQUEST_LIMIT_PER_USER} periodEnd 0 isUnlimited 0 userId {user_id}",
                f"EXPIRE quota:user:{user_id} 600",
            ])

    # Execute in batches via redis-cli pipe
    batch_size = 500
    for i in range(0, len(pipe_cmds), batch_size):
        batch = pipe_cmds[i:i + batch_size]
        cmd_str = "\n".join(batch) + "\n"
        subprocess.run(
            ["redis-cli", "-h", REDIS_HOST, "-p", str(REDIS_PORT), "--pipe"],
            input=cmd_str, capture_output=True, text=True
        )

    elapsed = time.monotonic() - start
    total_slugs = sum(len(u["slugs"]) for u in users)
    print(f"  Seeded {total_slugs} endpoint caches + {len(seeded_user_ids)} user quota entries in {elapsed:.1f}s")

    return {
        slug: {
            "userId": user_data["userId"],
            "userIdx": idx,
        }
        for idx, user_data in enumerate(users)
        for slug in user_data["slugs"]
    }


def phase_load_test(slug_map):
    """Phase 3: Fire requests at all endpoints and collect results."""
    print("\n" + "=" * 70)
    print("PHASE 3: Load test")
    print("=" * 70)

    all_slugs = list(slug_map.keys())
    total_requests = len(all_slugs) * REQUESTS_PER_ENDPOINT
    print(f"  Endpoints: {len(all_slugs)}")
    print(f"  Requests per endpoint: {REQUESTS_PER_ENDPOINT}")
    print(f"  Total requests: {total_requests:,}")
    print(f"  Concurrency: {HTTP_CONCURRENCY}")
    print()

    # Build work items and shuffle for realistic concurrent multi-user load
    work = []
    for slug in all_slugs:
        for _ in range(REQUESTS_PER_ENDPOINT):
            work.append(slug)
    random.shuffle(work)

    # Track results per endpoint
    results: dict[str, EndpointResult] = {}
    for slug in all_slugs:
        results[slug] = EndpointResult(
            slug=slug,
            user_idx=slug_map[slug]["userIdx"],
        )

    print(f"  Sending {total_requests:,} requests...")
    start = time.monotonic()
    completed = 0
    last_report = start

    with ThreadPoolExecutor(max_workers=HTTP_CONCURRENCY) as pool:
        futures = {}
        for slug in work:
            url = f"{RECEIVER_URL}/w/{slug}/hook"
            future = pool.submit(send_request, url)
            futures[future] = slug

        for future in as_completed(futures):
            slug = futures[future]
            status, latency = future.result()
            r = results[slug]
            r.latencies_ms.append(latency)

            if status == 200:
                r.ok_count += 1
            elif status == 429:
                r.rejected_count += 1
            else:
                r.error_count += 1

            completed += 1

            now = time.monotonic()
            if now - last_report > 2.0:
                pct = completed / total_requests * 100
                elapsed_so_far = now - start
                current_rps = completed / elapsed_so_far
                print(f"    [{pct:5.1f}%] {completed:,}/{total_requests:,} sent @ {current_rps:,.0f} RPS")
                last_report = now

    elapsed = time.monotonic() - start
    overall_rps = total_requests / elapsed

    all_latencies = []
    total_ok = 0
    total_429 = 0
    total_err = 0
    for r in results.values():
        all_latencies.extend(r.latencies_ms)
        total_ok += r.ok_count
        total_429 += r.rejected_count
        total_err += r.error_count

    all_latencies.sort()
    p50 = all_latencies[len(all_latencies) // 2] if all_latencies else 0
    p99 = all_latencies[int(len(all_latencies) * 0.99)] if all_latencies else 0
    p999 = all_latencies[int(len(all_latencies) * 0.999)] if all_latencies else 0

    print(f"\n  --- Results ---")
    print(f"  Total time:    {elapsed:.2f}s")
    print(f"  Throughput:    {overall_rps:,.0f} RPS")
    print(f"  Total OK:      {total_ok:,}")
    print(f"  Total 429:     {total_429:,}")
    print(f"  Total errors:  {total_err:,}")
    print(f"  P50 latency:   {p50:.2f}ms")
    print(f"  P99 latency:   {p99:.2f}ms")
    print(f"  P99.9 latency: {p999:.2f}ms")

    return results


def phase_verify_quota(results, slug_map, users):
    """Phase 4: Verify quota enforcement."""
    print("\n" + "=" * 70)
    print("PHASE 4: Verifying quota enforcement")
    print("=" * 70)

    user_accepted: dict[int, int] = defaultdict(int)
    user_rejected: dict[int, int] = defaultdict(int)
    for slug, r in results.items():
        user_idx = slug_map[slug]["userIdx"]
        user_accepted[user_idx] += r.ok_count
        user_rejected[user_idx] += r.rejected_count

    quota_ok = 0
    quota_overrun = 0
    quota_underrun = 0
    worst_overrun = 0
    overrun_users = []

    for user_idx in range(len(users)):
        accepted = user_accepted.get(user_idx, 0)
        overrun = accepted - REQUEST_LIMIT_PER_USER

        if overrun > MAX_ACCEPTABLE_OVERRUN:
            quota_overrun += 1
            overrun_users.append((user_idx, accepted, overrun))
        elif overrun < 0:
            quota_underrun += 1
        else:
            quota_ok += 1

        worst_overrun = max(worst_overrun, overrun)

    print(f"  Users within quota (accepted <= {REQUEST_LIMIT_PER_USER} + {MAX_ACCEPTABLE_OVERRUN}): {quota_ok}")
    print(f"  Users under quota (accepted < {REQUEST_LIMIT_PER_USER}): {quota_underrun}")
    print(f"  Users over quota (overrun > {MAX_ACCEPTABLE_OVERRUN}): {quota_overrun}")
    print(f"  Worst overrun: {worst_overrun} requests")

    if overrun_users:
        print(f"\n  FAILED users (overrun > {MAX_ACCEPTABLE_OVERRUN}):")
        for user_idx, accepted, overrun in overrun_users[:10]:
            print(f"    User {user_idx}: accepted={accepted}, overrun={overrun}")
        if len(overrun_users) > 10:
            print(f"    ... and {len(overrun_users) - 10} more")

    overruns = [user_accepted.get(i, 0) - REQUEST_LIMIT_PER_USER for i in range(len(users))]
    overruns.sort()
    print(f"\n  Overrun distribution:")
    print(f"    Min:    {overruns[0]}")
    print(f"    P50:    {overruns[len(overruns)//2]}")
    print(f"    P90:    {overruns[int(len(overruns)*0.9)]}")
    print(f"    P99:    {overruns[int(len(overruns)*0.99)]}")
    print(f"    Max:    {overruns[-1]}")

    passed = quota_overrun == 0
    print(f"\n  Quota enforcement: {'PASS' if passed else 'FAIL'}")
    return passed


def phase_verify_delivery(results, slug_map, users):
    """Phase 5: Wait for flush workers to deliver, then verify in Convex."""
    print("\n" + "=" * 70)
    print("PHASE 5: Verifying delivery to Convex")
    print("=" * 70)

    total_ok = sum(r.ok_count for r in results.values())
    print(f"  Waiting for flush workers to deliver {total_ok:,} requests to Convex...")
    print(f"  Max wait: {FLUSH_WAIT_SECS}s")

    # Phase A: Wait for Redis buffers to drain
    for i in range(FLUSH_WAIT_SECS):
        time.sleep(1)
        active = redis_cmd("SCARD", "buf:active")
        total_buffered = 0
        if active and active != "0":
            buf_count = redis_cmd(
                "EVAL",
                "local s=redis.call('SMEMBERS','buf:active'); local t=0; "
                "for _,k in ipairs(s) do t=t+redis.call('LLEN','buf:'..k) end; return t",
                "0"
            )
            total_buffered = int(buf_count) if buf_count.lstrip('-').isdigit() else 0

        if i % 10 == 0:
            print(f"    [{i}s] Buffered: {total_buffered:,}, active slugs: {active}")

        if total_buffered == 0 and (active == "0" or not active):
            print(f"    All buffers drained after {i+1}s")
            break
    else:
        print(f"    WARNING: Timed out after {FLUSH_WAIT_SECS}s with {total_buffered:,} still buffered")

    # Phase B: Poll Convex until delivered count stabilizes.
    # Flush workers take batches from Redis (emptying the list) BEFORE sending
    # HTTP calls to Convex, so empty buffers does NOT mean all data has landed.
    # We poll a small sample until the count stops changing.
    all_slugs = list(results.keys())
    sample_size = min(50, len(all_slugs))
    sample_slugs = random.sample(all_slugs, sample_size)

    sample_expected = sum(results[s].ok_count for s in sample_slugs)
    print(f"\n  Waiting for in-flight flushes to land in Convex...")
    print(f"  (polling {sample_size} sampled endpoints, expecting ~{sample_expected:,} requests)")

    prev_count = -1
    stable_ticks = 0
    max_poll_secs = FLUSH_WAIT_SECS
    batch_size = 25

    for tick in range(max_poll_secs):
        time.sleep(5)
        current_count = 0
        for j in range(0, len(sample_slugs), batch_size):
            batch = sample_slugs[j:j + batch_size]
            counts = convex_run("loadTest:verifyBatch", json.dumps({"slugs": batch}))
            if counts:
                for slug in batch:
                    if slug in counts:
                        current_count += counts[slug]["requestCount"]

        pct = current_count / sample_expected * 100 if sample_expected > 0 else 0
        print(f"    [{tick * 5}s] Convex has {current_count:,}/{sample_expected:,} ({pct:.1f}%)")

        if current_count == prev_count:
            stable_ticks += 1
        else:
            stable_ticks = 0
        prev_count = current_count

        # Counts haven't changed for 3 consecutive polls (15s) — all flushes landed
        if stable_ticks >= 3:
            print(f"    Counts stabilized after {(tick + 1) * 5}s")
            break

        # Already at or above expected — done
        if current_count >= sample_expected:
            print(f"    All expected requests delivered")
            break
    else:
        print(f"    Max poll time reached")

    # Give Convex scheduler a few more seconds to process incrementUsage
    print(f"  Waiting 5s for Convex scheduler to process pending mutations...")
    time.sleep(5)

    # Final verification with the same sample
    print(f"\n  Final verification for {sample_size} sampled endpoints...")
    total_verified = 0
    total_expected = 0
    mismatches = []

    for i in range(0, len(sample_slugs), batch_size):
        batch = sample_slugs[i:i + batch_size]
        counts = convex_run("loadTest:verifyBatch", json.dumps({"slugs": batch}))

        if not counts:
            print(f"    WARNING: Could not verify batch starting at index {i}")
            continue

        for slug in batch:
            if slug in counts:
                actual = counts[slug]["requestCount"]
                expected = results[slug].ok_count
                total_verified += actual
                total_expected += expected

                if abs(actual - expected) > 5:
                    mismatches.append((slug, expected, actual))

    print(f"  Sampled endpoints verified: {sample_size}")
    print(f"  Expected total (sampled): {total_expected:,}")
    print(f"  Actual in Convex (sampled): {total_verified:,}")
    print(f"  Mismatches (>5 diff): {len(mismatches)}")

    if mismatches:
        print(f"\n  Mismatched endpoints:")
        for slug, expected, actual in mismatches[:10]:
            print(f"    {slug}: expected={expected}, actual={actual}, diff={actual-expected}")

    delivery_rate = total_verified / total_expected * 100 if total_expected > 0 else 0
    print(f"\n  Delivery rate: {delivery_rate:.1f}%")

    passed = delivery_rate > 95
    print(f"  Delivery check: {'PASS' if passed else 'FAIL'}")

    # Also verify requestsUsed per user (sample)
    print(f"\n  Checking requestsUsed for sampled users...")
    sample_emails = [users[i]["email"] for i in range(min(20, len(users)))]
    usage = convex_run("loadTest:verifyUsage", json.dumps({"emails": sample_emails}))
    if usage:
        usage_issues = 0
        for email in sample_emails:
            if email in usage:
                used = usage[email]["requestsUsed"]
                limit = usage[email]["requestLimit"]
                if used > limit + MAX_ACCEPTABLE_OVERRUN:
                    print(f"    WARN: {email}: requestsUsed={used}, limit={limit}")
                    usage_issues += 1
        if usage_issues == 0:
            print(f"    All {len(sample_emails)} sampled users have reasonable requestsUsed")
        else:
            print(f"    {usage_issues} users have excessive requestsUsed")

    return passed


def phase_cleanup():
    """Phase 6: Clean up test data."""
    print("\n" + "=" * 70)
    print("PHASE 6: Cleanup")
    print("=" * 70)

    print("  Flushing Redis...")
    redis_cmd("FLUSHDB")

    print("  Cleaning up Convex test data (this may take a few minutes)...")
    result = convex_run("loadTest:cleanup", timeout=600)
    if result:
        print(f"  Deleted {result.get('requestsDeleted', '?')} requests, {result.get('entitiesDeleted', '?')} entities")
    else:
        print("  WARNING: Cleanup may not have completed fully")

    print("  Done.")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    global RECEIVER_URL, FLUSH_WAIT_SECS

    parser = argparse.ArgumentParser(description="Receiver load test")
    parser.add_argument("--receiver-url", default=RECEIVER_URL, help="Receiver base URL")
    parser.add_argument("--skip-cleanup", action="store_true", help="Skip cleanup phase")
    parser.add_argument("--skip-seed", action="store_true", help="Skip seed (reuse existing data)")
    parser.add_argument("--cleanup-only", action="store_true", help="Only run cleanup")
    parser.add_argument("--flush-wait", type=int, default=FLUSH_WAIT_SECS, help="Seconds to wait for flush")
    args = parser.parse_args()

    RECEIVER_URL = args.receiver_url
    FLUSH_WAIT_SECS = args.flush_wait

    if args.cleanup_only:
        phase_cleanup()
        return

    print("=" * 70)
    print("  WEBHOOKS.CC RECEIVER LOAD TEST")
    print(f"  {USER_COUNT} users x {ENDPOINTS_PER_USER} endpoints x {REQUESTS_PER_ENDPOINT} requests")
    print(f"  = {USER_COUNT * ENDPOINTS_PER_USER * REQUESTS_PER_ENDPOINT:,} total requests")
    print(f"  Quota: {REQUEST_LIMIT_PER_USER} per user (shared across {ENDPOINTS_PER_USER} endpoints)")
    print(f"  Overrun tolerance: {MAX_ACCEPTABLE_OVERRUN}")
    print("=" * 70)

    # Verify receiver is up
    try:
        req = urllib.request.Request(f"{RECEIVER_URL}/health")
        with urllib.request.urlopen(req, timeout=5) as resp:
            health = json.loads(resp.read())
            if health.get("status") != "ok":
                print(f"  WARNING: Receiver health check: {health}")
    except Exception as e:
        print(f"  ERROR: Cannot reach receiver at {RECEIVER_URL}: {e}")
        sys.exit(1)

    # Phase 0: Clean Redis for a fresh start
    phase_clean_redis()

    # Phase 1: Seed Convex (resets requestsUsed to 0)
    if args.skip_seed:
        print("  Loading existing test data from Convex (read-only)...")
        users = convex_run("loadTest:listTestData").get("users", [])
    else:
        users = phase_seed()

    # Phase 2: Seed Redis caches
    slug_map = phase_seed_redis(users)

    # Phase 3: Load test
    results = phase_load_test(slug_map)

    # Phase 4: Verify quota enforcement
    quota_ok = phase_verify_quota(results, slug_map, users)

    # Phase 5: Verify delivery to Convex
    delivery_ok = phase_verify_delivery(results, slug_map, users)

    # Phase 6: Cleanup
    if not args.skip_cleanup:
        phase_cleanup()

    # Final verdict
    print("\n" + "=" * 70)
    print("  FINAL RESULTS")
    print("=" * 70)

    total_requests = sum(r.ok_count + r.rejected_count + r.error_count for r in results.values())
    total_ok = sum(r.ok_count for r in results.values())
    total_429 = sum(r.rejected_count for r in results.values())
    total_err = sum(r.error_count for r in results.values())
    all_latencies = sorted(lat for r in results.values() for lat in r.latencies_ms)

    print(f"  Total requests sent:  {total_requests:,}")
    print(f"  Accepted (200):       {total_ok:,}")
    print(f"  Rejected (429):       {total_429:,}")
    print(f"  Errors:               {total_err:,}")
    print(f"  Quota enforcement:    {'PASS' if quota_ok else 'FAIL'}")
    print(f"  Delivery to Convex:   {'PASS' if delivery_ok else 'FAIL'}")
    print(f"  P50 latency:          {all_latencies[len(all_latencies)//2]:.2f}ms")
    print(f"  P99 latency:          {all_latencies[int(len(all_latencies)*0.99)]:.2f}ms")
    print("=" * 70)

    if not quota_ok or not delivery_ok:
        print("\n  OVERALL: FAIL")
        sys.exit(1)
    else:
        print("\n  OVERALL: PASS")


if __name__ == "__main__":
    main()
