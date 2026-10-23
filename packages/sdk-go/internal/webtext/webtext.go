// Package webtext decodes text the way browsers and Node do, so request
// building and signature verification read form bodies identically: a
// Twilio request the SDK signs must verify with the SDK.
package webtext

import (
	"strings"
	"unicode/utf8"
)

// DecodeUTF8 decodes bytes as UTF-8, replacing each maximal ill-formed
// subsequence with one U+FFFD, as the WHATWG decoder (TextDecoder) does.
func DecodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r != utf8.RuneError || size > 1 {
			out.Write(b[:size])
			b = b[size:]
			continue
		}
		out.WriteRune(utf8.RuneError)
		b = b[maximalSubpart(b):]
	}
	return out.String()
}

// maximalSubpart is how many bytes of an invalid sequence one U+FFFD
// replaces: the lead byte and the continuation bytes that could still have
// completed it (the WHATWG and Unicode rule).
func maximalSubpart(b []byte) int {
	lead := b[0]
	need, low, high := 0, byte(0x80), byte(0xBF)
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
		if i == 1 && (b[i] < low || b[i] > high) || i > 1 && (b[i] < 0x80 || b[i] > 0xBF) {
			break
		}
	}
	return i
}

// FormParams returns the entries of new URLSearchParams(text): a leading ?
// dropped, repeats and order kept.
func FormParams(text string) [][2]string {
	text = strings.TrimPrefix(text, "?")
	var params [][2]string
	for _, piece := range strings.Split(text, "&") {
		if piece == "" {
			continue
		}
		name, value, _ := strings.Cut(piece, "=")
		params = append(params, [2]string{FormDecode(name), FormDecode(value)})
	}
	return params
}

// FormDecode turns + into a space and decodes %XX escapes, leaving a
// malformed escape as it is, then reads the bytes as UTF-8 with replacement.
func FormDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	if !strings.Contains(s, "%") {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			high, okHigh := unhex(s[i+1])
			low, okLow := unhex(s[i+2])
			if okHigh && okLow {
				out = append(out, high<<4|low)
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return DecodeUTF8(out)
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
