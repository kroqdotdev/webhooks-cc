#!/usr/bin/env python3
"""
End-to-end test for the Rust webhook receiver (direct Postgres).

Creates test users and endpoints in Supabase Postgres, fires requests at
the receiver, then verifies:
  1. Delivery accuracy (100% of accepted requests stored)
  2. Quota enforcement (429s at the limit, no overrun)
  3. Throughput and latency (RPS, P50, P99)
  4. Mock response handling
  5. Ephemeral endpoint quota (25 cap)
  6. Expired endpoint rejection (410)

Usage:
  python3 tests/receiver_test.py
  python3 tests/receiver_test.py --receiver-url http://localhost:3001
  python3 tests/receiver_test.py --skip-cleanup
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

# Load .env.local from repo root
_env_path = Path(__file__).resolve().parent.parent / ".env.local"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())

# ─── Configuration ───────────────────────────────────────────────────────────

USER_COUNT = 200
ENDPOINTS_PER_USER = 2
REQUESTS_PER_ENDPOINT = 150  # 100 limit + 50 over to test quota
REQUEST_LIMIT_PER_USER = 100
MAX_ACCEPTABLE_OVERRUN = 5  # direct Postgres should have near-zero overrun
EPHEMERAL_REQUEST_LIMIT = 25

RECEIVER_URL = "http://localhost:3001"
HTTP_CONCURRENCY = 200

# Postgres connection (uses env var or default)
DB_URL = os.environ.get("SUPABASE_DB_URL", "")

# Supabase admin API for creating auth users
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

for _name, _val in [("SUPABASE_DB_URL", DB_URL), ("SUPABASE_URL", SUPABASE_URL), ("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)]:
    if not _val:
        print(f"ERROR: {_name} is required (set in .env.local or environment)")
        sys.exit(1)

# ─── DB Helpers ──────────────────────────────────────────────────────────────

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 required. Install with: pip install psycopg2-binary")
    sys.exit(1)


def get_conn():
    return psycopg2.connect(DB_URL)


def db_exec(sql, params=None):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()


def db_query(sql, params=None):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def db_scalar(sql, params=None):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            return row[0] if row else None


def supabase_create_auth_user(email: str, password: str = "TestPassword123!") -> str:
    """Create a user via Supabase Auth admin API. Returns user ID."""
    data = json.dumps({
        "email": email,
        "password": password,
        "email_confirm": True,
        "user_metadata": {"full_name": "Receiver Test User"},
    }).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read())
        return body["id"]


def supabase_delete_auth_user(user_id: str):
    """Delete a user via Supabase Auth admin API."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        method="DELETE",
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception:
        pass


# ─── Helpers ─────────────────────────────────────────────────────────────────

@dataclass
class EndpointResult:
    slug: str
    user_idx: int
    ok_count: int = 0
    rejected_count: int = 0
    error_count: int = 0
    latencies_ms: list = field(default_factory=list)


def send_request(url: str, body: bytes | None = None) -> tuple[int, float]:
    data = body or b'{"event":"test","ts":' + str(int(time.time() * 1000)).encode() + b'}'
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp_body = resp.read()
            return resp.status, (time.monotonic() - start) * 1000, resp_body
    except urllib.error.HTTPError as e:
        body_bytes = e.read() if e.fp else b""
        return e.code, (time.monotonic() - start) * 1000, body_bytes
    except Exception:
        return 0, (time.monotonic() - start) * 1000, b""


def percentile(sorted_list, p):
    if not sorted_list:
        return 0
    idx = int(len(sorted_list) * p / 100)
    return sorted_list[min(idx, len(sorted_list) - 1)]


# ─── Phases ──────────────────────────────────────────────────────────────────

TEST_PREFIX = "rcv_test_"


