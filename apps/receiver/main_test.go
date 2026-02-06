package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

// NOTE: Tests in this file MUST NOT use t.Parallel() because they mutate
// package-level globals (convexSiteURL, httpClient, convexCircuit, etc.)
// via withMockConvex and setupTestApp. The race detector will catch violations.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// withMockConvex saves and restores the package-level globals that tests need
// to override when mocking Convex HTTP endpoints.
func withMockConvex(t *testing.T, server *httptest.Server) {
	t.Helper()
	origURL := convexSiteURL
	origSecret := captureSharedSecret
	origClient := httpClient
	origCircuit := convexCircuit

	convexSiteURL = server.URL
	captureSharedSecret = "test-secret"
	httpClient = server.Client()
	convexCircuit = newCircuitBreaker(5, 30*time.Second)

	t.Cleanup(func() {
		convexSiteURL = origURL
		captureSharedSecret = origSecret
		httpClient = origClient
		convexCircuit = origCircuit
	})
}

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

func TestIsValidSlug(t *testing.T) {
	tests := []struct {
		name  string
		slug  string
		valid bool
	}{
		{"lowercase", "abc", true},
		{"uppercase", "ABC", true},
		{"digits", "123", true},
		{"hyphen", "my-slug", true},
		{"underscore", "my_slug", true},
		{"mixed", "My-Slug_123", true},
		{"empty", "", false},
		{"too long", strings.Repeat("a", 65), false},
		{"max length", strings.Repeat("a", 64), true},
		{"path traversal dots", "../etc", false},
		{"path traversal slash", "foo/bar", false},
		{"unicode", "héllo", false},
		{"spaces", "my slug", false},
		{"special chars", "slug!", false},
		{"newline", "slug\n", false},
		{"null byte", "slug\x00", false},
		{"single char", "a", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidSlug(tt.slug)
			if got != tt.valid {
				t.Errorf("isValidSlug(%q) = %v, want %v", tt.slug, got, tt.valid)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Quota file I/O
// ---------------------------------------------------------------------------

func TestReadWriteQuotaFile(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}
	path := filepath.Join(dir, "test.json")

	// Write and read back
	want := &QuotaFile{
		Remaining:   42,
		Limit:       100,
		PeriodEnd:   1700000000000,
		LastSync:    1699999000000,
		IsUnlimited: false,
		UserID:      "user-123",
	}
	if err := store.writeQuotaFile(path, want); err != nil {
		t.Fatalf("writeQuotaFile: %v", err)
	}

	got, err := store.readQuotaFile(path)
	if err != nil {
		t.Fatalf("readQuotaFile: %v", err)
	}
	if *got != *want {
		t.Errorf("readQuotaFile roundtrip mismatch:\n  got:  %+v\n  want: %+v", got, want)
	}
}

func TestReadQuotaFile_MissingReturnsNil(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}
	path := filepath.Join(dir, "nonexistent.json")

	got, err := store.readQuotaFile(path)
	if err != nil {
		t.Fatalf("expected nil error for missing file, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil quota for missing file, got %+v", got)
	}
}

func TestReadQuotaFile_CorruptJSON(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}
	path := filepath.Join(dir, "corrupt.json")

	if err := os.WriteFile(path, []byte("not json{{{"), 0600); err != nil {
		t.Fatal(err)
	}

	_, err := store.readQuotaFile(path)
	if err == nil {
		t.Fatal("expected error for corrupt JSON, got nil")
	}
}

func TestWriteQuotaFile_Atomic(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}
	path := filepath.Join(dir, "atomic.json")

	// Write initial data
	q1 := &QuotaFile{Remaining: 10, Limit: 100}
	if err := store.writeQuotaFile(path, q1); err != nil {
		t.Fatal(err)
	}

	// Overwrite
	q2 := &QuotaFile{Remaining: 5, Limit: 100}
	if err := store.writeQuotaFile(path, q2); err != nil {
		t.Fatal(err)
	}

	got, err := store.readQuotaFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Remaining != 5 {
		t.Errorf("expected Remaining=5 after overwrite, got %d", got.Remaining)
	}
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

func TestCircuitBreaker_ClosedAllows(t *testing.T) {
	cb := newCircuitBreaker(3, 100*time.Millisecond)
	if !cb.AllowRequest() {
		t.Error("closed circuit should allow requests")
	}
	if cb.State() != "closed" {
		t.Errorf("expected closed, got %s", cb.State())
	}
}

func TestCircuitBreaker_OpensAtThreshold(t *testing.T) {
	cb := newCircuitBreaker(3, 100*time.Millisecond)

	// Two failures — still closed
	cb.RecordFailure()
	cb.RecordFailure()
	if !cb.AllowRequest() {
		t.Error("should still allow after 2 failures (threshold=3)")
	}

	// Third failure — opens
	cb.RecordFailure()
	if cb.State() != "open" {
		t.Errorf("expected open after 3 failures, got %s", cb.State())
	}
	if cb.AllowRequest() {
		t.Error("open circuit should reject")
	}
}

func TestCircuitBreaker_CooldownToHalfOpen(t *testing.T) {
	cb := newCircuitBreaker(1, 50*time.Millisecond)
	cb.RecordFailure() // opens circuit

	if cb.AllowRequest() {
		t.Error("should reject immediately after opening")
	}

	// Wait for cooldown (use generous margin for CI)
	time.Sleep(100 * time.Millisecond)

	// Should transition to half-open and allow one probe
	if !cb.AllowRequest() {
		t.Error("should allow probe after cooldown")
	}
	if cb.State() != "half-open" {
		t.Errorf("expected half-open, got %s", cb.State())
	}

	// Second request in half-open should be rejected (probe already in-flight)
	if cb.AllowRequest() {
		t.Error("should reject second request in half-open")
	}
}

func TestCircuitBreaker_ProbeSuccess_Closes(t *testing.T) {
	cb := newCircuitBreaker(1, 50*time.Millisecond)
	cb.RecordFailure()

	time.Sleep(100 * time.Millisecond)
	cb.AllowRequest() // transition to half-open

	cb.RecordSuccess()
	if cb.State() != "closed" {
		t.Errorf("expected closed after probe success, got %s", cb.State())
	}
	if !cb.AllowRequest() {
		t.Error("should allow after closing")
	}
}

func TestCircuitBreaker_ProbeFailure_Reopens(t *testing.T) {
	cb := newCircuitBreaker(1, 50*time.Millisecond)
	cb.RecordFailure()

	time.Sleep(100 * time.Millisecond)
	cb.AllowRequest() // half-open

	cb.RecordFailure()
	if cb.State() != "open" {
		t.Errorf("expected open after probe failure, got %s", cb.State())
	}
}

func TestCircuitBreaker_ProbeTimeout_AllowsNewProbe(t *testing.T) {
	cb := newCircuitBreaker(1, 50*time.Millisecond)
	cb.RecordFailure()

	time.Sleep(100 * time.Millisecond)
	cb.AllowRequest() // half-open, probe starts

	// Don't call RecordSuccess or RecordFailure — simulate lost probe
	// After cooldown, should allow new probe
	time.Sleep(100 * time.Millisecond)
	if !cb.AllowRequest() {
		t.Error("should allow new probe after probe timeout")
	}
}

func TestCircuitBreaker_SuccessResetsFailures(t *testing.T) {
	cb := newCircuitBreaker(3, 100*time.Millisecond)
	cb.RecordFailure()
	cb.RecordFailure()
	cb.RecordSuccess() // resets
	cb.RecordFailure()
	cb.RecordFailure()
	// Only 2 failures since reset, should still be closed
	if cb.State() != "closed" {
		t.Errorf("expected closed (failures reset on success), got %s", cb.State())
	}
}

func TestCircuitBreaker_IsDegraded(t *testing.T) {
	cb := newCircuitBreaker(1, 100*time.Millisecond)
	if cb.isDegraded() {
		t.Error("closed circuit should not be degraded")
	}
	cb.RecordFailure()
	if !cb.isDegraded() {
		t.Error("open circuit should be degraded")
	}
}

// ---------------------------------------------------------------------------
// Quota GetAndDecrement (with httptest mock)
// ---------------------------------------------------------------------------

func TestGetAndDecrement_CachedUnlimited(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	// Pre-write unlimited quota
	path := filepath.Join(dir, "test-slug.json")
	q := &QuotaFile{
		Remaining:   -1,
		Limit:       -1,
		LastSync:    time.Now().UnixMilli(),
		IsUnlimited: true,
		UserID:      "user-1",
	}
	if err := store.writeQuotaFile(path, q); err != nil {
		t.Fatal(err)
	}

	result := store.GetAndDecrement(context.Background(), "test-slug")
	if !result.Allowed {
		t.Error("unlimited quota should be allowed")
	}
}

func TestGetAndDecrement_Decrements(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	path := filepath.Join(dir, "dec-slug.json")
	q := &QuotaFile{
		Remaining: 3,
		Limit:     100,
		LastSync:  time.Now().UnixMilli(),
		UserID:    "user-1",
	}
	if err := store.writeQuotaFile(path, q); err != nil {
		t.Fatal(err)
	}

	result := store.GetAndDecrement(context.Background(), "dec-slug")
	if !result.Allowed {
		t.Error("should be allowed with remaining=3")
	}

	// Read back and check decrement
	got, err := store.readQuotaFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Remaining != 2 {
		t.Errorf("expected Remaining=2 after decrement, got %d", got.Remaining)
	}
}

func TestGetAndDecrement_ZeroRemaining(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	path := filepath.Join(dir, "zero-slug.json")
	q := &QuotaFile{
		Remaining: 0,
		Limit:     100,
		PeriodEnd: time.Now().Add(1 * time.Hour).UnixMilli(),
		LastSync:  time.Now().UnixMilli(),
		UserID:    "user-1",
	}
	if err := store.writeQuotaFile(path, q); err != nil {
		t.Fatal(err)
	}

	result := store.GetAndDecrement(context.Background(), "zero-slug")
	if result.Allowed {
		t.Error("should be denied with remaining=0")
	}
	if result.RetryAfter <= 0 {
		t.Error("expected positive RetryAfter for quota exceeded with future PeriodEnd")
	}
}

func TestGetAndDecrement_InvalidSlug_FailOpen(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	result := store.GetAndDecrement(context.Background(), "../traversal")
	if !result.Allowed {
		t.Error("invalid slug should fail-open")
	}
}

func TestGetAndDecrement_StaleRefreshesFromConvex(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/quota") {
			json.NewEncoder(w).Encode(QuotaResponse{
				UserID:    "user-fresh",
				Remaining: 50,
				Limit:     100,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	// Write stale quota (LastSync far in the past)
	path := filepath.Join(dir, "stale-slug.json")
	q := &QuotaFile{
		Remaining: 10,
		Limit:     100,
		LastSync:  time.Now().Add(-5 * time.Minute).UnixMilli(),
		UserID:    "user-old",
	}
	if err := store.writeQuotaFile(path, q); err != nil {
		t.Fatal(err)
	}

	result := store.GetAndDecrement(context.Background(), "stale-slug")
	if !result.Allowed {
		t.Error("should be allowed after refresh from Convex")
	}

	// Verify it fetched fresh data
	got, err := store.readQuotaFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Remaining != 49 { // 50 - 1 decrement
		t.Errorf("expected Remaining=49 after fresh fetch + decrement, got %d", got.Remaining)
	}
}

func TestGetAndDecrement_CircuitOpen_NoCachedData_FailClosed(t *testing.T) {
	// Set up a circuit that's already open
	origCircuit := convexCircuit
	convexCircuit = newCircuitBreaker(1, 1*time.Hour)
	convexCircuit.RecordFailure() // open the circuit
	t.Cleanup(func() {
		convexCircuit = origCircuit
	})

	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	// No cached data + circuit open = fail-closed
	result := store.GetAndDecrement(context.Background(), "no-cache-slug")
	if result.Allowed {
		t.Error("should fail-closed when circuit is open and no cached data")
	}
}

func TestGetAndDecrement_NeedsPeriodStart_CallsCheckPeriod(t *testing.T) {
	var checkPeriodCalled atomic.Int32
	periodEnd := time.Now().Add(24 * time.Hour).UnixMilli()
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/check-period") {
			checkPeriodCalled.Add(1)
			json.NewEncoder(w).Encode(CheckPeriodResponse{
				Remaining: 200,
				Limit:     200,
				PeriodEnd: &periodEnd,
			})
			return
		}
		if strings.Contains(r.URL.Path, "/quota") {
			plan := "free"
			json.NewEncoder(w).Encode(QuotaResponse{
				UserID:           "user-free",
				Remaining:        200,
				Limit:            200,
				NeedsPeriodStart: true,
				Plan:             &plan,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	result := store.GetAndDecrement(context.Background(), "period-slug")
	if !result.Allowed {
		t.Error("should be allowed after period start")
	}

	if checkPeriodCalled.Load() != 1 {
		t.Errorf("expected check-period to be called once, got %d", checkPeriodCalled.Load())
	}

	// Verify the quota file was written with check-period response values
	got, err := store.readQuotaFile(filepath.Join(dir, "period-slug.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Remaining != 199 { // 200 - 1 decrement
		t.Errorf("expected Remaining=199, got %d", got.Remaining)
	}
	if got.PeriodEnd != periodEnd {
		t.Errorf("expected PeriodEnd=%d, got %d", periodEnd, got.PeriodEnd)
	}
}

// ---------------------------------------------------------------------------
// Request batcher
// ---------------------------------------------------------------------------

func TestBatcherAdd_BufferLimitDropsOldest(t *testing.T) {
	b := NewRequestBatcher(9999, 1*time.Hour) // high maxSize to prevent auto-flush

	slug := "test-slug"
	// Fill to batchMaxPerSlug
	for i := 0; i < batchMaxPerSlug; i++ {
		b.Add(slug, BufferedRequest{Method: "GET", IP: fmt.Sprintf("ip-%d", i)})
	}

	b.mu.Lock()
	if len(b.buffers[slug]) != batchMaxPerSlug {
		t.Errorf("expected buffer at %d, got %d", batchMaxPerSlug, len(b.buffers[slug]))
	}
	firstIP := b.buffers[slug][0].IP
	b.mu.Unlock()

	// Add one more — oldest should be dropped
	b.Add(slug, BufferedRequest{Method: "POST", IP: "ip-new"})

	b.mu.Lock()
	if len(b.buffers[slug]) != batchMaxPerSlug {
		t.Errorf("expected buffer still at %d, got %d", batchMaxPerSlug, len(b.buffers[slug]))
	}
	newFirstIP := b.buffers[slug][0].IP
	b.mu.Unlock()

	if newFirstIP == firstIP {
		t.Error("oldest request should have been dropped")
	}
}

func TestBatcherAdd_FlushAtMaxSize(t *testing.T) {
	var mu sync.Mutex
	var received []BufferedRequest
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Slug     string            `json:"slug"`
			Requests []BufferedRequest `json:"requests"`
		}
		json.Unmarshal(body, &payload)
		mu.Lock()
		received = append(received, payload.Requests...)
		mu.Unlock()
		json.NewEncoder(w).Encode(CaptureResponse{Success: true, Inserted: len(payload.Requests)})
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	b := NewRequestBatcher(batchMaxSize, 1*time.Hour) // long interval to prevent timer flush

	slug := "flush-test"
	for i := 0; i < batchMaxSize; i++ {
		b.Add(slug, BufferedRequest{Method: "POST", IP: fmt.Sprintf("ip-%d", i)})
	}

	// Wait for the async flush goroutine
	b.Wait()

	// Buffer should be empty after flush
	b.mu.Lock()
	remaining := len(b.buffers[slug])
	b.mu.Unlock()

	if remaining != 0 {
		t.Errorf("expected empty buffer after flush, got %d", remaining)
	}

	mu.Lock()
	if len(received) != batchMaxSize {
		t.Errorf("expected %d requests sent, got %d", batchMaxSize, len(received))
	}
	mu.Unlock()
}

func TestBatcherAdd_MultipleSlugsIndependent(t *testing.T) {
	b := NewRequestBatcher(9999, 1*time.Hour)

	b.Add("slug-a", BufferedRequest{Method: "GET"})
	b.Add("slug-a", BufferedRequest{Method: "GET"})
	b.Add("slug-b", BufferedRequest{Method: "POST"})

	b.mu.Lock()
	lenA := len(b.buffers["slug-a"])
	lenB := len(b.buffers["slug-b"])
	b.mu.Unlock()

	if lenA != 2 {
		t.Errorf("slug-a: expected 2, got %d", lenA)
	}
	if lenB != 1 {
		t.Errorf("slug-b: expected 1, got %d", lenB)
	}
}

// ---------------------------------------------------------------------------
// Endpoint cache
// ---------------------------------------------------------------------------

func TestEndpointCache_Hit(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(EndpointInfo{
			EndpointID:  "ep-123",
			IsEphemeral: true,
		})
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := NewEndpointCache(ctx, 1*time.Hour)

	// First call — fetches from mock
	info1, err := cache.Get(context.Background(), "test-slug")
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}
	if info1.EndpointID != "ep-123" {
		t.Errorf("expected ep-123, got %s", info1.EndpointID)
	}

	// Second call — should be cache hit (no HTTP call)
	info2, err := cache.Get(context.Background(), "test-slug")
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if info2.EndpointID != "ep-123" {
		t.Errorf("expected ep-123 from cache, got %s", info2.EndpointID)
	}
}

func TestEndpointCache_TTLExpiry(t *testing.T) {
	var callCount atomic.Int32
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		json.NewEncoder(w).Encode(EndpointInfo{
			EndpointID: fmt.Sprintf("ep-%d", n),
		})
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := NewEndpointCache(ctx, 50*time.Millisecond)

	info1, err := cache.Get(context.Background(), "ttl-test")
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}
	if info1.EndpointID != "ep-1" {
		t.Errorf("expected ep-1, got %s", info1.EndpointID)
	}

	// Wait for TTL to expire (generous margin for CI)
	time.Sleep(100 * time.Millisecond)

	info2, err := cache.Get(context.Background(), "ttl-test")
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if info2.EndpointID != "ep-2" {
		t.Errorf("expected ep-2 after TTL expiry, got %s", info2.EndpointID)
	}
}

func TestEndpointCache_ErrorDoesNotCache(t *testing.T) {
	var callCount atomic.Int32
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n == 1 {
			json.NewEncoder(w).Encode(EndpointInfo{
				Error: "not_found",
			})
			return
		}
		json.NewEncoder(w).Encode(EndpointInfo{
			EndpointID: "ep-found",
		})
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := NewEndpointCache(ctx, 1*time.Hour)

	// First call returns not_found — should NOT be cached
	info1, err := cache.Get(context.Background(), "err-slug")
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}
	if info1.Error != "not_found" {
		t.Errorf("expected not_found, got %+v", info1)
	}

	// Second call should fetch again (not return cached error)
	info2, err := cache.Get(context.Background(), "err-slug")
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if info2.EndpointID != "ep-found" {
		t.Errorf("expected ep-found on retry, got %+v", info2)
	}
}

func TestEndpointCache_Cleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := NewEndpointCache(ctx, 10*time.Millisecond)

	// Manually insert a stale entry
	cache.mu.Lock()
	cache.entries["stale"] = &EndpointInfo{
		EndpointID: "old",
		LastSync:   time.Now().Add(-1 * time.Hour),
	}
	cache.mu.Unlock()

	cache.cleanup()

	cache.mu.RLock()
	_, exists := cache.entries["stale"]
	cache.mu.RUnlock()

	if exists {
		t.Error("stale entry should have been removed by cleanup")
	}
}

func TestEndpointCache_SingleFlight(t *testing.T) {
	var callCount atomic.Int32
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		time.Sleep(50 * time.Millisecond) // simulate slow response
		json.NewEncoder(w).Encode(EndpointInfo{
			EndpointID: "ep-single",
		})
	}))
	defer mockServer.Close()
	withMockConvex(t, mockServer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := NewEndpointCache(ctx, 1*time.Hour)

	// Launch multiple concurrent requests for the same slug
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info, err := cache.Get(context.Background(), "dedup-slug")
			if err != nil {
				t.Errorf("Get: %v", err)
			}
			if info.EndpointID != "ep-single" {
				t.Errorf("expected ep-single, got %s", info.EndpointID)
			}
		}()
	}
	wg.Wait()

	if n := callCount.Load(); n != 1 {
		t.Errorf("expected 1 HTTP call (single-flight), got %d", n)
	}
}

