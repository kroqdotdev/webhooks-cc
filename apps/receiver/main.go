// Package main provides the webhook receiver service for webhooks.cc.
// The receiver captures incoming HTTP requests at /w/{slug} endpoints,
// buffers them for batch processing, and returns cached mock responses.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

// debugLog conditionally logs verbose messages when RECEIVER_DEBUG is set.
var debugLog = func() func(format string, args ...any) {
	if os.Getenv("RECEIVER_DEBUG") != "" {
		return func(format string, args ...any) {
			log.Printf("[DEBUG] "+format, args...)
		}
	}
	return func(string, ...any) {} // no-op
}()

const (
	maxBodySize           = 100 * 1024       // 100KB max body for webhooks
	maxConvexResponseSize = 1024 * 1024      // 1MB max response from Convex
	httpTimeout           = 10 * time.Second // HTTP client timeout
	quotaStaleTTL         = 30 * time.Second // How long before refreshing quota from Convex
	endpointCacheTTL      = 60 * time.Second // How long to cache endpoint info
	batchFlushInterval    = 100 * time.Millisecond
	batchMaxSize          = 50    // Flush when batch reaches this size
	batchMaxPerSlug       = 1000  // Maximum buffered requests per slug before dropping oldest
	shutdownTimeout       = 10 * time.Second
	maxCacheEntries       = 10000 // Maximum cache entries before cleanup
	cacheCleanupInterval  = 5 * time.Minute
	quotaFileMaxAge       = 1 * time.Hour // Maximum age of quota files before cleanup
	maxHeaderKeyLen       = 256           // Maximum length for mock response header keys
	maxHeaderValueLen     = 8192          // Maximum length for mock response header values
)

// BufferedRequest holds request data waiting to be sent to Convex.
type BufferedRequest struct {
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Headers     map[string]string `json:"headers"`
	Body        string            `json:"body,omitempty"`
	QueryParams map[string]string `json:"queryParams"`
	IP          string            `json:"ip"`
	ReceivedAt  int64             `json:"receivedAt"`
}

// CaptureResponse contains the result from Convex after storing requests.
type CaptureResponse struct {
	Success      bool          `json:"success,omitempty"`
	Error        string        `json:"error,omitempty"`
	Inserted     int           `json:"inserted,omitempty"`
	MockResponse *MockResponse `json:"mockResponse,omitempty"`
}

// MockResponse defines the HTTP response to return for a captured webhook.
type MockResponse struct {
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"`
}

// QuotaFile represents the quota data persisted to disk for each slug.
// File-based storage eliminates the pointer aliasing data race that existed
// in the in-memory cache when multiple goroutines held pointers to the same entry.
type QuotaFile struct {
	Remaining   int64 `json:"remaining"`
	Limit       int64 `json:"limit"`
	PeriodEnd   int64 `json:"periodEnd"`
	LastSync    int64 `json:"lastSync"`
	IsUnlimited bool  `json:"isUnlimited"`
	UserID      string `json:"userId"`
}

// QuotaCheckResult contains the result of a quota check.
type QuotaCheckResult struct {
	Allowed    bool
	RetryAfter int64 // Milliseconds until quota resets (for 429 response)
}

// QuotaResponse is the JSON structure returned by Convex /quota endpoint.
type QuotaResponse struct {
	Error            string  `json:"error,omitempty"`
	UserID           string  `json:"userId"`
	Remaining        int64   `json:"remaining"`
	Limit            int64   `json:"limit"`
	PeriodEnd        *int64  `json:"periodEnd"`
	Plan             *string `json:"plan"`
	NeedsPeriodStart bool    `json:"needsPeriodStart"`
}

// CheckPeriodResponse is the JSON structure returned by Convex /check-period endpoint.
type CheckPeriodResponse struct {
	Error      string `json:"error,omitempty"`
	Remaining  int64  `json:"remaining"`
	Limit      int64  `json:"limit"`
	PeriodEnd  *int64 `json:"periodEnd"`
	RetryAfter *int64 `json:"retryAfter"`
}

// EndpointInfo holds cached endpoint configuration.
type EndpointInfo struct {
	EndpointID   string        `json:"endpointId"`
	UserID       *string       `json:"userId"`
	IsEphemeral  bool          `json:"isEphemeral"`
	ExpiresAt    *int64        `json:"expiresAt"`
	MockResponse *MockResponse `json:"mockResponse"`
	Error        string        `json:"error,omitempty"`
	LastSync     time.Time
}

