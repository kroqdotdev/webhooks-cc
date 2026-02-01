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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

const (
	maxBodySize           = 100 * 1024       // 100KB max body for webhooks
	maxConvexResponseSize = 1024 * 1024      // 1MB max response from Convex
	httpTimeout           = 10 * time.Second // HTTP client timeout
	quotaCacheTTL         = 30 * time.Second // How long to cache quota data
	endpointCacheTTL      = 60 * time.Second // How long to cache endpoint info
	batchFlushInterval    = 100 * time.Millisecond
	batchMaxSize          = 50 // Flush when batch reaches this size
	shutdownTimeout       = 10 * time.Second
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

// QuotaEntry holds cached quota information for an endpoint's user.
type QuotaEntry struct {
	UserID      string
	Remaining   int64
	Limit       int64
	PeriodEnd   int64
	LastSync    time.Time
	IsUnlimited bool
}

// QuotaResponse is the JSON structure returned by Convex /quota endpoint.
type QuotaResponse struct {
	Error     string `json:"error,omitempty"`
	UserID    string `json:"userId"`
	Remaining int64  `json:"remaining"`
	Limit     int64  `json:"limit"`
	PeriodEnd *int64 `json:"periodEnd"`
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
type EndpointCache struct {
	mu       sync.RWMutex
	entries  map[string]*EndpointInfo
	inFlight map[string]*inFlightRequest
	ttl      time.Duration
}

func NewEndpointCache(ttl time.Duration) *EndpointCache {
	return &EndpointCache{
		entries:  make(map[string]*EndpointInfo),
		inFlight: make(map[string]*inFlightRequest),
		ttl:      ttl,
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
		// Wait for the in-flight request to complete
		<-req.done
		if req.err != nil {
			// On error, return stale cache if available
			if exists && entry != nil {
				return entry, nil
			}
			return nil, req.err
		}
		return req.result.(*EndpointInfo), nil
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
	if err == nil && newEntry != nil {
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

// QuotaCache provides thread-safe caching of user quota information.
// Uses single-flight pattern to prevent thundering herd on cache refresh.
type QuotaCache struct {
	mu       sync.RWMutex
	entries  map[string]*QuotaEntry
	inFlight map[string]*inFlightRequest
	ttl      time.Duration
}

func NewQuotaCache(ttl time.Duration) *QuotaCache {
	return &QuotaCache{
		entries:  make(map[string]*QuotaEntry),
		inFlight: make(map[string]*inFlightRequest),
		ttl:      ttl,
	}
}

func (c *QuotaCache) Check(ctx context.Context, slug string) (*QuotaEntry, error) {
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
		// Wait for the in-flight request to complete
		<-req.done
		if req.err != nil {
			// On error, return stale cache if available
			if exists && entry != nil {
				return entry, nil
			}
			return nil, req.err
		}
		if req.result == nil {
			return nil, nil
		}
		return req.result.(*QuotaEntry), nil
	}

	// We're the first - create in-flight tracker
	req := &inFlightRequest{done: make(chan struct{})}
	c.inFlight[slug] = req
	c.mu.Unlock()

	// Fetch from Convex
	newEntry, err := c.fetchAndStore(ctx, slug)

	// Update cache and notify waiters
	c.mu.Lock()
	delete(c.inFlight, slug)
	req.result = newEntry
	req.err = err
	c.mu.Unlock()
	close(req.done)

	if err != nil {
		if exists && entry != nil {
			log.Printf("Quota refresh failed for %s, using stale cache: %v", slug, err)
			return entry, nil
		}
		return nil, err
	}

	return newEntry, nil
}

func (c *QuotaCache) fetchAndStore(ctx context.Context, slug string) (*QuotaEntry, error) {
	resp, err := fetchQuota(ctx, slug)
	if err != nil {
		return nil, err
	}

	if resp.Error == "not_found" {
		return nil, nil
	}

	entry := &QuotaEntry{
		UserID:      resp.UserID,
		Remaining:   resp.Remaining,
		Limit:       resp.Limit,
		LastSync:    time.Now(),
		IsUnlimited: resp.Remaining == -1,
	}
	if resp.PeriodEnd != nil {
		entry.PeriodEnd = *resp.PeriodEnd
	}

	c.mu.Lock()
	c.entries[slug] = entry
	c.mu.Unlock()

	return entry, nil
}

func (c *QuotaCache) Decrement(slug string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if entry, exists := c.entries[slug]; exists && !entry.IsUnlimited {
		entry.Remaining--
	}
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
func (b *RequestBatcher) Add(slug string, req BufferedRequest) {
	b.mu.Lock()
	defer b.mu.Unlock()

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
		log.Printf("Batch captured %d requests for %s", resp.Inserted, slug)
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
	quotaCache          *QuotaCache
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

	httpClient = &http.Client{
		Timeout: httpTimeout,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	quotaCache = NewQuotaCache(quotaCacheTTL)
	endpointCache = NewEndpointCache(endpointCacheTTL)
	requestBatcher = NewRequestBatcher(batchMaxSize, batchFlushInterval)

	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             maxBodySize,
	})

	app.Use(recover.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders: "Content-Type,Authorization",
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
	path := c.Params("*")
	if path == "" {
		path = "/"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	// Get endpoint info from cache (for mock response and validation)
	endpointInfo, err := endpointCache.Get(c.Context(), slug)
	if err != nil {
		log.Printf("Endpoint info fetch failed for %s: %v", slug, err)
		return c.Status(500).SendString("Internal server error")
	}
	if endpointInfo == nil || endpointInfo.Error == "not_found" {
		return c.Status(404).SendString("Endpoint not found")
	}

	// Check if expired
	if endpointInfo.ExpiresAt != nil && *endpointInfo.ExpiresAt < time.Now().UnixMilli() {
		return c.Status(410).SendString("Endpoint expired")
	}

	// Check quota from cache (fail-open on errors for availability)
	quota, err := quotaCache.Check(c.Context(), slug)
	if err != nil {
		log.Printf("Quota check failed for %s, allowing request: %v", slug, err)
	} else if quota != nil && !quota.IsUnlimited && quota.Remaining <= 0 {
		return c.Status(429).SendString("Request limit exceeded")
	}

	// Decrement local quota counter
	if quota != nil && !quota.IsUnlimited && quota.Remaining > 0 {
		quotaCache.Decrement(slug)
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
	defer resp.Body.Close()

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

func fetchQuota(ctx context.Context, slug string) (*QuotaResponse, error) {
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
	defer resp.Body.Close()

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
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxConvexResponseSize))
	if err != nil {
		return nil, fmt.Errorf("failed to read batch response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Convex batch returned status %d: %s", resp.StatusCode, string(body))
	}

	var result CaptureResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse batch response: %w", err)
	}

	return &result, nil
}