// ---------------------------------------------------------------------------
// Header filtering in handleWebhook
// ---------------------------------------------------------------------------

func setupTestApp(t *testing.T) *fiber.App {
	t.Helper()

	origCircuit := convexCircuit
	origBatcher := requestBatcher
	origCache := endpointCache
	origQuota := quotaStore

	convexCircuit = newCircuitBreaker(5, 30*time.Second)
	requestBatcher = NewRequestBatcher(batchMaxSize, 1*time.Hour)

	ctx, cancel := context.WithCancel(context.Background())

	quotaDir := t.TempDir()
	quotaStore = &FileQuotaStore{dir: quotaDir}

	t.Cleanup(func() {
		cancel()
		convexCircuit = origCircuit
		requestBatcher = origBatcher
		endpointCache = origCache
		quotaStore = origQuota
	})

	endpointCache = NewEndpointCache(ctx, 1*time.Hour)

	app := fiber.New(fiber.Config{
		BodyLimit: maxBodySize,
	})
	app.All("/w/:slug/*", handleWebhook)
	return app
}

func preloadEndpointCache(t *testing.T, slug string, info *EndpointInfo) {
	t.Helper()
	info.LastSync = time.Now()
	endpointCache.mu.Lock()
	endpointCache.entries[slug] = info
	endpointCache.mu.Unlock()
}

