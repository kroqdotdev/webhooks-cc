package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadToken_Roundtrip(t *testing.T) {
	// Override HOME to use temp dir
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	want := &Token{
		AccessToken: "test-token-123",
		UserID:      "user-456",
		Email:       "test@example.com",
	}

	if err := SaveToken(want); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	got, err := LoadToken()
	if err != nil {
		t.Fatalf("LoadToken: %v", err)
	}

	if got.AccessToken != want.AccessToken || got.UserID != want.UserID || got.Email != want.Email {
		t.Errorf("roundtrip mismatch: got %+v, want %+v", got, want)
	}
}

func TestSaveToken_FilePermissions(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	if err := SaveToken(&Token{AccessToken: "secret"}); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	tokenPath := filepath.Join(tmpDir, configDir, tokenFile)
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("expected file permissions 0600, got %o", perm)
	}
}

func TestLoadToken_MissingFile(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	_, err := LoadToken()
	if err == nil {
		t.Fatal("expected error for missing token file, got nil")
	}
}

func TestLoadToken_CorruptJSON(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	// Create the config dir and write invalid JSON
	configPath := filepath.Join(tmpDir, configDir)
	if err := os.MkdirAll(configPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configPath, tokenFile), []byte("not-json{{{"), 0600); err != nil {
		t.Fatal(err)
	}

	_, err := LoadToken()
	if err == nil {
		t.Fatal("expected error for corrupt JSON, got nil")
	}
}

func TestClearToken(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	// Save then clear
	if err := SaveToken(&Token{AccessToken: "to-delete"}); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	if err := ClearToken(); err != nil {
		t.Fatalf("ClearToken: %v", err)
	}

	// Subsequent LoadToken should fail
	_, err := LoadToken()
	if err == nil {
		t.Fatal("expected error after ClearToken, got nil")
	}
}

func TestIsLoggedIn_True(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	if err := SaveToken(&Token{AccessToken: "valid-token"}); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	if !IsLoggedIn() {
		t.Error("expected IsLoggedIn=true with valid token")
	}
}

func TestIsLoggedIn_False_MissingFile(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	if IsLoggedIn() {
		t.Error("expected IsLoggedIn=false with no token file")
	}
}

func TestIsLoggedIn_False_EmptyAccessToken(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	if err := SaveToken(&Token{AccessToken: "", UserID: "user-1"}); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	if IsLoggedIn() {
		t.Error("expected IsLoggedIn=false with empty AccessToken")
	}
}

func TestGetConfigPath(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	path, err := GetConfigPath()
	if err != nil {
		t.Fatalf("GetConfigPath: %v", err)
	}

	expected := filepath.Join(tmpDir, configDir)
	if path != expected {
		t.Errorf("GetConfigPath = %q, want %q", path, expected)
	}
}

func TestSaveToken_CreatesDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	configPath := filepath.Join(tmpDir, configDir)

	// Directory should not exist yet
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatal("config dir should not exist yet")
	}

	if err := SaveToken(&Token{AccessToken: "test"}); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}

	// Directory should exist now
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("config dir not created: %v", err)
	}
	if !info.IsDir() {
		t.Error("config path should be a directory")
	}
}

func TestLoadToken_ValidJSON(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	configPath := filepath.Join(tmpDir, configDir)
	if err := os.MkdirAll(configPath, 0700); err != nil {
		t.Fatal(err)
	}

	// Write well-formed JSON with extra fields (forward compat)
	data, _ := json.Marshal(map[string]string{
		"access_token": "tok-abc",
		"user_id":      "uid-123",
		"email":        "user@test.com",
		"extra_field":  "ignored",
	})
	if err := os.WriteFile(filepath.Join(configPath, tokenFile), data, 0600); err != nil {
		t.Fatal(err)
	}

	got, err := LoadToken()
	if err != nil {
		t.Fatalf("LoadToken: %v", err)
	}
	if got.AccessToken != "tok-abc" {
		t.Errorf("AccessToken = %q, want tok-abc", got.AccessToken)
	}
}
