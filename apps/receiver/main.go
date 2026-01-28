package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

type CaptureRequest struct {
	Slug        string            `json:"slug"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Headers     map[string]string `json:"headers"`
	Body        string            `json:"body,omitempty"`
	QueryParams map[string]string `json:"queryParams"`
	IP          string            `json:"ip"`
}

type CaptureResponse struct {
	Success      bool          `json:"success,omitempty"`
	Error        string        `json:"error,omitempty"`
	MockResponse *MockResponse `json:"mockResponse,omitempty"`
}

type MockResponse struct {
	Status  int               `json:"status"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"`
}

var convexSiteURL string
var httpClient *http.Client

func main() {
	// HTTP actions are served from the .site domain, not .cloud
	convexSiteURL = os.Getenv("CONVEX_SITE_URL")
	if convexSiteURL == "" {
		log.Fatal("CONVEX_SITE_URL environment variable is required")
	}

	// Initialize HTTP client with timeout
	httpClient = &http.Client{
		Timeout: 10 * time.Second,
	}

	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             100 * 1024, // 100KB max body
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

	// Health check
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})

	// Webhook capture endpoint: /w/:slug/*
	app.All("/w/:slug/*", handleWebhook)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}

	log.Printf("Webhook receiver starting on :%s", port)
	log.Fatal(app.Listen(":" + port))
}

// realIP extracts the client IP from proxy headers, falling back to the
// direct connection IP. Caddy sets X-Forwarded-For and X-Real-Ip.
func realIP(c *fiber.Ctx) string {
	// X-Real-Ip is a single IP set by the reverse proxy
	if ip := c.Get("X-Real-Ip"); ip != "" {
		return ip
	}
	// X-Forwarded-For can be a comma-separated chain; first entry is the client
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	return c.IP()
}

func handleWebhook(c *fiber.Ctx) error {
	slug := c.Params("slug")
	path := c.Params("*")
	if path == "" {
		path = "/"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
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

	// Get body (limit to 100KB)
	body := string(c.Body())
	if len(body) > 100*1024 {
		body = body[:100*1024]
	}

	// Call Convex to capture the request
	resp, err := callConvex(map[string]any{
		"slug":        slug,
		"method":      c.Method(),
		"path":        path,
		"headers":     headers,
		"body":        body,
		"queryParams": queryParams,
		"ip":          realIP(c),
	})

	if err != nil {
		log.Printf("Error calling Convex: %v", err)
		return c.Status(500).SendString("Internal server error")
	}

	if resp.Error == "not_found" {
		return c.Status(404).SendString("Endpoint not found")
	}

	if resp.Error == "expired" {
		return c.Status(410).SendString("Endpoint expired")
	}

	if resp.Error == "limit_exceeded" {
		return c.Status(429).SendString("Request limit exceeded")
	}

	if resp.Error != "" {
		return c.Status(500).SendString(resp.Error)
	}

	// Return mock response
	if resp.MockResponse != nil {
		for key, value := range resp.MockResponse.Headers {
			c.Set(key, value)
		}
		return c.Status(resp.MockResponse.Status).SendString(resp.MockResponse.Body)
	}

	return c.SendString("OK")
}

func callConvex(args map[string]any) (*CaptureResponse, error) {
	payload, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", convexSiteURL+"/capture", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call Convex: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var result CaptureResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &result, nil
}