// inFlightRequest tracks an in-progress cache refresh to prevent thundering herd.
type inFlightRequest struct {
	done   chan struct{}
	result any
	err    error
}

// EndpointCache caches endpoint info to return mock responses immediately.
// Uses single-flight pattern to prevent thundering herd on cache refresh.
// Implements size-bounded caching with periodic cleanup of stale entries.
type EndpointCache struct {
	mu       sync.RWMutex
	entries  map[string]*EndpointInfo
	inFlight map[string]*inFlightRequest
	ttl      time.Duration
	maxSize  int
}

func NewEndpointCache(ctx context.Context, ttl time.Duration) *EndpointCache {
	c := &EndpointCache{
		entries:  make(map[string]*EndpointInfo),
		inFlight: make(map[string]*inFlightRequest),
		ttl:      ttl,
		maxSize:  maxCacheEntries,
	}
	// Start background cleanup goroutine (stopped via ctx)
	go c.cleanupLoop(ctx)
	return c
}

// cleanupLoop periodically removes stale entries to prevent unbounded growth.
// Exits when ctx is cancelled.
func (c *EndpointCache) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(cacheCleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.cleanup()
		}
	}
}

// cleanup removes entries older than 2x TTL and enforces max size.
func (c *EndpointCache) cleanup() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	staleThreshold := c.ttl * 2

	// Remove stale entries
	for slug, entry := range c.entries {
		if now.Sub(entry.LastSync) > staleThreshold {
			delete(c.entries, slug)
		}
	}

	// If still over max size, remove oldest entries
	for len(c.entries) > c.maxSize {
		var oldestSlug string
		var oldestTime time.Time
		for slug, entry := range c.entries {
			if oldestSlug == "" || entry.LastSync.Before(oldestTime) {
				oldestSlug = slug
				oldestTime = entry.LastSync
			}
		}
		if oldestSlug != "" {
			delete(c.entries, oldestSlug)
		}
	}
}

func (c *EndpointCache) Get(ctx context.Context, slug string) (*EndpointInfo, error) {
	// Fast path: check if we have a valid cached entry
	c.mu.RLock()
	entry, exists := c.entries[slug]
	isStale := !exists || time.Since(entry.LastSync) > c.ttl
	c.mu.RUnlock()

	if !isStale && entry != nil {
		return entry, nil
	}

	// Slow path: need to refresh - use single-flight pattern
	c.mu.Lock()
	// Double-check after acquiring write lock
	entry, exists = c.entries[slug]
	isStale = !exists || time.Since(entry.LastSync) > c.ttl
	if !isStale && entry != nil {
		c.mu.Unlock()
		return entry, nil
	}

	// Check if another goroutine is already fetching this slug
	if req, ok := c.inFlight[slug]; ok {
		c.mu.Unlock()
		// Wait for the in-flight request to complete or context cancellation
		select {
		case <-req.done:
			if req.err != nil {
				// On error, return stale cache if available
				if exists && entry != nil {
					return entry, nil
				}
				return nil, req.err
			}
			return req.result.(*EndpointInfo), nil
		case <-ctx.Done():
			// Context cancelled while waiting - return stale cache or error
			if exists && entry != nil {
				return entry, nil
			}
			return nil, ctx.Err()
		}
	}

	// We're the first - create in-flight tracker
	req := &inFlightRequest{done: make(chan struct{})}
	c.inFlight[slug] = req
	c.mu.Unlock()

	// Fetch from Convex
	newEntry, err := fetchEndpointInfo(ctx, slug)

	// Update cache and notify waiters
	c.mu.Lock()
	delete(c.inFlight, slug)
	// Only cache successful responses - don't cache "not_found" errors
	// This prevents caching transient failures or race conditions during endpoint creation
	if err == nil && newEntry != nil && newEntry.Error == "" {
		c.entries[slug] = newEntry
	}
	req.result = newEntry
	req.err = err
	c.mu.Unlock()
	close(req.done)

	if err != nil {
		if exists && entry != nil {
			log.Printf("Endpoint info refresh failed for %s, using stale cache: %v", slug, err)
			return entry, nil
		}
		return nil, err
	}

	return newEntry, nil
}