func preloadQuota(t *testing.T, slug string) {
	t.Helper()
	path := filepath.Join(quotaStore.dir, slug+".json")
	q := &QuotaFile{
		Remaining:   1000,
		Limit:       10000,
		LastSync:    time.Now().UnixMilli(),
		IsUnlimited: true,
		UserID:      "test-user",
	}
	if err := quotaStore.writeQuotaFile(path, q); err != nil {
		t.Fatal(err)
	}
}

func TestHandleWebhook_BlockedHeaders(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "header-test", &EndpointInfo{
		EndpointID: "ep-1",
		MockResponse: &MockResponse{
			Status: 200,
			Body:   "OK",
			Headers: map[string]string{
				"X-Custom":                  "allowed",
				"Set-Cookie":                "sessionid=abc",
				"Strict-Transport-Security": "max-age=31536000",
				"Content-Security-Policy":   "default-src 'self'",
				"X-Frame-Options":           "DENY",
			},
		},
	})
	preloadQuota(t, "header-test")

	req := httptest.NewRequest("GET", "/w/header-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	// Custom header should be present
	if resp.Header.Get("X-Custom") != "allowed" {
		t.Errorf("expected X-Custom=allowed, got %q", resp.Header.Get("X-Custom"))
	}

	// Blocked headers should NOT be present
	blockedHeaders := []string{"Set-Cookie", "Strict-Transport-Security", "Content-Security-Policy", "X-Frame-Options"}
	for _, h := range blockedHeaders {
		if v := resp.Header.Get(h); v != "" {
			t.Errorf("blocked header %s should not be present, got %q", h, v)
		}
	}
}

