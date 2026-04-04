package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/lib/pq"
)

// ─── Configuration ──────────────────────────────────────────────────────────

var (
	userCount          = 200
	endpointsPerUser   = 2
	reqsPerEndpoint    = 150
	requestLimitPerUser = 100
	maxOverrun         = 5
	ephemeralLimit     = 25
	receiverURL        = "http://localhost:3001"
	httpConcurrency    = 500
	skipCleanup        = false
)

const testPrefix = "rcv_test_"

var (
	dbURL              string
	supabaseURL        string
	supabaseServiceKey string
)

// ─── Env Loading ────────────────────────────────────────────────────────────

func loadEnv() {
	exe, _ := os.Executable()
	root := filepath.Dir(filepath.Dir(exe))
	// Also try CWD
	candidates := []string{
		filepath.Join(root, ".env.local"),
		".env.local",
		"../.env.local",
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
				continue
			}
			key, val, _ := strings.Cut(line, "=")
			key = strings.TrimSpace(key)
			val = strings.TrimSpace(val)
			if os.Getenv(key) == "" {
				os.Setenv(key, val)
			}
		}
		break
	}

	raw := envOr("SUPABASE_DB_URL", "")
	if !strings.Contains(raw, "sslmode=") {
		if strings.Contains(raw, "?") {
			raw += "&sslmode=disable"
		} else {
			raw += "?sslmode=disable"
		}
	}
	dbURL = raw
	supabaseURL = envOr("SUPABASE_URL", "")
	supabaseServiceKey = os.Getenv("SUPABASE_SERVICE_ROLE_KEY")

	if dbURL == "" || dbURL == "?sslmode=disable" {
		fatalf("SUPABASE_DB_URL is required (set in .env.local or environment)")
	}
	if supabaseURL == "" {
		fatalf("SUPABASE_URL is required (set in .env.local or environment)")
	}
	if supabaseServiceKey == "" {
		fatalf("SUPABASE_SERVICE_ROLE_KEY is required (set in .env.local or environment)")
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ─── HTTP Client ────────────────────────────────────────────────────────────

var httpClient = &http.Client{
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        1000,
		MaxIdleConnsPerHost: 1000,
		MaxConnsPerHost:     0,
		IdleConnTimeout:     90 * time.Second,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
	},
	Timeout: 30 * time.Second,
}

// ─── DB Helpers ─────────────────────────────────────────────────────────────

var db *sql.DB

func initDB() {
	var err error
	db, err = sql.Open("postgres", dbURL)
	if err != nil {
		fatalf("failed to open DB: %v", err)
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(10)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		fatalf("failed to ping DB: %v", err)
	}
}

func dbExec(query string, args ...any) {
	_, err := db.Exec(query, args...)
	if err != nil {
		fatalf("DB exec failed: %v\n  query: %s", err, query)
	}
}

func dbScalar(query string, args ...any) int64 {
	var n int64
	err := db.QueryRow(query, args...).Scan(&n)
	if err != nil {
		return 0
	}
	return n
}

// ─── Supabase Auth ──────────────────────────────────────────────────────────

func supabaseCreateUser(email string) string {
	body, _ := json.Marshal(map[string]any{
		"email":         email,
		"password":      "TestPassword123!",
		"email_confirm": true,
		"user_metadata": map[string]string{"full_name": "Receiver Test User"},
	})
	req, _ := http.NewRequest("POST", supabaseURL+"/auth/v1/admin/users", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+supabaseServiceKey)
	req.Header.Set("apikey", supabaseServiceKey)
	resp, err := httpClient.Do(req)
	if err != nil {
		fatalf("create user failed: %v", err)
	}
	defer resp.Body.Close()
	var result struct{ ID string `json:"id"` }
	json.NewDecoder(resp.Body).Decode(&result)
	return result.ID
}