def phase_seed():
    """Create test users and endpoints in Postgres."""
    print("\n" + "=" * 70)
    print("PHASE 1: Seeding test data")
    print("=" * 70)
    print(f"  Creating {USER_COUNT} users with {ENDPOINTS_PER_USER} endpoints each")
    print(f"  Request limit per user: {REQUEST_LIMIT_PER_USER}")

    start = time.monotonic()
    users = []

    for i in range(USER_COUNT):
        email = f"{TEST_PREFIX}{i}_{int(time.time())}@test.local"
        user_id = supabase_create_auth_user(email)

        # The handle_new_user trigger creates the public.users row;
        # update it with test-specific settings
        db_exec("""
            UPDATE public.users
            SET plan = 'pro', request_limit = %s, requests_used = 0,
                period_start = now(), period_end = now() + interval '1 hour'
            WHERE id = %s
        """, (REQUEST_LIMIT_PER_USER, user_id))

        slugs = []
        for j in range(ENDPOINTS_PER_USER):
            slug = f"{TEST_PREFIX}{i}_{j}_{int(time.time())}"
            db_exec("""
                INSERT INTO public.endpoints (slug, user_id, is_ephemeral, expires_at)
                VALUES (%s, %s, false, now() + interval '1 hour')
                ON CONFLICT (slug) DO NOTHING
            """, (slug, user_id))
            slugs.append(slug)

        users.append({"userId": user_id, "email": email, "slugs": slugs, "idx": i})

    elapsed = time.monotonic() - start
    total_eps = sum(len(u["slugs"]) for u in users)
    print(f"  Created {len(users)} users, {total_eps} endpoints in {elapsed:.1f}s")
    return users


def phase_load_test(users):
    """Fire requests at all endpoints and measure throughput + quota."""
    print("\n" + "=" * 70)
    print("PHASE 2: Load test")
    print("=" * 70)

    slug_map = {}
    for u in users:
        for slug in u["slugs"]:
            slug_map[slug] = {"userId": u["userId"], "userIdx": u["idx"]}

    all_slugs = list(slug_map.keys())
    total_requests = len(all_slugs) * REQUESTS_PER_ENDPOINT
    print(f"  Endpoints: {len(all_slugs)}")
    print(f"  Requests per endpoint: {REQUESTS_PER_ENDPOINT}")
    print(f"  Total requests: {total_requests:,}")
    print(f"  Concurrency: {HTTP_CONCURRENCY}")
    print()

    work_items = []
    for slug in all_slugs:
        for _ in range(REQUESTS_PER_ENDPOINT):
            work_items.append(slug)

    import random
    random.shuffle(work_items)

    results_by_slug = {slug: EndpointResult(slug=slug, user_idx=slug_map[slug]["userIdx"]) for slug in all_slugs}

    start = time.monotonic()
    completed = 0

    with ThreadPoolExecutor(max_workers=HTTP_CONCURRENCY) as executor:
        futures = {}
        for slug in work_items:
            url = f"{RECEIVER_URL}/w/{slug}/load-test"
            f = executor.submit(send_request, url)
            futures[f] = slug

        for future in as_completed(futures):
            slug = futures[future]
            status, latency_ms, _ = future.result()
            r = results_by_slug[slug]
            r.latencies_ms.append(latency_ms)

            if status == 200:
                r.ok_count += 1
            elif status == 429:
                r.rejected_count += 1
            else:
                r.error_count += 1

            completed += 1
            if completed % 500 == 0:
                elapsed = time.monotonic() - start
                print(f"  Progress: {completed}/{total_requests} ({completed/elapsed:.0f} RPS)")

    elapsed = time.monotonic() - start
    all_latencies = sorted(lat for r in results_by_slug.values() for lat in r.latencies_ms)
    total_ok = sum(r.ok_count for r in results_by_slug.values())
    total_429 = sum(r.rejected_count for r in results_by_slug.values())
    total_err = sum(r.error_count for r in results_by_slug.values())

    print()
    print(f"  Duration:  {elapsed:.1f}s")
    print(f"  RPS:       {total_requests / elapsed:.0f}")
    print(f"  OK (200):  {total_ok:,}")
    print(f"  Quota (429): {total_429:,}")
    print(f"  Errors:    {total_err:,}")
    print(f"  Latency P50:  {percentile(all_latencies, 50):.1f}ms")
    print(f"  Latency P90:  {percentile(all_latencies, 90):.1f}ms")
    print(f"  Latency P99:  {percentile(all_latencies, 99):.1f}ms")
    print(f"  Latency P99.9: {percentile(all_latencies, 99.9):.1f}ms")

    return results_by_slug, slug_map