// FileQuotaStore provides thread-safe file-based quota tracking per slug.
// Each slug's quota is stored in a separate JSON file, eliminating the
// pointer aliasing data race that existed in the in-memory cache.
// Uses a global mutex for simplicity and correctness.
type FileQuotaStore struct {
	dir string
	mu  sync.Mutex
}

// NewFileQuotaStore creates a new file-based quota store.
// Creates the directory if it doesn't exist and starts a cleanup goroutine.
// The cleanup goroutine exits when ctx is cancelled.
func NewFileQuotaStore(ctx context.Context, dir string) *FileQuotaStore {
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Printf("Warning: failed to create quota directory %s: %v", dir, err)
	}
	s := &FileQuotaStore{dir: dir}
	go s.cleanupLoop(ctx)
	return s
}

// cleanupLoop periodically removes stale quota files.
// Exits when ctx is cancelled.
func (s *FileQuotaStore) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(cacheCleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.cleanup()
		}
	}
}

// cleanup removes quota files older than quotaFileMaxAge.
func (s *FileQuotaStore) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		log.Printf("Warning: failed to read quota directory: %v", err)
		return
	}

	now := time.Now()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if now.Sub(info.ModTime()) > quotaFileMaxAge {
			path := filepath.Join(s.dir, entry.Name())
			if err := os.Remove(path); err != nil {
				log.Printf("Warning: failed to remove stale quota file %s: %v", path, err)
			}
		}
	}
}

// readQuotaFile reads a quota file from disk.
// Returns nil if the file doesn't exist.
func (s *FileQuotaStore) readQuotaFile(path string) (*QuotaFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var quota QuotaFile
	if err := json.Unmarshal(data, &quota); err != nil {
		return nil, err
	}

	return &quota, nil
}

// writeQuotaFile writes a quota file to disk atomically.
// Uses a unique temp file and fsync for data integrity.
func (s *FileQuotaStore) writeQuotaFile(path string, quota *QuotaFile) error {
	data, err := json.Marshal(quota)
	if err != nil {
		return err
	}

	// Use unique temp file name to avoid conflicts
	tmpPath := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}

	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return err
	}

	// Sync to disk before rename for durability
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return err
	}

	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	return os.Rename(tmpPath, path)
}

// fetchAndCreateQuota fetches quota from Convex and creates a QuotaFile.
func (s *FileQuotaStore) fetchAndCreateQuota(ctx context.Context, slug string) (*QuotaFile, error) {
	resp, err := fetchQuota(ctx, slug)
	if err != nil {
		return nil, err
	}

	if resp.Error == "not_found" {
		return nil, nil
	}

	// For free users who need period start, call check-period to initialize
	if resp.NeedsPeriodStart && resp.UserID != "" {
		debugLog("Starting period for free user %s (needsPeriodStart=true)", resp.UserID)
		periodResp, err := callCheckPeriod(ctx, resp.UserID)
		if err != nil {
			log.Printf("Failed to start period for user %s: %v", resp.UserID, err)
			// Fall through and use the original response
		} else if periodResp.Error == "quota_exceeded" {
			// User is over quota
			quota := &QuotaFile{
				UserID:      resp.UserID,
				Remaining:   0,
				Limit:       periodResp.Limit,
				LastSync:    time.Now().UnixMilli(),
				IsUnlimited: false,
			}
			if periodResp.PeriodEnd != nil {
				quota.PeriodEnd = *periodResp.PeriodEnd
			}
			return quota, nil
		} else if periodResp.Error == "" {
			// Period started successfully, use the new quota info
			debugLog("Period started for user %s, periodEnd=%v, remaining=%d", resp.UserID, periodResp.PeriodEnd, periodResp.Remaining)
			quota := &QuotaFile{
				UserID:      resp.UserID,
				Remaining:   periodResp.Remaining,
				Limit:       periodResp.Limit,
				LastSync:    time.Now().UnixMilli(),
				IsUnlimited: false,
			}
			if periodResp.PeriodEnd != nil {
				quota.PeriodEnd = *periodResp.PeriodEnd
			}
			return quota, nil
		} else {
			log.Printf("Unexpected error from check-period for user %s: %s", resp.UserID, periodResp.Error)
		}
	}

	quota := &QuotaFile{
		UserID:      resp.UserID,
		Remaining:   resp.Remaining,
		Limit:       resp.Limit,
		LastSync:    time.Now().UnixMilli(),
		IsUnlimited: resp.Remaining == -1,
	}
	if resp.PeriodEnd != nil {
		quota.PeriodEnd = *resp.PeriodEnd
	}

	debugLog("[fetchAndCreateQuota] Created quota for slug: IsUnlimited=%v Remaining=%d Limit=%d", quota.IsUnlimited, quota.Remaining, quota.Limit)

	return quota, nil
}

