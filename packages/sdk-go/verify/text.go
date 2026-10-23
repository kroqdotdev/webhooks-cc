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

	"webhooks.cc/go/internal/sigutil"
	"webhooks.cc/go/internal/webtext"
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
	return webtext.DecodeUTF8(bytes.TrimPrefix(body, utf8BOM))
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
