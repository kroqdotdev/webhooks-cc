package templates

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"webhooks.cc/go/internal/jsonx"
)

// Random values, as the TypeScript SDK makes them.

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never fails
	return b
}

func randomHex(length int) string {
	return hex.EncodeToString(randomBytes((length + 1) / 2))[:length]
}

func randomToken(prefix string) string { return prefix + "_" + randomHex(8) }

func randomSID(prefix string) string { return prefix + randomHex(32) }

func randomDigits(length int) string {
	var out strings.Builder
	for _, b := range randomBytes(length) {
		out.WriteByte('0' + b%10)
	}
	return out.String()
}

func randomNumber(digits int) int64 {
	number, _ := strconv.ParseInt(randomDigits(digits), 10, 64)
	return number
}

func randomUUID() string {
	b := randomBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// isoTime is new Date(ms).toISOString(): UTC with milliseconds and a Z.
func isoTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// Form bodies, as URLSearchParams writes and reads them.

const upperHex = "0123456789ABCDEF"

// formComponent escapes everything but alphanumerics and *-._, and writes a
// space as +.
func formComponent(value string) string {
	value = strings.ToValidUTF8(value, "�")
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '*', c == '-', c == '.', c == '_':
			out.WriteByte(c)
		case c == ' ':
			out.WriteByte('+')
		default:
			out.WriteByte('%')
			out.WriteByte(upperHex[c>>4])
			out.WriteByte(upperHex[c&0xf])
		}
	}
	return out.String()
}

// formEncode is new URLSearchParams(params).toString().
func formEncode(params [][2]string) string {
	parts := make([]string, len(params))
	for i, param := range params {
		parts[i] = formComponent(param[0]) + "=" + formComponent(param[1])
	}
	return strings.Join(parts, "&")
}

// formDecode returns the entries of new URLSearchParams(body), repeats and
// order kept.
func formDecode(body string) [][2]string {
	body = strings.TrimPrefix(body, "?")
	var out [][2]string
	for _, piece := range strings.Split(body, "&") {
		if piece == "" {
			continue
		}
		name, value, _ := strings.Cut(piece, "=")
		out = append(out, [2]string{percentDecode(name), percentDecode(value)})
	}
	return out
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// percentDecode turns + into a space and decodes %XX escapes, leaving a
// malformed escape as it is, then reads the bytes as UTF-8 with replacement.
func percentDecode(value string) string {
	out := make([]byte, 0, len(value))
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c == '+':
			out = append(out, ' ')
		case c == '%' && i+2 < len(value):
			high, ok1 := unhex(value[i+1])
			low, ok2 := unhex(value[i+2])
			if ok1 && ok2 {
				out = append(out, high<<4|low)
				i += 2
				continue
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return decodeUTF8(out)
}

// decodeUTF8 replaces each maximal ill-formed subsequence with U+FFFD, as the
// WHATWG decoder does.
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size <= 1 {
			out.WriteRune(utf8.RuneError)
			i += maximalSubpart(b[i:])
			continue
		}
		out.Write(b[i : i+size])
		i += size
	}
	return out.String()
}

// maximalSubpart is the length of the ill-formed sequence starting at b[0]:
// a lead byte and the continuation bytes that could still have completed it.
func maximalSubpart(b []byte) int {
	lead := b[0]
	need := 0
	low, high := byte(0x80), byte(0xBF)
	switch {
	case lead >= 0xC2 && lead <= 0xDF:
		need = 1
	case lead == 0xE0:
		need, low = 2, 0xA0
	case lead == 0xED:
		need, high = 2, 0x9F
	case lead >= 0xE1 && lead <= 0xEF:
		need = 2
	case lead == 0xF0:
		need, low = 3, 0x90
	case lead == 0xF4:
		need, high = 3, 0x8F
	case lead >= 0xF1 && lead <= 0xF3:
		need = 3
	default:
		return 1
	}
	i := 1
	for ; i <= need && i < len(b); i++ {
		c := b[i]
		if i == 1 && (c < low || c > high) || i > 1 && (c < 0x80 || c > 0xBF) {
			break
		}
	}
	return i
}

// stringRecord reads a body override as form parameters the way the
// TypeScript SDK does: an object's entries with each value as String(value)
// (null as empty). Anything that is not an object (arrays included) is refused.
// Values pass through JSON first, so Go maps (keys sorted) and structs work.
func stringRecord(value any) ([][2]string, bool) {
	text, err := jsonx.Stringify(value)
	if err != nil {
		return nil, false
	}
	parsed, err := jsonx.Parse([]byte(text))
	if err != nil {
		return nil, false
	}
	object, ok := parsed.(jsonx.Object)
	if !ok {
		return nil, false
	}
	params := make([][2]string, 0, len(object))
	// Stringify wrote the keys in JavaScript's enumeration order, which Parse kept.
	for _, member := range object {
		if member.Value == nil {
			params = append(params, [2]string{member.Key, ""})
			continue
		}
		params = append(params, [2]string{member.Key, jsonx.String(member.Value)})
	}
	return params, true
}
