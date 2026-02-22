package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

const (
	repo           = "kroqdotdev/webhooks-cc"
	binary         = "whk"
	maxBinarySize  = 100 * 1024 * 1024 // 100 MB
	maxAPIResponse = 1 * 1024 * 1024   // 1 MB
)

var httpClient = &http.Client{Timeout: 60 * time.Second}

type Release struct {
	TagName string  `json:"tag_name"`
	Assets  []Asset `json:"assets"`
}

type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// Check fetches the latest release and reports whether an update is available.
func Check(ctx context.Context, currentVersion string) (*Release, bool, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", fmt.Sprintf("whk-cli/%s", currentVersion))

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("failed to check for updates: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, false, fmt.Errorf("GitHub API returned %d: %s", resp.StatusCode, string(body))
	}

	var release Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxAPIResponse)).Decode(&release); err != nil {
		return nil, false, fmt.Errorf("failed to parse release info: %w", err)
	}

	latest := strings.TrimPrefix(release.TagName, "v")
	if currentVersion == "dev" || latest == currentVersion {
		return &release, false, nil
	}

	// Proper semver comparison: only update if latest is newer.
	if semver.Compare("v"+latest, "v"+currentVersion) <= 0 {
		return &release, false, nil
	}

	return &release, true, nil
}

// Apply downloads the release and replaces the current binary.
// It verifies the download against the checksums.txt in the release.
func Apply(ctx context.Context, release *Release) error {
	name := assetName()

	var downloadURL, checksumsURL string
	for _, a := range release.Assets {
		switch a.Name {
		case name:
			downloadURL = a.BrowserDownloadURL
		case "checksums.txt":
			checksumsURL = a.BrowserDownloadURL
		}
	}
	if downloadURL == "" {
		return fmt.Errorf("no release asset for %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	// Validate download URLs point to GitHub.
	for _, u := range []string{downloadURL, checksumsURL} {
		if u == "" {
			continue
		}
		if err := validateGitHubURL(u); err != nil {
			return err
		}
	}

	// Fetch expected checksum first.
	var expectedHash string
	if checksumsURL != "" {
		var err error
		expectedHash, err = fetchChecksum(ctx, checksumsURL, name)
		if err != nil {
			return fmt.Errorf("checksum verification failed: %w", err)
		}
	}

	// Download the archive.
	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "whk-cli/update")

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	// Download to a temp file so we can verify the checksum before extracting.
	archiveFile, err := os.CreateTemp("", "whk-archive-*")
	if err != nil {
		return err
	}
	archivePath := archiveFile.Name()
	defer func() { _ = os.Remove(archivePath) }()

	hasher := sha256.New()
	writer := io.MultiWriter(archiveFile, hasher)
	if _, err := io.Copy(writer, io.LimitReader(resp.Body, maxBinarySize)); err != nil {
		_ = archiveFile.Close()
		return fmt.Errorf("download failed: %w", err)
	}
	if err := archiveFile.Close(); err != nil {
		return fmt.Errorf("failed to write archive: %w", err)
	}

	// Verify checksum.
	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if expectedHash != "" && actualHash != expectedHash {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedHash, actualHash)
	}

	// Determine where the current binary lives.
	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine executable path: %w", err)
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return fmt.Errorf("cannot resolve executable path: %w", err)
	}

	dir := filepath.Dir(execPath)
	tmpFile, err := os.CreateTemp(dir, ".whk-update-*")
	if err != nil {
		return fmt.Errorf("cannot write to %s (try running with sudo): %w", dir, err)
	}
	tmpPath := tmpFile.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	// Extract binary from the verified archive.
	if strings.HasSuffix(name, ".zip") {
		_ = tmpFile.Close()
		if err := extractZip(archivePath, tmpPath); err != nil {
			return err
		}
	} else {
		af, err := os.Open(archivePath)
		if err != nil {
			_ = tmpFile.Close()
			return err
		}
		if err := extractTarGz(af, tmpFile); err != nil {
			_ = af.Close()
			_ = tmpFile.Close()
			return err
		}
		_ = af.Close()
		if err := tmpFile.Close(); err != nil {
			return fmt.Errorf("failed to write extracted binary: %w", err)
		}
	}

	if err := os.Chmod(tmpPath, 0755); err != nil {
		return fmt.Errorf("cannot set permissions: %w", err)
	}

	if err := os.Rename(tmpPath, execPath); err != nil {
		return fmt.Errorf("cannot replace binary (try running with sudo): %w", err)
	}

	return nil
}

func assetName() string {
	ext := "tar.gz"
	if runtime.GOOS == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("%s_%s_%s.%s", binary, runtime.GOOS, runtime.GOARCH, ext)
}

func validateGitHubURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid download URL: %w", err)
	}
	host := strings.ToLower(parsed.Host)
	if host != "github.com" && !strings.HasSuffix(host, ".githubusercontent.com") {
		return fmt.Errorf("refusing to download from untrusted host: %s", host)
	}
	return nil
}

func fetchChecksum(ctx context.Context, checksumsURL, assetName string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", checksumsURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "whk-cli/update")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("failed to fetch checksums (HTTP %d)", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIResponse))
	if err != nil {
		return "", err
	}

	// checksums.txt format: "<hash>  <filename>" per line.
	for _, line := range strings.Split(string(body), "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 && parts[1] == assetName {
			return parts[0], nil
		}
	}

	return "", fmt.Errorf("no checksum found for %s", assetName)
}

// extractTarGz extracts the whk binary from a tar.gz archive.
// Only matches by base name; writes to a pre-allocated dest file,
// so header.Name is never used to construct a file path.
func extractTarGz(r io.Reader, dest *os.File) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("failed to decompress: %w", err)
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read archive: %w", err)
		}
		if header.Typeflag == tar.TypeReg && filepath.Base(header.Name) == binary {
			if _, err := io.Copy(dest, io.LimitReader(tr, maxBinarySize)); err != nil {
				return fmt.Errorf("failed to extract binary: %w", err)
			}
			return nil
		}
	}
	return fmt.Errorf("binary %q not found in archive", binary)
}

// extractZip extracts the whk.exe binary from a zip archive on disk.
func extractZip(archivePath, destPath string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("failed to open archive: %w", err)
	}
	defer func() { _ = zr.Close() }()

	target := binary + ".exe"
	for _, f := range zr.File {
		if filepath.Base(f.Name) != target {
			continue
		}
		src, err := f.Open()
		if err != nil {
			return err
		}

		dst, err := os.Create(destPath)
		if err != nil {
			_ = src.Close()
			return err
		}

		_, copyErr := io.Copy(dst, io.LimitReader(src, maxBinarySize))
		closeErr1 := src.Close()
		closeErr2 := dst.Close()
		if copyErr != nil {
			return fmt.Errorf("failed to extract binary: %w", copyErr)
		}
		if closeErr1 != nil {
			return fmt.Errorf("failed to close archive entry: %w", closeErr1)
		}
		if closeErr2 != nil {
			return fmt.Errorf("failed to close destination file: %w", closeErr2)
		}
		return nil
	}
	return fmt.Errorf("binary %q not found in archive", target)
}