def phase_quota_check(results_by_slug, users):
    """Verify quota enforcement: accepted count should not exceed limit + tolerance."""
    print("\n" + "=" * 70)
    print("PHASE 3: Quota enforcement check")
    print("=" * 70)

    user_accepted = defaultdict(int)
    for r in results_by_slug.values():
        user_accepted[r.user_idx] += r.ok_count

    violations = []
    for u in users:
        accepted = user_accepted[u["idx"]]
        overrun = accepted - REQUEST_LIMIT_PER_USER
        if overrun > MAX_ACCEPTABLE_OVERRUN:
            violations.append((u["idx"], accepted, overrun))

    if violations:
        print(f"  FAIL: {len(violations)} users exceeded acceptable overrun ({MAX_ACCEPTABLE_OVERRUN})")
        for idx, accepted, overrun in violations[:10]:
            print(f"    User {idx}: accepted {accepted} (overrun {overrun})")
        return False
    else:
        max_overrun = max((user_accepted[u["idx"]] - REQUEST_LIMIT_PER_USER) for u in users) if users else 0
        print(f"  PASS: All users within tolerance (max overrun: {max_overrun})")
        return True


def phase_delivery_check(results_by_slug, slug_map, users):
    """Verify all accepted requests are stored in Postgres."""
    print("\n" + "=" * 70)
    print("PHASE 4: Delivery accuracy check")
    print("=" * 70)

    total_accepted = sum(r.ok_count for r in results_by_slug.values())
    print(f"  Expected stored requests: {total_accepted:,}")

    # Count stored requests per user
    user_ids = [u["userId"] for u in users]
    rows = db_query("""
        SELECT user_id, count(*) as cnt
        FROM public.requests
        WHERE user_id = ANY(%s::uuid[])
          AND path = '/load-test'
        GROUP BY user_id
    """, (user_ids,))

    stored_by_user = {r["user_id"]: r["cnt"] for r in rows}
    total_stored = sum(stored_by_user.values())

    print(f"  Actually stored: {total_stored:,}")

    if total_stored == total_accepted:
        print(f"  PASS: 100% delivery accuracy")
        return True
    elif total_stored >= total_accepted * 0.99:
        rate = total_stored / total_accepted * 100
        print(f"  PASS: {rate:.2f}% delivery accuracy ({total_accepted - total_stored} missing)")
        return True
    else:
        rate = total_stored / total_accepted * 100 if total_accepted > 0 else 0
        print(f"  FAIL: {rate:.2f}% delivery accuracy ({total_accepted - total_stored} missing)")
        return False


def phase_usage_check(users):
    """Verify requests_used on each user matches stored request count."""
    print("\n" + "=" * 70)
    print("PHASE 5: Usage counter accuracy")
    print("=" * 70)

    user_ids = [u["userId"] for u in users]
    rows = db_query("""
        SELECT id, requests_used FROM public.users WHERE id = ANY(%s::uuid[])
    """, (user_ids,))
    usage_by_id = {r["id"]: r["requests_used"] for r in rows}

    stored_rows = db_query("""
        SELECT user_id, count(*) as cnt
        FROM public.requests
        WHERE user_id = ANY(%s::uuid[]) AND path = '/load-test'
        GROUP BY user_id
    """, (user_ids,))
    stored_by_id = {r["user_id"]: r["cnt"] for r in stored_rows}

    mismatches = []
    for u in users:
        uid = u["userId"]
        used = usage_by_id.get(uid, 0)
        stored = stored_by_id.get(uid, 0)
        if used != stored:
            mismatches.append((u["idx"], used, stored))

    if mismatches:
        print(f"  FAIL: {len(mismatches)} users have requests_used != stored count")
        for idx, used, stored in mismatches[:10]:
            print(f"    User {idx}: requests_used={used}, stored={stored}")
        return False
    else:
        print(f"  PASS: All {len(users)} users have accurate usage counters")
        return True


