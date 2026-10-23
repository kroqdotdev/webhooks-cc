package verify

import (
	"bytes"
	"crypto/subtle"
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"webhooks.cc/go/internal/sigutil"
)

// The checks follow the TypeScript SDK, so text is handled as JavaScript
// handles it: trimmed of JavaScript's whitespace, numbers read as Number()
// reads them, and bytes decoded as TextDecoder decodes them.

// jsWhitespace is what String.prototype.trim and Number() strip.
const jsWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func jsTrim(s string) string { return strings.Trim(s, jsWhitespace) }

var (
	jsDecimal = regexp.MustCompile(`^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$`)
	jsRadix   = regexp.MustCompile(`^0([xXoObB])([0-9a-zA-Z]+)$`)
)

// jsNumber is JavaScript's Number(value) for a header value: NaN when it is
// not a number, 0 when it is empty.
func jsNumber(value string) float64 {
	text := jsTrim(value)
	if text == "" {
		return 0
	}
	if jsDecimal.MatchString(text) {
		number, err := strconv.ParseFloat(text, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return math.NaN()
		}
		return number
	}
	if match := jsRadix.FindStringSubmatch(text); match != nil {
		base := map[byte]int{'x': 16, 'o': 8, 'b': 2}[match[1][0]|0x20]
		integer, ok := new(big.Int).SetString(match[2], base)
		if !ok {
			return math.NaN()
		}
		number, _ := new(big.Float).SetInt(integer).Float64()
		return number
	}
	return math.NaN()
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// bodyText decodes a body as TextDecoder does: a leading BOM is dropped and
// each invalid sequence becomes one U+FFFD.
func bodyText(body []byte) string {
	return decodeUTF8(bytes.TrimPrefix(body, utf8BOM))
}

func decodeUTF8(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var out strings.Builder
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		if r != utf8.RuneError || size > 1 {
			out.Write(data[:size])
			data = data[size:]
			continue
		}
		out.WriteRune(utf8.RuneError)
		data = data[maximalSubpart(data):]
	}
	return out.String()
}

// maximalSubpart is how many bytes of an invalid sequence one U+FFFD
// replaces: the lead byte and the continuation bytes that could still have
// completed it (the WHATWG and Unicode rule).
func maximalSubpart(data []byte) int {
	lead := data[0]
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
	for ; i <= need && i < len(data); i++ {
		if i == 1 && (data[i] < low || data[i] > high) || i > 1 && (data[i] < 0x80 || data[i] > 0xBF) {
			break
		}
	}
	return i
}

// formParams reads a form body as URLSearchParams does.
func formParams(text string) [][2]string {
	text = strings.TrimPrefix(text, "?")
	var params [][2]string
	for _, piece := range strings.Split(text, "&") {
		if piece == "" {
			continue
		}
		name, value, _ := strings.Cut(piece, "=")
		params = append(params, [2]string{formDecode(name), formDecode(value)})
	}
	return params
}

func formDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	if !strings.Contains(s, "%") {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			value, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			out = append(out, byte(value))
			i += 2
			continue
		}
		out = append(out, s[i])
	}
	return decodeUTF8(out)
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// cutPrefixFold removes prefix matched in any ASCII case, as a JavaScript
// /i regular expression without the u flag matches it, and requires
// something after it.
func cutPrefixFold(s, prefix string) (string, bool) {
	if len(s) <= len(prefix) {
		return "", false
	}
	for i := 0; i < len(prefix); i++ {
		if lowerASCII(s[i]) != lowerASCII(prefix[i]) {
			return "", false
		}
	}
	return s[len(prefix):], true
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

// safeEqual compares in constant time for strings of the same length.
func safeEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func hmacSHA256Hex(secret string, payload []byte) string {
	return sigutil.Hex(sigutil.HMACSHA256([]byte(secret), payload))
}

func hmacSHA1Hex(secret string, payload []byte) string {
	return sigutil.Hex(sigutil.HMACSHA1([]byte(secret), payload))
}

func hmacSHA256Base64(key []byte, payload []byte) string {
	return sigutil.Base64(sigutil.HMACSHA256(key, payload))
}

func concat(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}