// isValidSlug validates that slug contains only safe characters for filenames.
// This prevents path traversal attacks when constructing file paths.
func isValidSlug(slug string) bool {
	if len(slug) == 0 || len(slug) > 64 {
		return false
	}
	for _, r := range slug {
		isLower := r >= 'a' && r <= 'z'
		isUpper := r >= 'A' && r <= 'Z'
		isDigit := r >= '0' && r <= '9'
		isSpecial := r == '-' || r == '_'
		if isLower || isUpper || isDigit || isSpecial {
			continue
		}
		return false
	}
	return true
}

// GetAndDecrement atomically reads quota, decrements if allowed, and writes back.
// Returns QuotaCheckResult indicating if request is allowed and retry info for 429s.
// Fail-open on errors for availability.
func (s *FileQuotaStore) GetAndDecrement(ctx context.Context, slug string) QuotaCheckResult {
	// Validate slug to prevent path traversal attacks
	if !isValidSlug(slug) {
		log.Printf("Warning: invalid slug format: %s", slug)
		return QuotaCheckResult{Allowed: true} // Fail-open
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	path := filepath.Join(s.dir, slug+".json")

	// Read existing quota file
	quota, err := s.readQuotaFile(path)
	if err != nil {
		log.Printf("Warning: failed to read quota file for %s: %v", slug, err)
		// Fall through to fetch from Convex
	}

	// Check if we need to fetch from Convex (no file or stale)
	needsFetch := quota == nil
	if quota != nil {
		staleDuration := time.Now().UnixMilli() - quota.LastSync
		if staleDuration > quotaStaleTTL.Milliseconds() {
			needsFetch = true
			debugLog("[GetAndDecrement] slug=%s quota stale (age=%dms), refreshing", slug, staleDuration)
		}
	}

	if needsFetch {
		newQuota, err := s.fetchAndCreateQuota(ctx, slug)
		if err != nil {
			log.Printf("Warning: failed to fetch quota for %s: %v", slug, err)
			// If we have stale data, use it; otherwise fail-open
			if quota == nil {
				debugLog("[GetAndDecrement] slug=%s no cached data, fail-open", slug)
				return QuotaCheckResult{Allowed: true}
			}
			debugLog("[GetAndDecrement] slug=%s using stale quota data", slug)
		} else if newQuota == nil {
			// Endpoint not found
			debugLog("[GetAndDecrement] slug=%s endpoint not found, fail-open", slug)
			return QuotaCheckResult{Allowed: true}
		} else {
			quota = newQuota
			// Write the fresh quota to disk
			if err := s.writeQuotaFile(path, quota); err != nil {
				log.Printf("Warning: failed to write quota file for %s: %v", slug, err)
			}
		}
	}

	// If still no quota (shouldn't happen), fail-open
	if quota == nil {
		debugLog("[GetAndDecrement] slug=%s no quota data, fail-open", slug)
		return QuotaCheckResult{Allowed: true}
	}

	debugLog("[GetAndDecrement] slug=%s IsUnlimited=%v Remaining=%d Limit=%d PeriodEnd=%d",
		slug, quota.IsUnlimited, quota.Remaining, quota.Limit, quota.PeriodEnd)

	// Unlimited quota
	if quota.IsUnlimited {
		return QuotaCheckResult{Allowed: true}
	}

	// Check if over quota
	if quota.Remaining <= 0 {
		var retryAfter int64
		if quota.PeriodEnd > 0 {
			retryAfter = quota.PeriodEnd - time.Now().UnixMilli()
			if retryAfter < 0 {
				retryAfter = 0
			}
		}
		debugLog("[GetAndDecrement] slug=%s QUOTA_EXCEEDED retryAfter=%d", slug, retryAfter)
		return QuotaCheckResult{Allowed: false, RetryAfter: retryAfter}
	}

	// Decrement and save
	quota.Remaining--
	if err := s.writeQuotaFile(path, quota); err != nil {
		log.Printf("Warning: failed to write quota file for %s: %v", slug, err)
		// Still allow the request since we already decremented in memory
	}

	debugLog("[GetAndDecrement] slug=%s ALLOWED remaining=%d", slug, quota.Remaining)
	return QuotaCheckResult{Allowed: true}
}

// RequestBatcher buffers requests per slug and flushes them in batches.
// Tracks in-flight goroutines for graceful shutdown.
type RequestBatcher struct {
	mu       sync.Mutex
	wg       sync.WaitGroup
	buffers  map[string][]BufferedRequest
	timers   map[string]*time.Timer
	maxSize  int
	interval time.Duration
}

func NewRequestBatcher(maxSize int, interval time.Duration) *RequestBatcher {
	return &RequestBatcher{
		buffers:  make(map[string][]BufferedRequest),
		timers:   make(map[string]*time.Timer),
		maxSize:  maxSize,
		interval: interval,
	}
}

// Add adds a request to the buffer for a slug.
// If the buffer exceeds batchMaxPerSlug, the oldest request is dropped.
func (b *RequestBatcher) Add(slug string, req BufferedRequest) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Enforce buffer size limit to prevent memory exhaustion
	if len(b.buffers[slug]) >= batchMaxPerSlug {
		log.Printf("Buffer full for %s (%d requests), dropping oldest request", slug, len(b.buffers[slug]))
		b.buffers[slug] = b.buffers[slug][1:] // Drop oldest
	}

	b.buffers[slug] = append(b.buffers[slug], req)

	// If we hit max size, flush immediately
	if len(b.buffers[slug]) >= b.maxSize {
		b.flushLocked(slug)
		return
	}

	// Start or reset timer for this slug
	if timer, exists := b.timers[slug]; exists {
		// Stop returns false if timer already fired, but that's OK
		// since the timer callback will just find an empty buffer
		timer.Stop()
	}
	b.timers[slug] = time.AfterFunc(b.interval, func() {
		b.Flush(slug)
	})
}