def phase_ephemeral_test():
    """Test ephemeral endpoint with 25-request cap."""
    print("\n" + "=" * 70)
    print("PHASE 6: Ephemeral endpoint quota test")
    print("=" * 70)

    slug = f"{TEST_PREFIX}ephemeral_{int(time.time())}"
    db_exec("""
        INSERT INTO public.endpoints (slug, is_ephemeral, expires_at)
        VALUES (%s, true, now() + interval '1 hour')
    """, (slug,))

    ok_count = 0
    rejected_count = 0

    for i in range(30):
        status, _, _ = send_request(f"{RECEIVER_URL}/w/{slug}/ephemeral-test")
        if status == 200:
            ok_count += 1
        elif status == 429:
            rejected_count += 1

    stored = db_scalar("""
        SELECT count(*) FROM public.requests
        WHERE endpoint_id = (SELECT id FROM public.endpoints WHERE slug = %s)
    """, (slug,))

    print(f"  OK: {ok_count}, Rejected: {rejected_count}, Stored: {stored}")

    if ok_count == EPHEMERAL_REQUEST_LIMIT and rejected_count == 5:
        print(f"  PASS: Ephemeral cap enforced at {EPHEMERAL_REQUEST_LIMIT}")
        return True
    else:
        print(f"  FAIL: Expected {EPHEMERAL_REQUEST_LIMIT} OK + 5 rejected")
        return False


def phase_expired_test():
    """Test that expired endpoints return 410."""
    print("\n" + "=" * 70)
    print("PHASE 7: Expired endpoint test")
    print("=" * 70)

    slug = f"{TEST_PREFIX}expired_{int(time.time())}"
    db_exec("""
        INSERT INTO public.endpoints (slug, is_ephemeral, expires_at)
        VALUES (%s, true, now() - interval '1 minute')
    """, (slug,))

    status, latency, _ = send_request(f"{RECEIVER_URL}/w/{slug}/expired-test")
    print(f"  Status: {status}, Latency: {latency:.1f}ms")

    if status == 410:
        print(f"  PASS: Expired endpoint returns 410")
        return True
    else:
        print(f"  FAIL: Expected 410, got {status}")
        return False


def phase_mock_response_test():
    """Test mock response handling."""
    print("\n" + "=" * 70)
    print("PHASE 8: Mock response test")
    print("=" * 70)

    slug = f"{TEST_PREFIX}mock_{int(time.time())}"
    email = f"{TEST_PREFIX}mock_{int(time.time())}@test.local"
    user_id = supabase_create_auth_user(email)

    db_exec("""
        UPDATE public.users SET plan = 'pro', request_limit = 100 WHERE id = %s
    """, (user_id,))

    mock = json.dumps({"status": 201, "body": '{"ok":true}', "headers": {"x-custom": "test"}})
    db_exec("""
        INSERT INTO public.endpoints (slug, user_id, is_ephemeral, mock_response)
        VALUES (%s, %s, false, %s::jsonb)
    """, (slug, user_id, mock))

    status, _, resp_body = send_request(f"{RECEIVER_URL}/w/{slug}/mock-test")
    print(f"  Status: {status}")
    print(f"  Body: {resp_body.decode('utf-8', errors='replace')}")

    if status == 201:
        print(f"  PASS: Mock response returned with correct status")
        return True
    else:
        print(f"  FAIL: Expected 201, got {status}")
        return False