func TestHandleWebhook_CRLFInjection(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "crlf-test", &EndpointInfo{
		EndpointID: "ep-2",
		MockResponse: &MockResponse{
			Status: 200,
			Body:   "OK",
			Headers: map[string]string{
				"X-Clean":    "good",
				"X-Injected": "bad\r\nInjected-Header: evil",
				"X-Key\r\n":  "bad-key",
			},
		},
	})
	preloadQuota(t, "crlf-test")

	req := httptest.NewRequest("GET", "/w/crlf-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.Header.Get("X-Clean") != "good" {
		t.Errorf("X-Clean should be present")
	}
	if v := resp.Header.Get("X-Injected"); v != "" {
		t.Errorf("CRLF-injected header should be stripped, got %q", v)
	}
	if v := resp.Header.Get("Injected-Header"); v != "" {
		t.Errorf("CRLF-smuggled Injected-Header should not be present, got %q", v)
	}
}

func TestHandleWebhook_OversizedHeaders(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "oversize-test", &EndpointInfo{
		EndpointID: "ep-3",
		MockResponse: &MockResponse{
			Status: 200,
			Body:   "OK",
			Headers: map[string]string{
				"X-Normal":   "ok",
				"X-Long-Key": strings.Repeat("x", maxHeaderValueLen+1),
				strings.Repeat("k", maxHeaderKeyLen+1): "too-long-key",
			},
		},
	})
	preloadQuota(t, "oversize-test")

	req := httptest.NewRequest("GET", "/w/oversize-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.Header.Get("X-Normal") != "ok" {
		t.Errorf("normal header should be present")
	}
	// Oversized value header should be stripped
	if v := resp.Header.Get("X-Long-Key"); v != "" {
		t.Errorf("header with oversized value should be stripped, got %d chars", len(v))
	}
	// Oversized key header should be stripped
	for k := range resp.Header {
		if len(k) > maxHeaderKeyLen {
			t.Errorf("header with oversized key should be stripped: %q", k[:50])
		}
	}
}