func supabaseDeleteUser(userID string) {
	req, _ := http.NewRequest("DELETE", supabaseURL+"/auth/v1/admin/users/"+userID, nil)
	req.Header.Set("Authorization", "Bearer "+supabaseServiceKey)
	req.Header.Set("apikey", supabaseServiceKey)
	resp, err := httpClient.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

// ─── Request Helpers ────────────────────────────────────────────────────────

type requestResult struct {
	status    int
	latencyMs float64
	body      []byte
}

func sendRequest(url string) requestResult {
	payload := []byte(`{"event":"test","ts":` + fmt.Sprintf("%d", time.Now().UnixMilli()) + `}`)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := httpClient.Do(req)
	latency := float64(time.Since(start).Microseconds()) / 1000.0

	if err != nil {
		return requestResult{status: 0, latencyMs: latency}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return requestResult{status: resp.StatusCode, latencyMs: latency, body: body}
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(float64(len(sorted)) * p / 100.0)
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// ─── Test Phases ────────────────────────────────────────────────────────────

type user struct {
	id    string
	email string
	slugs []string
	idx   int
}

type endpointResult struct {
	mu        sync.Mutex
	slug      string
	userIdx   int
	okCount   int
	rejCount  int
	errCount  int
	latencies []float64
}

func phaseSeed() []user {
	printHeader("PHASE 1: Seeding test data")
	fmt.Printf("  Creating %d users with %d endpoints each\n", userCount, endpointsPerUser)
	fmt.Printf("  Request limit per user: %d\n", requestLimitPerUser)

	start := time.Now()
	users := make([]user, 0, userCount)

	for i := 0; i < userCount; i++ {
		email := fmt.Sprintf("%s%d_%d@test.local", testPrefix, i, time.Now().Unix())
		uid := supabaseCreateUser(email)

		dbExec(`UPDATE public.users SET plan='pro', request_limit=$1, requests_used=0,
			period_start=now(), period_end=now()+interval '1 hour' WHERE id=$2`,
			requestLimitPerUser, uid)

		slugs := make([]string, 0, endpointsPerUser)
		for j := 0; j < endpointsPerUser; j++ {
			slug := fmt.Sprintf("%s%d_%d_%d", testPrefix, i, j, time.Now().Unix())
			dbExec(`INSERT INTO public.endpoints (slug, user_id, is_ephemeral, expires_at)
				VALUES ($1, $2, false, now()+interval '1 hour') ON CONFLICT ((lower(slug))) DO NOTHING`,
				slug, uid)
			slugs = append(slugs, slug)
		}
		users = append(users, user{id: uid, email: email, slugs: slugs, idx: i})
	}

	fmt.Printf("  Created %d users, %d endpoints in %.1fs\n",
		len(users), len(users)*endpointsPerUser, time.Since(start).Seconds())
	return users
}

func phaseLoadTest(users []user) map[string]*endpointResult {
	printHeader("PHASE 2: Load test")

	results := make(map[string]*endpointResult)
	var workItems []string

	for _, u := range users {
		for _, slug := range u.slugs {
			results[slug] = &endpointResult{slug: slug, userIdx: u.idx}
			for range reqsPerEndpoint {
				workItems = append(workItems, slug)
			}
		}
	}

	rand.Shuffle(len(workItems), func(i, j int) { workItems[i], workItems[j] = workItems[j], workItems[i] })

	totalReqs := len(workItems)
	fmt.Printf("  Endpoints: %d\n", len(results))
	fmt.Printf("  Requests per endpoint: %d\n", reqsPerEndpoint)
	fmt.Printf("  Total requests: %d\n", totalReqs)
	fmt.Printf("  Concurrency: %d\n\n", httpConcurrency)

	var completed atomic.Int64
	start := time.Now()

	work := make(chan string, httpConcurrency*2)
	var wg sync.WaitGroup

	for range httpConcurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for slug := range work {
				url := fmt.Sprintf("%s/w/%s/load-test", receiverURL, slug)
				res := sendRequest(url)

				r := results[slug]
				r.mu.Lock()
				r.latencies = append(r.latencies, res.latencyMs)
				switch res.status {
				case 200:
					r.okCount++
				case 429:
					r.rejCount++
				default:
					r.errCount++
				}
				r.mu.Unlock()

				c := completed.Add(1)
				if c%2000 == 0 {
					elapsed := time.Since(start).Seconds()
					fmt.Printf("  Progress: %d/%d (%.0f RPS)\n", c, totalReqs, float64(c)/elapsed)
				}
			}
		}()
	}

	for _, slug := range workItems {
		work <- slug
	}
	close(work)
	wg.Wait()

	elapsed := time.Since(start).Seconds()

	var allLatencies []float64
	var totalOK, total429, totalErr int
	for _, r := range results {
		allLatencies = append(allLatencies, r.latencies...)
		totalOK += r.okCount
		total429 += r.rejCount
		totalErr += r.errCount
	}
	sort.Float64s(allLatencies)

	fmt.Println()
	fmt.Printf("  Duration:    %.1fs\n", elapsed)
	fmt.Printf("  RPS:         %.0f\n", float64(totalReqs)/elapsed)
	fmt.Printf("  OK (200):    %d\n", totalOK)
	fmt.Printf("  Quota (429): %d\n", total429)
	fmt.Printf("  Errors:      %d\n", totalErr)
	fmt.Printf("  Latency P50:   %.2fms\n", percentile(allLatencies, 50))
	fmt.Printf("  Latency P90:   %.2fms\n", percentile(allLatencies, 90))
	fmt.Printf("  Latency P99:   %.2fms\n", percentile(allLatencies, 99))
	fmt.Printf("  Latency P99.9: %.2fms\n", percentile(allLatencies, 99.9))

	return results
}

func phaseQuotaCheck(results map[string]*endpointResult, users []user) bool {
	printHeader("PHASE 3: Quota enforcement check")

	userAccepted := make(map[int]int)
	for _, r := range results {
		userAccepted[r.userIdx] += r.okCount
	}

	var violations []string
	for _, u := range users {
		accepted := userAccepted[u.idx]
		overrun := accepted - requestLimitPerUser
		if overrun > maxOverrun {
			violations = append(violations, fmt.Sprintf("    User %d: accepted %d (overrun %d)", u.idx, accepted, overrun))
		}
	}

	if len(violations) > 0 {
		fmt.Printf("  FAIL: %d users exceeded acceptable overrun (%d)\n", len(violations), maxOverrun)
		for _, v := range violations[:min(10, len(violations))] {
			fmt.Println(v)
		}
		return false
	}

	maxO := 0
	for _, u := range users {
		o := userAccepted[u.idx] - requestLimitPerUser
		if o > maxO {
			maxO = o
		}
	}
	fmt.Printf("  PASS: All users within tolerance (max overrun: %d)\n", maxO)
	return true
}

func phaseDeliveryCheck(results map[string]*endpointResult, users []user) bool {
	printHeader("PHASE 4: Delivery accuracy check")

	totalAccepted := 0
	for _, r := range results {
		totalAccepted += r.okCount
	}
	fmt.Printf("  Expected stored requests: %d\n", totalAccepted)

	// Build array of user IDs for query
	uids := make([]string, len(users))
	for i, u := range users {
		uids[i] = u.id
	}

	rows, err := db.Query(`
		SELECT count(*) FROM public.requests
		WHERE user_id = ANY($1::uuid[]) AND path = '/load-test'
	`, fmt.Sprintf("{%s}", strings.Join(uids, ",")))
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
		return false
	}
	defer rows.Close()

	var totalStored int64
	if rows.Next() {
		rows.Scan(&totalStored)
	}

	fmt.Printf("  Actually stored: %d\n", totalStored)

	if totalStored == int64(totalAccepted) {
		fmt.Println("  PASS: 100% delivery accuracy")
		return true
	} else if totalStored >= int64(float64(totalAccepted)*0.99) {
		rate := float64(totalStored) / float64(totalAccepted) * 100
		fmt.Printf("  PASS: %.2f%% delivery accuracy (%d missing)\n", rate, int64(totalAccepted)-totalStored)
		return true
	}
	rate := float64(totalStored) / math.Max(float64(totalAccepted), 1) * 100
	fmt.Printf("  FAIL: %.2f%% delivery accuracy (%d missing)\n", rate, int64(totalAccepted)-totalStored)
	return false
}

