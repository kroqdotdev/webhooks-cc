// Package sigutil holds the signing primitives that building signed requests
// and verifying signatures share. They mirror the TypeScript SDK byte for
// byte; the conformance vectors in packages/sdk/conformance check that they do.
package sigutil

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"unicode/utf16"

	"webhooks.cc/go/internal/jsonx"
	"webhooks.cc/go/internal/webtext"
)

// HMACSHA256 is the HMAC-SHA256 of payload under key.
func HMACSHA256(key, payload []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(payload)
	return mac.Sum(nil)
}

// HMACSHA1 is the HMAC-SHA1 of payload under key.
func HMACSHA1(key, payload []byte) []byte {
	mac := hmac.New(sha1.New, key)
	mac.Write(payload)
	return mac.Sum(nil)
}

// Hex is lowercase hex.
func Hex(data []byte) string { return hex.EncodeToString(data) }

// Base64 is standard base64 with padding.
func Base64(data []byte) string { return base64.StdEncoding.EncodeToString(data) }

// Base64URL is base64url without padding.
func Base64URL(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

var errInvalidBase64 = errors.New("invalid base64")

// DecodeBase64 decodes base64 the way browsers' atob does (WHATWG
// forgiving-base64): ASCII whitespace is ignored and padding is optional. It
// fails for a character outside A-Z a-z 0-9 + /, an = anywhere but as one or
// two final characters that make the length a multiple of 4, or 4n+1
// characters once padding is removed.
func DecodeBase64(value string) ([]byte, error) {
	data := strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\n', '\f', '\r', ' ':
			return -1
		}
		return r
	}, value)
	if len(data)%4 == 0 {
		if strings.HasSuffix(data, "==") {
			data = data[:len(data)-2]
		} else if strings.HasSuffix(data, "=") {
			data = data[:len(data)-1]
		}
	}
	if len(data)%4 == 1 {
		return nil, errInvalidBase64
	}
	for i := 0; i < len(data); i++ {
		c := data[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/') {
			return nil, errInvalidBase64
		}
	}
	// atob ignores bits left over in the last character; RawStdEncoding in
	// non-strict mode does too.
	return base64.RawStdEncoding.DecodeString(data)
}

// HexToBytes decodes a hex string after trimming surrounding whitespace.
func HexToBytes(value string) ([]byte, error) {
	normalized := webtext.JSTrim(value)
	if normalized == "" || len(normalized)%2 != 0 {
		return nil, errors.New("expected a hex-encoded value")
	}
	return hex.DecodeString(normalized)
}

// ErrEmptyKey is returned for a Standard Webhooks style secret that decodes
// to no key at all, such as "whsec_" or whitespace. An HMAC keyed with
// nothing is one anyone can compute, so it is refused, as WebCrypto refuses
// it in the TypeScript SDK.
var ErrEmptyKey = errors.New("the secret decodes to an empty key")

// StandardWebhookKey is the HMAC key for a Standard Webhooks style secret, as
// Standard Webhooks, Clerk, Resend and webhooks.cc forwarding use them.
//
// A leading whsec_ is stripped and the rest decoded as base64. When that
// fails, the key is the UTF-8 bytes of the whole secret, prefix included. A
// key of zero bytes is ErrEmptyKey.
func StandardWebhookKey(secret string) ([]byte, error) {
	key, err := DecodeBase64(strings.TrimPrefix(secret, "whsec_"))
	if err != nil {
		key = []byte(secret)
	}
	if len(key) == 0 {
		return nil, ErrEmptyKey
	}
	return key, nil
}

var hubspotEscapes = strings.NewReplacer(
	"%3A", ":", "%2F", "/", "%3F", "?", "%40", "@", "%21", "!", "%24", "$",
	"%27", "'", "%28", "(", "%29", ")", "%2A", "*", "%2C", ",", "%3B", ";",
)

// HubSpotDecodeURI decodes exactly the escapes HubSpot decodes before signing,
// uppercase only.
func HubSpotDecodeURI(uri string) string { return hubspotEscapes.Replace(uri) }

// compareUTF16 compares strings by UTF-16 code unit, as JavaScript does.
func compareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

// TwilioPayload is the URL followed by each parameter's name and value, sorted
// by name and then by value.
func TwilioPayload(url string, params [][2]string) string {
	ordered := slices.Clone(params)
	slices.SortStableFunc(ordered, func(a, b [2]string) int {
		if c := compareUTF16(a[0], b[0]); c != 0 {
			return c
		}
		return compareUTF16(a[1], b[1])
	})
	var out strings.Builder
	out.WriteString(url)
	for _, param := range ordered {
		out.WriteString(param[0])
		out.WriteString(param[1])
	}
	return out.String()
}

func adyenField(value any, present bool) string {
	if !present || value == nil {
		return ""
	}
	return jsonx.String(value)
}

// AdyenDataToSign joins the fields of an Adyen notification item that its
// HMAC covers with ":", a missing field as empty.
func AdyenDataToSign(item jsonx.Object) string {
	field := func(object jsonx.Object, key string) string {
		value, ok := object.Get(key)
		return adyenField(value, ok)
	}
	var amount jsonx.Object
	if value, ok := item.Get("amount"); ok {
		amount, _ = value.(jsonx.Object)
	}
	return strings.Join([]string{
		field(item, "pspReference"),
		field(item, "originalReference"),
		field(item, "merchantAccountCode"),
		field(item, "merchantReference"),
		field(amount, "value"),
		field(amount, "currency"),
		field(item, "eventCode"),
		field(item, "success"),
	}, ":")
}

// AdyenHMAC is the base64 HMAC-SHA256 of an Adyen notification item, keyed
// with the hex HMAC key.
func AdyenHMAC(item jsonx.Object, hexKey string) (string, error) {
	key, err := HexToBytes(hexKey)
	if err != nil {
		return "", err
	}
	return Base64(HMACSHA256(key, []byte(AdyenDataToSign(item)))), nil
}