func TestHandleWebhook_InvalidSlug(t *testing.T) {
	app := setupTestApp(t)

	// Use a slug with spaces — invalid per isValidSlug but won't be
	// path-canonicalized away like "../" would be.
	// Fiber URL-decodes %20 before passing to the handler, so the slug
	// param will contain "bad slug" which fails isValidSlug.
	req := httptest.NewRequest("GET", "/w/bad%20slug/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 400 {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("expected 400 for invalid slug, got %d: %s", resp.StatusCode, string(body))
	}
}

func TestHandleWebhook_MockResponseStatus(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "status-test", &EndpointInfo{
		EndpointID: "ep-4",
		MockResponse: &MockResponse{
			Status: 201,
			Body:   `{"created": true}`,
		},
	})
	preloadQuota(t, "status-test")

	req := httptest.NewRequest("POST", "/w/status-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 201 {
		t.Errorf("expected 201, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"created": true}` {
		t.Errorf("unexpected body: %s", string(body))
	}
}

func TestHandleWebhook_InvalidMockStatus(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "badstatus-test", &EndpointInfo{
		EndpointID: "ep-5",
		MockResponse: &MockResponse{
			Status: 999, // invalid HTTP status
			Body:   "fallback",
		},
	})
	preloadQuota(t, "badstatus-test")

	req := httptest.NewRequest("GET", "/w/badstatus-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("invalid status should fallback to 200, got %d", resp.StatusCode)
	}
}