// Flush sends all buffered requests for a slug to Convex.
func (b *RequestBatcher) Flush(slug string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked(slug)
}

// flushLocked must be called with b.mu held.
func (b *RequestBatcher) flushLocked(slug string) {
	requests := b.buffers[slug]
	if len(requests) == 0 {
		return
	}

	// Clear buffer and timer
	delete(b.buffers, slug)
	if timer, exists := b.timers[slug]; exists {
		timer.Stop()
		delete(b.timers, slug)
	}

	// Track this goroutine for graceful shutdown
	b.wg.Add(1)

	// Send to Convex in background
	go func() {
		defer b.wg.Done()

		ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
		defer cancel()

		resp, err := callConvexBatch(ctx, slug, requests)
		if err != nil {
			log.Printf("Batch capture failed for %s (%d requests): %v", slug, len(requests), err)
			return
		}
		if resp.Error != "" {
			log.Printf("Batch capture error for %s: %s", slug, resp.Error)
			return
		}
		debugLog("Batch captured %d requests for %s", resp.Inserted, slug)
	}()
}

// FlushAll flushes all pending buffers (for graceful shutdown).
func (b *RequestBatcher) FlushAll() {
	b.mu.Lock()
	slugs := make([]string, 0, len(b.buffers))
	for slug := range b.buffers {
		slugs = append(slugs, slug)
	}
	b.mu.Unlock()

	for _, slug := range slugs {
		b.Flush(slug)
	}
}

// Wait blocks until all in-flight flush goroutines complete.
func (b *RequestBatcher) Wait() {
	b.wg.Wait()
}

var (
	quotaStore          *FileQuotaStore
	endpointCache       *EndpointCache
	requestBatcher      *RequestBatcher
	convexSiteURL       string
	captureSharedSecret string
	httpClient          *http.Client
)

