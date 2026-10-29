#!/bin/sh
# Install script for whk CLI
# Usage: curl -fsSL https://webhooks.cc/install.sh | sh
# Without root, pick a directory you can write to (created when missing):
#   curl -fsSL https://webhooks.cc/install.sh | WHK_INSTALL_DIR="$HOME/.local/bin" sh
set -eu

REPO="kroqdotdev/webhooks-cc"
BINARY="whk"
INSTALL_DIR="${WHK_INSTALL_DIR:-/usr/local/bin}"
# A quoted "~/..." arrives unexpanded, so expand it here.
case "$INSTALL_DIR" in
  \~) INSTALL_DIR="$HOME" ;;
  \~/*) INSTALL_DIR="$HOME/${INSTALL_DIR#\~/}" ;;
esac
# A relative path is taken from the current directory, and printed in full.
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;;
esac
[ "$INSTALL_DIR" = "/" ] || INSTALL_DIR="${INSTALL_DIR%/}"
RELEASES_API="https://api.github.com/repos/$REPO/releases/latest"

# Cosign keyless verification parameters (GitHub Actions OIDC)
COSIGN_ISSUER="https://token.actions.githubusercontent.com"
COSIGN_IDENTITY_REGEXP="^https://github.com/$REPO/"

# How to install without sudo, for the errors that need it.
no_sudo_hint() {
  echo "To install without sudo, pick a directory you can write to:" >&2
  echo "  curl -fsSL https://webhooks.cc/install.sh | WHK_INSTALL_DIR=\"\$HOME/.local/bin\" sh" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

download_optional() {
  url="$1"
  out="$2"
  curl -fsSL "$url" -o "$out" >/dev/null 2>&1
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  echo "Error: sha256sum or shasum is required for verification" >&2
  exit 1
}

require_cmd curl
require_cmd tar
require_cmd awk
require_cmd sed
require_cmd mktemp

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  OS="linux" ;;
  Darwin*) OS="darwin" ;;
  *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH="x86_64" ;;
  aarch64) ARCH="aarch64" ;;
  arm64)   ARCH="aarch64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Map OS/arch to Rust target triple
case "${OS}_${ARCH}" in
  linux_x86_64)   TARGET="x86_64-unknown-linux-gnu" ;;
  linux_aarch64)  TARGET="aarch64-unknown-linux-gnu" ;;
  darwin_x86_64)  TARGET="x86_64-apple-darwin" ;;
  darwin_aarch64) TARGET="aarch64-apple-darwin" ;;
  *)              echo "Unsupported platform: ${OS}/${ARCH}"; exit 1 ;;
esac

# Build auth header for GitHub API if token is available
AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: token $GITHUB_TOKEN"
fi

# Get latest version
if [ -n "$AUTH_HEADER" ]; then
  VERSION=$(curl -fsSL -H "$AUTH_HEADER" "$RELEASES_API" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
else
  VERSION=$(curl -fsSL "$RELEASES_API" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
fi
if [ -z "$VERSION" ]; then
  echo "Failed to fetch latest version"
  exit 1
fi

# Validate version format
case "$VERSION" in
  v[0-9]*) ;;
  *) echo "Error: unexpected version format: $VERSION" >&2; exit 1 ;;
esac

FILENAME="${BINARY}-${VERSION}-${TARGET}.tar.gz"
RELEASE_BASE="https://github.com/$REPO/releases/download/${VERSION}"
URL="${RELEASE_BASE}/${FILENAME}"
CHECKSUMS_URL="${RELEASE_BASE}/checksums.txt"
SIGSTORE_BUNDLE_URL="${RELEASE_BASE}/checksums.txt.sigstore.json"

echo "Preparing install for $BINARY $VERSION ($TARGET)..."

WHK_TMPDIR=$(mktemp -d)
trap 'rm -rf "$WHK_TMPDIR"' EXIT

echo "Downloading checksums..."
curl -fsSL "$CHECKSUMS_URL" -o "$WHK_TMPDIR/checksums.txt"

# Verify checksums signature with cosign (keyless via sigstore bundle)
signature_verified=0
if download_optional "$SIGSTORE_BUNDLE_URL" "$WHK_TMPDIR/checksums.txt.sigstore.json"; then
  if command -v cosign >/dev/null 2>&1; then
    if cosign verify-blob \
      --bundle "$WHK_TMPDIR/checksums.txt.sigstore.json" \
      --certificate-oidc-issuer "$COSIGN_ISSUER" \
      --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
      "$WHK_TMPDIR/checksums.txt" >/dev/null 2>&1; then
      echo "Signature verified (cosign keyless)."
      signature_verified=1
    else
      echo "Error: cosign signature verification failed." >&2
      exit 1
    fi
  else
    echo "Note: cosign not installed, skipping signature verification."
    echo "      Install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) for full verification."
  fi
else
  echo "Warning: no signature bundle published for ${VERSION}; using checksum-only verification."
fi

echo "Downloading $BINARY archive..."
curl -fsSL "$URL" -o "$WHK_TMPDIR/$FILENAME"

EXPECTED_HASH=$(awk -v f="$FILENAME" '$2 == f || $2 == ("*" f) { print $1; exit }' "$WHK_TMPDIR/checksums.txt")
if [ -z "$EXPECTED_HASH" ]; then
  echo "Error: no checksum entry found for $FILENAME" >&2
  exit 1
fi

ACTUAL_HASH=$(sha256_file "$WHK_TMPDIR/$FILENAME")
if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  echo "Error: checksum verification failed for $FILENAME" >&2
  exit 1
fi
echo "Checksum verified."

tar -xzf "$WHK_TMPDIR/$FILENAME" -C "$WHK_TMPDIR"
if [ ! -f "$WHK_TMPDIR/$BINARY" ]; then
  echo "Error: extracted archive did not contain $BINARY" >&2
  exit 1
fi

# A directory named by WHK_INSTALL_DIR is created when missing, never with sudo.
if [ -n "${WHK_INSTALL_DIR:-}" ] && [ ! -d "$INSTALL_DIR" ]; then
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    echo "Error: could not create $INSTALL_DIR; pick a directory you can write to." >&2
    exit 1
  fi
fi

if [ -w "$INSTALL_DIR" ]; then
  mv "$WHK_TMPDIR/$BINARY" "$INSTALL_DIR/$BINARY"
  chmod +x "$INSTALL_DIR/$BINARY"
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Error: write access to $INSTALL_DIR requires sudo, but sudo is not installed." >&2
    no_sudo_hint
    exit 1
  fi
  echo "Installing to $INSTALL_DIR (requires sudo)..."
  if ! sudo mv "$WHK_TMPDIR/$BINARY" "$INSTALL_DIR/$BINARY" || ! sudo chmod +x "$INSTALL_DIR/$BINARY"; then
    echo "Error: could not install to $INSTALL_DIR with sudo." >&2
    no_sudo_hint
    exit 1
  fi
fi

echo "$BINARY $VERSION installed to $INSTALL_DIR/$BINARY"
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*)
    echo "Run '$BINARY --help' to get started"
    ;;
  *)
    echo "$INSTALL_DIR is not on your PATH. Add it, for example:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo "Or run '$INSTALL_DIR/$BINARY --help' to get started"
    ;;
esac