func TestHandleWebhook_NoMockResponse(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "nomock-test", &EndpointInfo{
		EndpointID: "ep-6",
	})
	preloadQuota(t, "nomock-test")

	req := httptest.NewRequest("GET", "/w/nomock-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("expected 200 for no mock response, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "OK" {
		t.Errorf("expected body 'OK', got %q", string(body))
	}
}

func TestHandleWebhook_BodySizeLimit(t *testing.T) {
	app := setupTestApp(t)

	preloadEndpointCache(t, "bigbody-test", &EndpointInfo{
		EndpointID: "ep-7",
	})
	preloadQuota(t, "bigbody-test")

	// Body larger than maxBodySize (100KB)
	bigBody := strings.NewReader(strings.Repeat("x", maxBodySize+1))
	req := httptest.NewRequest("POST", "/w/bigbody-test/", bigBody)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := app.Test(req, -1)

	// Fiber may return an error from app.Test when body limit is exceeded,
	// or it may return a 413 response — both are valid enforcement behaviors
	if err != nil {
		if strings.Contains(err.Error(), "body size") || strings.Contains(err.Error(), "limit") {
			return // test passes — body was rejected
		}
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 413 {
		t.Errorf("expected 413 for oversized body, got %d", resp.StatusCode)
	}
}

func TestHandleWebhook_ExpiredEndpoint(t *testing.T) {
	app := setupTestApp(t)

	pastTime := time.Now().Add(-1 * time.Hour).UnixMilli()
	preloadEndpointCache(t, "expired-test", &EndpointInfo{
		EndpointID: "ep-8",
		ExpiresAt:  &pastTime,
	})
	preloadQuota(t, "expired-test")

	req := httptest.NewRequest("GET", "/w/expired-test/", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 410 {
		t.Errorf("expected 410 for expired endpoint, got %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// Quota store cleanup
// ---------------------------------------------------------------------------

func TestQuotaStoreCleanup(t *testing.T) {
	dir := t.TempDir()
	store := &FileQuotaStore{dir: dir}

	// Write a quota file and make it old by modifying the file time
	path := filepath.Join(dir, "old-slug.json")
	q := &QuotaFile{Remaining: 10, Limit: 100, LastSync: time.Now().UnixMilli()}
	if err := store.writeQuotaFile(path, q); err != nil {
		t.Fatal(err)
	}

	// Set mod time to the past
	oldTime := time.Now().Add(-2 * quotaFileMaxAge)
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	store.cleanup()

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("stale quota file should have been removed by cleanup")
	}
}

// ---------------------------------------------------------------------------
// circuitState.String()
// ---------------------------------------------------------------------------

func TestCircuitStateString(t *testing.T) {
	tests := []struct {
		state circuitState
		want  string
	}{
		{circuitClosed, "closed"},
		{circuitOpen, "open"},
		{circuitHalfOpen, "half-open"},
		{circuitState(99), "unknown"},
	}
	for _, tt := range tests {
		if got := tt.state.String(); got != tt.want {
			t.Errorf("circuitState(%d).String() = %q, want %q", tt.state, got, tt.want)
		}
	}
}

// ---------------------------------------------------------------------------
// realIP helper
// ---------------------------------------------------------------------------

func TestRealIP(t *testing.T) {
	tests := []struct {
		name     string
		headers  map[string]string
		expected string
	}{
		{
			"X-Real-Ip takes precedence",
			map[string]string{"X-Real-Ip": "1.2.3.4"},
			"1.2.3.4",
		},
		{
			"X-Forwarded-For first IP",
			map[string]string{"X-Forwarded-For": "5.6.7.8, 9.10.11.12"},
			"5.6.7.8",
		},
		{
			"X-Forwarded-For single",
			map[string]string{"X-Forwarded-For": "13.14.15.16"},
			"13.14.15.16",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotIP string
			app := fiber.New()
			app.Get("/test-ip", func(c *fiber.Ctx) error {
				gotIP = realIP(c)
				return c.SendString("ok")
			})

			req := httptest.NewRequest("GET", "/test-ip", nil)
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			resp, err := app.Test(req, -1)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()

			if gotIP != tt.expected {
				t.Errorf("realIP() = %q, want %q", gotIP, tt.expected)
			}
		})
	}
}
