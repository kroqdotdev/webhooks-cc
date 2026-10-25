package verify

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"webhooks.cc/go/internal/conformance"
)

type verifyFile struct {
	Version int            `json:"version"`
	Vectors []verifyVector `json:"vectors"`
}

type verifyVector struct {
	Name        string            `json:"name"`
	Provider    string            `json:"provider"`
	Secret      string            `json:"secret"`
	PublicKey   string            `json:"publicKey"`
	URL         string            `json:"url"`
	Method      string            `json:"method"`
	Now         float64           `json:"now"`
	Body        string            `json:"body"`
	Headers     map[string]string `json:"headers"`
	Certificate string            `json:"certificate"`
	Expected    bool              `json:"expected"`
}

type forwardingFile struct {
	Version int                `json:"version"`
	Vectors []forwardingVector `json:"vectors"`
}

type forwardingVector struct {
	Name       string            `json:"name"`
	Function   string            `json:"function"`
	Secret     string            `json:"secret"`
	Now        float64           `json:"now"`
	Body       string            `json:"body"`
	BodyBase64 *string           `json:"bodyBase64"`
	Headers    map[string]string `json:"headers"`
	Expected   struct {
		OK            bool   `json:"ok"`
		Error         string `json:"error"`
		InvalidSecret bool   `json:"invalidSecret"`
	} `json:"expected"`
}

func loadVerifyVectors(t *testing.T) []verifyVector {
	t.Helper()
	var file verifyFile
	conformance.Load(t, "verify.json", &file)
	if file.Version != 1 {
		t.Fatalf("verify.json is format version %d; update the port", file.Version)
	}
	return file.Vectors
}

func loadForwardingVectors(t *testing.T) []forwardingVector {
	t.Helper()
	var file forwardingFile
	conformance.Load(t, "forwarding.json", &file)
	if file.Version != 3 {
		t.Fatalf("forwarding.json is format version %d; update the port", file.Version)
	}
	return file.Vectors
}

func vectorNamed[V any](t *testing.T, vectors []V, name string, nameOf func(V) string) V {
	t.Helper()
	for _, vector := range vectors {
		if nameOf(vector) == name {
			return vector
		}
	}
	t.Fatalf("no vector named %q", name)
	var zero V
	return zero
}

func (v verifyVector) options(t *testing.T) Options {
	opts := Options{
		Secret:    v.Secret,
		PublicKey: v.PublicKey,
		URL:       v.URL,
		Method:    v.Method,
		Now:       time.UnixMilli(int64(v.Now)),
	}
	certificate := v.Certificate
	opts.FetchCertificate = func(context.Context, string) (string, error) {
		if certificate == "" {
			t.Errorf("%s: a certificate was fetched, but the vector has none", v.Name)
			return "", errors.New("no certificate")
		}
		return certificate, nil
	}
	return opts
}

func TestVerifyVectors(t *testing.T) {
	vectors := loadVerifyVectors(t)
	if len(vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			t.Parallel()
			valid, err := Signature(vector.Provider, []byte(vector.Body), Map(vector.Headers), vector.options(t))
			if err != nil {
				t.Fatalf("Signature: %v", err)
			}
			if valid != vector.Expected {
				t.Errorf("Signature = %v, want %v", valid, vector.Expected)
			}
		})
	}
}

func runForwarding(vector forwardingVector) (string, error) {
	body := []byte(vector.Body)
	if vector.BodyBase64 != nil {
		decoded, err := base64.StdEncoding.DecodeString(*vector.BodyBase64)
		if err != nil {
			return "", err
		}
		body = decoded
	}
	headers := Map(vector.Headers)
	now := WithNow(time.UnixMilli(int64(vector.Now)))
	var err error
	switch vector.Function {
	case "verifyForwardedEmail":
		_, err = ForwardedEmail(body, headers, vector.Secret, now)
	case "verifyForwardedRequest":
		_, err = ForwardedRequest(body, headers, vector.Secret, now)
	case "verifyForwardedJson":
		_, err = ForwardedJSON(body, headers, vector.Secret, now)
	case "verifyRelayedRequest":
		_, err = RelayedRequest(body, headers, vector.Secret)
	default:
		return "", errors.New("unknown function " + vector.Function)
	}
	var verr *Error
	if errors.As(err, &verr) {
		return string(verr.Code), nil
	}
	return "", err
}

func TestForwardingVectors(t *testing.T) {
	vectors := loadForwardingVectors(t)
	if len(vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			t.Parallel()
			code, err := runForwarding(vector)
			if vector.Expected.InvalidSecret {
				if !errors.Is(err, ErrEmptyKey) {
					t.Errorf("got %q, %v; want ErrEmptyKey", code, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if vector.Expected.OK && code != "" {
				t.Errorf("got error %q, want ok", code)
			}
			if !vector.Expected.OK && code != vector.Expected.Error {
				t.Errorf("got %q, want error %q", code, vector.Expected.Error)
			}
		})
	}
}

// Every provider Signature claims to check has vectors, and every vector's
// provider is one it checks.
func TestVectorsCoverEveryProvider(t *testing.T) {
	vectors := loadVerifyVectors(t)
	seen := map[string]bool{}
	for _, vector := range vectors {
		seen[vector.Provider] = true
	}
	for _, provider := range Providers() {
		if !seen[provider] {
			t.Errorf("no vector for %q", provider)
		}
		delete(seen, provider)
	}
	for provider := range seen {
		t.Errorf("vectors for %q, which Providers() does not list", provider)
	}
}