func phaseUsageCheck(users []user) bool {
	printHeader("PHASE 5: Usage counter accuracy")

	mismatches := 0
	for _, u := range users {
		var used int64
		db.QueryRow(`SELECT requests_used FROM public.users WHERE id=$1`, u.id).Scan(&used)
		var stored int64
		db.QueryRow(`SELECT count(*) FROM public.requests WHERE user_id=$1 AND path='/load-test'`, u.id).Scan(&stored)
		if used != stored {
			mismatches++
			if mismatches <= 10 {
				fmt.Printf("    User %d: requests_used=%d, stored=%d\n", u.idx, used, stored)
			}
		}
	}

	if mismatches > 0 {
		fmt.Printf("  FAIL: %d users have requests_used != stored count\n", mismatches)
		return false
	}
	fmt.Printf("  PASS: All %d users have accurate usage counters\n", len(users))
	return true
}

func phaseEphemeralTest() bool {
	printHeader("PHASE 6: Ephemeral endpoint quota test")

	slug := fmt.Sprintf("%sephemeral_%d", testPrefix, time.Now().Unix())
	dbExec(`INSERT INTO public.endpoints (slug, is_ephemeral, expires_at) VALUES ($1, true, now()+interval '1 hour')`, slug)

	okCount, rejCount := 0, 0
	for range 30 {
		res := sendRequest(fmt.Sprintf("%s/w/%s/ephemeral-test", receiverURL, slug))
		switch res.status {
		case 200:
			okCount++
		case 429:
			rejCount++
		}
	}

	stored := dbScalar(`SELECT count(*) FROM public.requests WHERE endpoint_id = (SELECT id FROM public.endpoints WHERE slug=$1)`, slug)
	fmt.Printf("  OK: %d, Rejected: %d, Stored: %d\n", okCount, rejCount, stored)

	if okCount == ephemeralLimit && rejCount == 5 {
		fmt.Printf("  PASS: Ephemeral cap enforced at %d\n", ephemeralLimit)
		return true
	}
	fmt.Printf("  FAIL: Expected %d OK + 5 rejected\n", ephemeralLimit)
	return false
}

