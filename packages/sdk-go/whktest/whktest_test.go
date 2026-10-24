package whktest_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	webhookscc "webhooks.cc/go"
	"webhooks.cc/go/whktest"
)

func TestEndpointIsNamedAfterTheTestAndDeleted(t *testing.T) {
	var mu sync.Mutex
	var created string
	var deleted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			created = body.Name
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"ep_1","slug":"tmp-1"}`))
		case http.MethodDelete:
			deleted = append(deleted, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	long := strings.Repeat("x", 150)
	t.Run(long, func(t *testing.T) {
		client := whktest.Client(t, webhookscc.WithAPIKey("whcc_test"), webhookscc.WithBaseURL(server.URL))
		if endpoint := whktest.Endpoint(t, client); endpoint.Slug != "tmp-1" {
			t.Errorf("endpoint = %+v", endpoint)
		}
	})
	mu.Lock()
	defer mu.Unlock()
	if len([]rune(created)) != 100 || !strings.HasPrefix(created, "TestEndpointIsNamedAfterTheTestAndDeleted/xxx") {
		t.Errorf("named %q (%d characters)", created, len(created))
	}
	if len(deleted) != 1 || deleted[0] != "/api/endpoints/tmp-1" {
		t.Errorf("deleted = %v", deleted)
	}
}

func TestClientSkipsWithoutAKey(t *testing.T) {
	t.Setenv(webhookscc.APIKeyEnv, "")
	skipped := t.Run("inner", func(t *testing.T) {
		whktest.Client(t)
		t.Error("not skipped")
	})
	if !skipped {
		t.Error("the inner test failed")
	}
}
