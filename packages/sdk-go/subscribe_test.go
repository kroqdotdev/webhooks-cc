package webhookscc_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
)

func sseRequest(w http.ResponseWriter, id string, receivedAt int64) {
	data, _ := json.Marshal(requestJSON(id, receivedAt, nil))
	fmt.Fprintf(w, "event: request\ndata: %s\n\n", data)
	w.(http.Flusher).Flush()
}

func sseStart(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Date", "Thu, 01 Jan 2026 00:00:00 GMT")
	w.WriteHeader(200)
	fmt.Fprint(w, ": connected\n\n")
	w.(http.Flusher).Flush()
}

func collectStream(t *testing.T, client *webhookscc.Client, ctx context.Context, opts webhookscc.SubscribeOptions) ([]string, error) {
	t.Helper()
	var ids []string
	for request, err := range client.Requests.Subscribe(ctx, "acme-test", opts) {
		if err != nil {
			return ids, err
		}
		ids = append(ids, request.ID)
	}
	return ids, nil
}

func TestSubscribeFollowsRotationAndSkipsRepeats(t *testing.T) {
	api := newFakeAPI(t)
	var connections atomic.Int32
	var secondSince atomic.Value
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "text/event-stream" {
			http.Error(w, "bad accept", http.StatusBadRequest)
			return
		}
		sseStart(w)
		switch connections.Add(1) {
		case 1:
			sseRequest(w, "r1", 1767225600000)
			sseRequest(w, "r2", 1767225601000)
			time.Sleep(20 * time.Millisecond)
			fmt.Fprint(w, "event: timeout\ndata: {}\n\n")
		default:
			secondSince.Store(r.URL.Query().Get("since"))
			sseRequest(w, "r2", 1767225601000) // replayed across the reconnect
			sseRequest(w, "r3", 1767225602000)
			fmt.Fprint(w, "event: endpoint_deleted\ndata: {}\n\n")
		}
	})
	ids, err := collectStream(t, api.client(), context.Background(), webhookscc.SubscribeOptions{Reconnect: true, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(ids) != "[r1 r2 r3]" {
		t.Errorf("ids = %v", ids)
	}
	if since, _ := secondSince.Load().(string); since != "1767225600999" {
		t.Errorf("reconnect resumed since %q, want just before the last request", since)
	}
}

func TestSubscribeEndsAtRotationWithoutReconnect(t *testing.T) {
	api := newFakeAPI(t)
	var connections atomic.Int32
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		connections.Add(1)
		sseStart(w)
		sseRequest(w, "r1", 1767225600000)
		fmt.Fprint(w, "event: timeout\ndata: {}\n\n")
	})
	ids, err := collectStream(t, api.client(), context.Background(), webhookscc.SubscribeOptions{})
	if err != nil || fmt.Sprint(ids) != "[r1]" || connections.Load() != 1 {
		t.Errorf("ids %v, err %v, connections %d", ids, err, connections.Load())
	}
}

func TestSubscribeTimeoutEndsQuietly(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		sseStart(w)
		sseRequest(w, "r1", 1767225600000)
		for {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(10 * time.Millisecond):
				fmt.Fprint(w, ": keepalive\n\n") // keepalives must not extend the deadline
				w.(http.Flusher).Flush()
			}
		}
	})
	start := time.Now()
	ids, err := collectStream(t, api.client(), context.Background(), webhookscc.SubscribeOptions{Timeout: 150 * time.Millisecond})
	if err != nil || fmt.Sprint(ids) != "[r1]" {
		t.Errorf("ids %v, err %v", ids, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("the stream outlived its timeout: %s", elapsed)
	}
}

func TestSubscribeIdleConnectionIsATimeout(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		sseStart(w)
		<-r.Context().Done()
	})
	_, err := collectStream(t, api.client(), context.Background(), webhookscc.SubscribeOptions{IdleTimeout: 100 * time.Millisecond})
	if !errors.Is(err, webhookscc.ErrTimeout) {
		t.Errorf("err = %v, want a timeout", err)
	}
}

func TestSubscribeReportsTheCallersContext(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		sseStart(w)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := collectStream(t, api.client(), ctx, webhookscc.SubscribeOptions{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v", err)
	}
}

func TestSubscribeStopsOnClientErrorsAndRetriesServerErrors(t *testing.T) {
	api := newFakeAPI(t)
	var attempts atomic.Int32
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("slug") {
		case "acme-test":
			if attempts.Add(1) < 3 {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			sseStart(w)
			sseRequest(w, "r1", 1767225600000)
			fmt.Fprint(w, "event: endpoint_deleted\ndata: {}\n\n")
		default:
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		}
	})
	client := api.client()
	var reconnects []int
	ids, err := collectStream(t, client, context.Background(), webhookscc.SubscribeOptions{
		Reconnect: true, ReconnectBackoff: time.Millisecond,
		OnReconnect: func(attempt int) { reconnects = append(reconnects, attempt) },
	})
	if err != nil || fmt.Sprint(ids) != "[r1]" || fmt.Sprint(reconnects) != "[1 2]" {
		t.Errorf("ids %v, err %v, reconnects %v", ids, err, reconnects)
	}
	for _, err := range client.Requests.Subscribe(context.Background(), "other", webhookscc.SubscribeOptions{Reconnect: true}) {
		if !errors.Is(err, webhookscc.ErrUnauthorized) {
			t.Errorf("err = %v", err)
		}
	}
}

func TestSubscribeStopsWhenTheLoopBreaks(t *testing.T) {
	api := newFakeAPI(t)
	api.handle("GET /api/stream/{slug}", func(w http.ResponseWriter, r *http.Request) {
		sseStart(w)
		for i := range 100 {
			sseRequest(w, fmt.Sprintf("r%d", i), 1767225600000+int64(i))
		}
		<-r.Context().Done()
	})
	count := 0
	for _, err := range api.client().Requests.Subscribe(context.Background(), "acme-test", webhookscc.SubscribeOptions{}) {
		if err != nil {
			t.Fatal(err)
		}
		if count++; count == 3 {
			break
		}
	}
	if count != 3 {
		t.Errorf("count = %d", count)
	}
}