func phaseExpiredTest() bool {
	printHeader("PHASE 7: Expired endpoint test")

	slug := fmt.Sprintf("%sexpired_%d", testPrefix, time.Now().Unix())
	dbExec(`INSERT INTO public.endpoints (slug, is_ephemeral, expires_at) VALUES ($1, true, now()-interval '1 minute')`, slug)

	res := sendRequest(fmt.Sprintf("%s/w/%s/expired-test", receiverURL, slug))
	fmt.Printf("  Status: %d, Latency: %.1fms\n", res.status, res.latencyMs)

	if res.status == 410 {
		fmt.Println("  PASS: Expired endpoint returns 410")
		return true
	}
	fmt.Printf("  FAIL: Expected 410, got %d\n", res.status)
	return false
}

func phaseMockTest() bool {
	printHeader("PHASE 8: Mock response test")

	slug := fmt.Sprintf("%smock_%d", testPrefix, time.Now().Unix())
	email := fmt.Sprintf("%smock_%d@test.local", testPrefix, time.Now().Unix())
	uid := supabaseCreateUser(email)

	dbExec(`UPDATE public.users SET plan='pro', request_limit=100 WHERE id=$1`, uid)

	mock, _ := json.Marshal(map[string]any{"status": 201, "body": `{"ok":true}`, "headers": map[string]string{"x-custom": "test"}})
	dbExec(`INSERT INTO public.endpoints (slug, user_id, is_ephemeral, mock_response) VALUES ($1, $2, false, $3::jsonb)`, slug, uid, string(mock))

	res := sendRequest(fmt.Sprintf("%s/w/%s/mock-test", receiverURL, slug))
	fmt.Printf("  Status: %d\n", res.status)
	fmt.Printf("  Body: %s\n", string(res.body))

	if res.status == 201 {
		fmt.Println("  PASS: Mock response returned with correct status")
		return true
	}
	fmt.Printf("  FAIL: Expected 201, got %d\n", res.status)
	return false
}