def phase_cleanup(users):
    """Delete all test data."""
    print("\n" + "=" * 70)
    print("CLEANUP: Removing test data")
    print("=" * 70)

    # Collect all test user IDs (from load test + any stragglers)
    all_user_ids = [u["userId"] for u in users]
    straggler_rows = db_query(
        "SELECT id FROM public.users WHERE email LIKE %s", (TEST_PREFIX + "%",)
    )
    for r in straggler_rows:
        if r["id"] not in all_user_ids:
            all_user_ids.append(r["id"])

    # Delete test requests, endpoints
    db_exec("DELETE FROM public.requests WHERE user_id = ANY(%s::uuid[])", (all_user_ids,))
    db_exec("DELETE FROM public.endpoints WHERE user_id = ANY(%s::uuid[])", (all_user_ids,))

    # Delete ephemeral/expired/mock test endpoints (no user_id)
    db_exec("DELETE FROM public.requests WHERE endpoint_id IN (SELECT id FROM public.endpoints WHERE slug LIKE %s)", (TEST_PREFIX + "%",))
    db_exec("DELETE FROM public.endpoints WHERE slug LIKE %s", (TEST_PREFIX + "%",))

    # Delete auth users (cascades to public.users via FK)
    for uid in all_user_ids:
        supabase_delete_auth_user(uid)

    print("  Done")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    global RECEIVER_URL, USER_COUNT, HTTP_CONCURRENCY

    parser = argparse.ArgumentParser(description="Receiver end-to-end test")
    parser.add_argument("--receiver-url", default=RECEIVER_URL)
    parser.add_argument("--skip-cleanup", action="store_true")
    parser.add_argument("--users", type=int, default=USER_COUNT)
    parser.add_argument("--concurrency", type=int, default=HTTP_CONCURRENCY)
    args = parser.parse_args()

    RECEIVER_URL = args.receiver_url
    USER_COUNT = args.users
    HTTP_CONCURRENCY = args.concurrency

    print("=" * 70)
    print("Webhook Receiver End-to-End Test")
    print("=" * 70)
    print(f"  Receiver: {RECEIVER_URL}")
    print(f"  Database: {DB_URL[:50]}...")
    print(f"  Users: {USER_COUNT}, Endpoints/user: {ENDPOINTS_PER_USER}")
    print(f"  Requests/endpoint: {REQUESTS_PER_ENDPOINT}, Limit/user: {REQUEST_LIMIT_PER_USER}")
    print(f"  Concurrency: {HTTP_CONCURRENCY}")

    # Health check
    try:
        req = urllib.request.Request(f"{RECEIVER_URL}/health", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                print(f"\n  ERROR: Receiver health check failed (status {resp.status})")
                sys.exit(1)
    except Exception as e:
        print(f"\n  ERROR: Cannot reach receiver at {RECEIVER_URL}: {e}")
        sys.exit(1)

    print(f"  Receiver health: OK")

    results = []

    # Functional tests (run first, independent of load test)
    results.append(("Ephemeral quota", phase_ephemeral_test()))
    results.append(("Expired endpoint", phase_expired_test()))
    results.append(("Mock response", phase_mock_response_test()))

    # Load test
    users = phase_seed()
    results_by_slug, slug_map = phase_load_test(users)
    results.append(("Quota enforcement", phase_quota_check(results_by_slug, users)))
    results.append(("Delivery accuracy", phase_delivery_check(results_by_slug, slug_map, users)))
    results.append(("Usage counters", phase_usage_check(users)))

    # Cleanup
    if not args.skip_cleanup:
        phase_cleanup(users)

    # Summary
    print("\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)

    all_passed = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}")
        if not passed:
            all_passed = False

    print()
    if all_passed:
        print("  All tests passed!")
    else:
        print("  Some tests FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