func main() {
	convexSiteURL = os.Getenv("CONVEX_SITE_URL")
	if convexSiteURL == "" {
		log.Fatal("CONVEX_SITE_URL environment variable is required")
	}
	if _, err := url.Parse(convexSiteURL); err != nil {
		log.Fatalf("CONVEX_SITE_URL is not a valid URL: %v", err)
	}

	captureSharedSecret = os.Getenv("CAPTURE_SHARED_SECRET")
	if captureSharedSecret == "" {
		log.Println("WARNING: CAPTURE_SHARED_SECRET is not set. Internal API calls will be unauthenticated.")
	}

	httpClient = &http.Client{
		Timeout: httpTimeout,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	quotaDir := os.Getenv("QUOTA_STORAGE_DIR")
	if quotaDir == "" {
		quotaDir = "/tmp/webhooks-quota"
	}
	// Create a root context that is cancelled on shutdown.
	// Background goroutines (cache cleanup, quota cleanup) use this for graceful exit.
	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	quotaStore = NewFileQuotaStore(rootCtx, quotaDir)
	endpointCache = NewEndpointCache(rootCtx, endpointCacheTTL)
	requestBatcher = NewRequestBatcher(batchMaxSize, batchFlushInterval)

	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             maxBodySize,
	})

	app.Use(recover.New())

	// CORS: All routes on this service are public webhook capture endpoints,
	// so allow any origin. The receiver has no authenticated browser-facing routes.
	app.Use(cors.New(cors.Config{
		AllowOriginsFunc: func(origin string) bool {
			return true
		},
		AllowMethods: "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders: "Content-Type",
	}))
	app.Use(logger.New(logger.Config{
		Format: "${time} ${method} ${path} ${status} ${latency}\n",
	}))

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})

	app.All("/w/:slug/*", handleWebhook)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}

	// Graceful shutdown handling
	shutdownCh := make(chan os.Signal, 1)
	signal.Notify(shutdownCh, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-shutdownCh
		log.Println("Shutdown signal received, flushing pending requests...")

		// Cancel root context to stop background cleanup goroutines
		rootCancel()

		// Flush all pending batches
		requestBatcher.FlushAll()

		// Wait for in-flight requests with timeout
		done := make(chan struct{})
		go func() {
			requestBatcher.Wait()
			close(done)
		}()

		select {
		case <-done:
			log.Println("All pending requests flushed successfully")
		case <-time.After(shutdownTimeout):
			log.Println("Shutdown timeout exceeded, some requests may be lost")
		}

		// Shutdown the server
		if err := app.Shutdown(); err != nil {
			log.Printf("Error during shutdown: %v", err)
		}
	}()

	log.Printf("Webhook receiver starting on :%s", port)
	if err := app.Listen(":" + port); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

func realIP(c *fiber.Ctx) string {
	if ip := c.Get("X-Real-Ip"); ip != "" {
		return ip
	}
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	return c.IP()
}

// handleWebhook processes incoming webhook requests.
// It checks quota, returns cached mock response immediately, and buffers
// the request for batch processing.
func handleWebhook(c *fiber.Ctx) error {
	slug := c.Params("slug")
	if !isValidSlug(slug) {
		return c.Status(400).JSON(fiber.Map{"error": "invalid_slug"})
	}
	debugLog("[handleWebhook] Processing request for slug=%s", slug)
	path := c.Params("*")
	if path == "" {
		path = "/"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	// Get endpoint info from cache (for mock response and validation)
	endpointInfo, err := endpointCache.Get(c.UserContext(), slug)
	if err != nil {
		log.Printf("Endpoint info fetch failed for %s: %v", slug, err)
		return c.Status(500).JSON(fiber.Map{"error": "internal_error"})
	}
	if endpointInfo == nil || endpointInfo.Error == "not_found" {
		return c.Status(404).JSON(fiber.Map{"error": "not_found"})
	}

	// Check if expired
	if endpointInfo.ExpiresAt != nil && *endpointInfo.ExpiresAt < time.Now().UnixMilli() {
		return c.Status(410).JSON(fiber.Map{"error": "expired"})
	}

	// Atomically check quota and decrement if allowed
	// File-based storage eliminates the pointer aliasing race condition
	quotaResult := quotaStore.GetAndDecrement(c.UserContext(), slug)
	if !quotaResult.Allowed {
		debugLog("[handleWebhook] QUOTA_EXCEEDED for slug=%s retryAfter=%d", slug, quotaResult.RetryAfter)
		// Minimal 429 response - don't leak usage details to webhook senders
		return c.Status(429).JSON(fiber.Map{
			"error": "quota_exceeded",
		})
	}

	// Collect headers
	headers := make(map[string]string)
	c.Request().Header.VisitAll(func(key, value []byte) {
		headers[string(key)] = string(value)
	})

	// Collect query params
	queryParams := make(map[string]string)
	c.Request().URI().QueryArgs().VisitAll(func(key, value []byte) {
		queryParams[string(key)] = string(value)
	})

	// Buffer the request for batch processing
	requestBatcher.Add(slug, BufferedRequest{
		Method:      c.Method(),
		Path:        path,
		Headers:     headers,
		Body:        string(c.Body()),
		QueryParams: queryParams,
		IP:          realIP(c),
		ReceivedAt:  time.Now().UnixMilli(),
	})

	// Return mock response immediately from cache
	if endpointInfo.MockResponse != nil {
		for key, value := range endpointInfo.MockResponse.Headers {
			// Skip headers that exceed length limits
			if len(key) > maxHeaderKeyLen || len(value) > maxHeaderValueLen {
				continue
			}
			keyLower := strings.ToLower(key)
			if keyLower == "set-cookie" || keyLower == "strict-transport-security" ||
				keyLower == "content-security-policy" || keyLower == "x-frame-options" {
				continue
			}
			if strings.ContainsAny(key, "\r\n") || strings.ContainsAny(value, "\r\n") {
				continue
			}
			c.Set(key, value)
		}
		status := endpointInfo.MockResponse.Status
		if status < 100 || status > 599 {
			status = 200
		}
		return c.Status(status).SendString(endpointInfo.MockResponse.Body)
	}

	return c.SendString("OK")
}

func fetchEndpointInfo(ctx context.Context, slug string) (*EndpointInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", convexSiteURL+"/endpoint-info?slug="+url.QueryEscape(slug), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create endpoint info request: %w", err)
	}

	if captureSharedSecret != "" {
		req.Header.Set("Authorization", "Bearer "+captureSharedSecret)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch endpoint info: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxConvexResponseSize))
	if err != nil {
		return nil, fmt.Errorf("failed to read endpoint info response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("endpoint info endpoint returned status %d: %s", resp.StatusCode, string(body))
	}

	var result EndpointInfo
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse endpoint info response: %w", err)
	}

	result.LastSync = time.Now()
	return &result, nil
}