func phaseCleanup(users []user) {
	printHeader("CLEANUP: Removing test data")

	uids := make([]string, len(users))
	for i, u := range users {
		uids[i] = u.id
	}

	// Find stragglers
	rows, err := db.Query(`SELECT id FROM public.users WHERE email LIKE $1`, testPrefix+"%")
	if err == nil {
		defer rows.Close()
		uidSet := make(map[string]bool)
		for _, id := range uids {
			uidSet[id] = true
		}
		for rows.Next() {
			var id string
			rows.Scan(&id)
			if !uidSet[id] {
				uids = append(uids, id)
			}
		}
	}

	uidArray := fmt.Sprintf("{%s}", strings.Join(uids, ","))
	db.Exec(`DELETE FROM public.requests WHERE user_id = ANY($1::uuid[])`, uidArray)
	db.Exec(`DELETE FROM public.endpoints WHERE user_id = ANY($1::uuid[])`, uidArray)
	db.Exec(`DELETE FROM public.requests WHERE endpoint_id IN (SELECT id FROM public.endpoints WHERE slug LIKE $1)`, testPrefix+"%")
	db.Exec(`DELETE FROM public.endpoints WHERE slug LIKE $1`, testPrefix+"%")

	for _, uid := range uids {
		supabaseDeleteUser(uid)
	}

	fmt.Println("  Done")
}

// ─── Utilities ──────────────────────────────────────────────────────────────

func printHeader(title string) {
	fmt.Printf("\n%s\n%s\n%s\n", strings.Repeat("=", 70), title, strings.Repeat("=", 70))
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", args...)
	os.Exit(1)
}

// ─── Main ───────────────────────────────────────────────────────────────────

func main() {
	flag.StringVar(&receiverURL, "receiver-url", receiverURL, "Receiver URL")
	flag.IntVar(&userCount, "users", userCount, "Number of test users")
	flag.IntVar(&httpConcurrency, "concurrency", httpConcurrency, "HTTP concurrency")
	flag.BoolVar(&skipCleanup, "skip-cleanup", false, "Skip test data cleanup")
	flag.Parse()

	loadEnv()
	initDB()

	fmt.Printf("%s\nWebhook Receiver End-to-End Test (Go)\n%s\n", strings.Repeat("=", 70), strings.Repeat("=", 70))
	fmt.Printf("  Receiver:    %s\n", receiverURL)
	fmt.Printf("  Database:    %s...\n", dbURL[:50])
	fmt.Printf("  Users: %d, Endpoints/user: %d\n", userCount, endpointsPerUser)
	fmt.Printf("  Requests/endpoint: %d, Limit/user: %d\n", reqsPerEndpoint, requestLimitPerUser)
	fmt.Printf("  Concurrency: %d\n", httpConcurrency)

	// Health check
	resp, err := httpClient.Get(receiverURL + "/health")
	if err != nil || resp.StatusCode != 200 {
		fatalf("receiver health check failed: %v", err)
	}
	resp.Body.Close()
	fmt.Println("  Receiver health: OK")

	type result struct {
		name   string
		passed bool
	}
	var results []result

	// Functional tests
	results = append(results, result{"Ephemeral quota", phaseEphemeralTest()})
	results = append(results, result{"Expired endpoint", phaseExpiredTest()})
	results = append(results, result{"Mock response", phaseMockTest()})

	// Load test
	users := phaseSeed()
	loadResults := phaseLoadTest(users)
	results = append(results, result{"Quota enforcement", phaseQuotaCheck(loadResults, users)})
	results = append(results, result{"Delivery accuracy", phaseDeliveryCheck(loadResults, users)})
	results = append(results, result{"Usage counters", phaseUsageCheck(users)})

	if !skipCleanup {
		phaseCleanup(users)
	}

	// Summary
	printHeader("RESULTS")
	allPassed := true
	for _, r := range results {
		status := "PASS"
		if !r.passed {
			status = "FAIL"
			allPassed = false
		}
		fmt.Printf("  [%s] %s\n", status, r.name)
	}

	fmt.Println()
	if allPassed {
		fmt.Println("  All tests passed!")
	} else {
		fmt.Println("  Some tests FAILED")
		os.Exit(1)
	}
}
