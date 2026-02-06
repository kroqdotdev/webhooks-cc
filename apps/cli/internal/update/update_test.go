package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
)

// NOTE: Tests in this file MUST NOT use t.Parallel() because they mutate
// the package-level httpClient variable.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// withTestHTTPClient saves and restores the package-level httpClient.
func withTestHTTPClient(t *testing.T, client *http.Client) {
	t.Helper()
	orig := httpClient
	httpClient = client
	t.Cleanup(func() { httpClient = orig })
}

// ---------------------------------------------------------------------------
// validateGitHubURL
// ---------------------------------------------------------------------------

func TestValidateGitHubURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{"github.com", "https://github.com/user/repo/releases/download/v1.0/file.tar.gz", false},
		{"githubusercontent.com", "https://objects.githubusercontent.com/abc/def", false},
		{"subdomain of githubusercontent", "https://objects.githubusercontent.com/path", false},
		{"other host", "https://evil.com/file.tar.gz", true},
		{"no scheme", "github.com/file", true},
		{"empty", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateGitHubURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateGitHubURL(%q) error = %v, wantErr %v", tt.url, err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// fetchChecksum
// ---------------------------------------------------------------------------

func TestFetchChecksum(t *testing.T) {
	checksumContent := "abc123def456  whk_linux_amd64.tar.gz\n789012fed345  whk_darwin_arm64.tar.gz\n"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(checksumContent))
	}))
	defer server.Close()

	withTestHTTPClient(t, server.Client())

	hash, err := fetchChecksum(context.Background(), server.URL+"/checksums.txt", "whk_linux_amd64.tar.gz")
	if err != nil {
		t.Fatalf("fetchChecksum: %v", err)
	}
	if hash != "abc123def456" {
		t.Errorf("expected abc123def456, got %s", hash)
	}
}

func TestFetchChecksum_MissingAsset(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("abc123  other_file.tar.gz\n"))
	}))
	defer server.Close()

	withTestHTTPClient(t, server.Client())

	_, err := fetchChecksum(context.Background(), server.URL+"/checksums.txt", "whk_linux_amd64.tar.gz")
	if err == nil {
		t.Fatal("expected error for missing asset in checksums")
	}
}

// ---------------------------------------------------------------------------
// assetName
// ---------------------------------------------------------------------------

func TestAssetName(t *testing.T) {
	name := assetName()

	expectedExt := "tar.gz"
	if runtime.GOOS == "windows" {
		expectedExt = "zip"
	}
	expected := fmt.Sprintf("whk_%s_%s.%s", runtime.GOOS, runtime.GOARCH, expectedExt)

	if name != expected {
		t.Errorf("assetName() = %q, want %q", name, expected)
	}
}

// ---------------------------------------------------------------------------
// extractTarGz
// ---------------------------------------------------------------------------

func createTestTarGz(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	for name, content := range files {
		hdr := &tar.Header{
			Name: name,
			Mode: 0755,
			Size: int64(len(content)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("tar WriteHeader: %v", err)
		}
		if _, err := tw.Write(content); err != nil {
			t.Fatalf("tar Write: %v", err)
		}
	}

	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractTarGz_Success(t *testing.T) {
	content := []byte("#!/bin/sh\necho hello\n")
	archive := createTestTarGz(t, map[string][]byte{
		"dist/whk": content,
	})

	destFile, err := os.CreateTemp(t.TempDir(), "whk-test-*")
	if err != nil {
		t.Fatal(err)
	}

	if err := extractTarGz(bytes.NewReader(archive), destFile); err != nil {
		t.Fatalf("extractTarGz: %v", err)
	}

	if err := destFile.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(destFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("extracted content mismatch: got %q, want %q", got, content)
	}
}

func TestExtractTarGz_MissingBinary(t *testing.T) {
	archive := createTestTarGz(t, map[string][]byte{
		"dist/other-binary": []byte("not whk"),
	})

	destFile, err := os.CreateTemp(t.TempDir(), "whk-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = destFile.Close() }()

	err = extractTarGz(bytes.NewReader(archive), destFile)
	if err == nil {
		t.Fatal("expected error for missing whk binary in archive")
	}
}

// ---------------------------------------------------------------------------
// extractZip
// ---------------------------------------------------------------------------

func createTestZip(t *testing.T, files map[string][]byte) string {
	t.Helper()
	path := t.TempDir() + "/test.zip"
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}

	zw := zip.NewWriter(f)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(content); err != nil {
			t.Fatal(err)
		}
	}

	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractZip_Success(t *testing.T) {
	content := []byte("windows binary content")
	archivePath := createTestZip(t, map[string][]byte{
		"whk.exe": content,
	})

	destPath := t.TempDir() + "/whk.exe"
	if err := extractZip(archivePath, destPath); err != nil {
		t.Fatalf("extractZip: %v", err)
	}

	got, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("extracted content mismatch: got %q, want %q", got, content)
	}
}

func TestExtractZip_MissingBinary(t *testing.T) {
	archivePath := createTestZip(t, map[string][]byte{
		"other.exe": []byte("not whk"),
	})

	destPath := t.TempDir() + "/whk.exe"
	err := extractZip(archivePath, destPath)
	if err == nil {
		t.Fatal("expected error for missing whk.exe in archive")
	}
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

// TestCheck_WithTransportMock properly tests Check by mocking at transport level
func TestCheck_WithTransportMock(t *testing.T) {
	tests := []struct {
		name           string
		currentVersion string
		latestTag      string
		wantAvailable  bool
	}{
		{"newer available", "1.0.0", "v2.0.0", true},
		{"same version", "1.0.0", "v1.0.0", false},
		{"dev version", "dev", "v2.0.0", false},
		{"older available", "2.0.0", "v1.0.0", false},
		{"patch bump", "1.0.0", "v1.0.1", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(Release{
					TagName: tt.latestTag,
					Assets:  []Asset{{Name: "test.tar.gz"}},
				})
			}))
			defer server.Close()

			// Use a transport that redirects GitHub API calls to our test server
			withTestHTTPClient(t, &http.Client{
				Transport: &mockTransport{
					redirectURL: server.URL,
					inner:       http.DefaultTransport,
				},
			})

			release, available, err := Check(context.Background(), tt.currentVersion)
			if err != nil {
				t.Fatalf("Check: %v", err)
			}
			if release == nil {
				t.Fatal("expected non-nil release")
			}
			if available != tt.wantAvailable {
				t.Errorf("Check(%q, latest=%q) available = %v, want %v",
					tt.currentVersion, tt.latestTag, available, tt.wantAvailable)
			}
		})
	}
}

// mockTransport redirects all requests to a test server
type mockTransport struct {
	redirectURL string
	inner       http.RoundTripper
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Redirect to test server
	newURL := m.redirectURL + req.URL.Path
	newReq, err := http.NewRequestWithContext(req.Context(), req.Method, newURL, req.Body)
	if err != nil {
		return nil, err
	}
	newReq.Header = req.Header
	return m.inner.RoundTrip(newReq)
}

func TestFetchChecksum_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer server.Close()

	withTestHTTPClient(t, server.Client())

	_, err := fetchChecksum(context.Background(), server.URL+"/checksums.txt", "file.tar.gz")
	if err == nil {
		t.Fatal("expected error for HTTP 500")
	}
}