// callCheckPeriod calls the Convex /check-period endpoint to start a free user's period.
func callCheckPeriod(ctx context.Context, userID string) (*CheckPeriodResponse, error) {
	payload, err := json.Marshal(map[string]string{"userId": userID})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal check-period request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", convexSiteURL+"/check-period", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to create check-period request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if captureSharedSecret != "" {
		req.Header.Set("Authorization", "Bearer "+captureSharedSecret)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call check-period: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxConvexResponseSize))
	if err != nil {
		return nil, fmt.Errorf("failed to read check-period response: %w", err)
	}

	// 429 responses contain valid quota_exceeded JSON
	if resp.StatusCode != 200 && resp.StatusCode != 429 {
		return nil, fmt.Errorf("check-period endpoint returned status %d: %s", resp.StatusCode, string(body))
	}

	var result CheckPeriodResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse check-period response: %w", err)
	}

	return &result, nil
}

func fetchQuota(ctx context.Context, slug string) (*QuotaResponse, error) {
	debugLog("[fetchQuota] Fetching quota for slug=%s", slug)
	req, err := http.NewRequestWithContext(ctx, "GET", convexSiteURL+"/quota?slug="+url.QueryEscape(slug), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create quota request: %w", err)
	}

	if captureSharedSecret != "" {
		req.Header.Set("Authorization", "Bearer "+captureSharedSecret)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch quota: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxConvexResponseSize))
	if err != nil {
		return nil, fmt.Errorf("failed to read quota response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("quota endpoint returned status %d: %s", resp.StatusCode, string(body))
	}

	var result QuotaResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse quota response: %w", err)
	}

	debugLog("[fetchQuota] slug=%s response: remaining=%d limit=%d needsPeriodStart=%v error=%s",
		slug, result.Remaining, result.Limit, result.NeedsPeriodStart, result.Error)

	return &result, nil
}

func callConvexBatch(ctx context.Context, slug string, requests []BufferedRequest) (*CaptureResponse, error) {
	payload, err := json.Marshal(map[string]any{
		"slug":     slug,
		"requests": requests,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", convexSiteURL+"/capture-batch", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to create batch request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if captureSharedSecret != "" {
		req.Header.Set("Authorization", "Bearer "+captureSharedSecret)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call Convex batch: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxConvexResponseSize))
	if err != nil {
		return nil, fmt.Errorf("failed to read batch response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("convex batch returned status %d: %s", resp.StatusCode, string(body))
	}

	var result CaptureResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse batch response: %w", err)
	}

	return &result, nil
}
