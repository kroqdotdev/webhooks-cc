// Package jsonx reads and writes JSON the way JavaScript does.
//
// Signatures cover bodies byte for byte, and the TypeScript SDK is the
// reference, so bodies the SDK builds must match JSON.stringify exactly:
// keys in their original order, no spaces, numbers formatted like
// String(number), and no escaping of <, >, & or non-ASCII characters.
// encoding/json sorts map keys and escapes HTML characters, so it cannot be
// used for them.
package jsonx

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Member is one key and value of an Object.
type Member struct {
	Key   string
	Value any
}

// Object is a JSON object that keeps its keys in order.
type Object []Member

// Get returns the value of key and whether it is present.
func (o Object) Get(key string) (any, bool) {
	for _, member := range o {
		if member.Key == key {
			return member.Value, true
		}
	}
	return nil, false
}

// Set replaces the value of key where it is, or appends it.
func (o *Object) Set(key string, value any) {
	for i := range *o {
		if (*o)[i].Key == key {
			(*o)[i].Value = value
			return
		}
	}
	*o = append(*o, Member{Key: key, Value: value})
}

// Parse reads JSON like JSON.parse: objects become Object, arrays []any,
// numbers float64, and a repeated key keeps its first position with the last
// value.
func Parse(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := parseValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("jsonx: unexpected data after the top-level value")
	}
	return value, nil
}

func parseValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token := token.(type) {
	case json.Delim:
		switch token {
		case '{':
			object := Object{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("jsonx: object key is not a string")
				}
				value, err := parseValue(decoder)
				if err != nil {
					return nil, err
				}
				object.Set(key, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			array := []any{}
			for decoder.More() {
				value, err := parseValue(decoder)
				if err != nil {
					return nil, err
				}
				array = append(array, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return array, nil
		}
		return nil, fmt.Errorf("jsonx: unexpected %v", token)
	case json.Number:
		number, err := strconv.ParseFloat(string(token), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return number, nil
	default:
		return token, nil
	}
}

// Stringify serializes like JSON.stringify(value).
//
// It writes Object, []any, map[string]any (keys sorted, since Go maps have no
// order), strings, booleans, nil and every Go number type itself, passes
// json.RawMessage through compacted, and hands anything else (structs, typed
// maps and slices) to encoding/json without HTML escaping.
func Stringify(value any) (string, error) {
	var out strings.Builder
	if err := write(&out, value); err != nil {
		return "", err
	}
	return out.String(), nil
}

func write(out *strings.Builder, value any) error {
	switch value := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(value))
	case string:
		writeString(out, value)
	case float64:
		writeFloat(out, value)
	case float32:
		writeFloat(out, float64(value))
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		writeFloat(out, reflect.ValueOf(value).Convert(reflect.TypeFor[float64]()).Float())
	case json.Number:
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return fmt.Errorf("jsonx: invalid number %q", string(value))
		}
		writeFloat(out, number)
	case json.RawMessage:
		var compact bytes.Buffer
		if err := json.Compact(&compact, value); err != nil {
			return err
		}
		out.Write(compact.Bytes())
	case Object:
		out.WriteByte('{')
		for i, member := range jsOrder(value) {
			if i > 0 {
				out.WriteByte(',')
			}
			writeString(out, member.Key)
			out.WriteByte(':')
			if err := write(out, member.Value); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		object := make(Object, len(keys))
		for i, key := range keys {
			object[i] = Member{Key: key, Value: value[key]}
		}
		return write(out, object)
	case []any:
		out.WriteByte('[')
		for i, item := range value {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := write(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	default:
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(value); err != nil {
			return err
		}
		out.Write(bytes.TrimRight(buffer.Bytes(), "\n"))
	}
	return nil
}

// jsOrder returns members in the order a JavaScript object enumerates them:
// keys that are array indexes first, ascending, then the rest as inserted.
func jsOrder(object Object) Object {
	indexes := 0
	for _, member := range object {
		if _, ok := arrayIndex(member.Key); ok {
			indexes++
		}
	}
	if indexes == 0 {
		return object
	}
	ordered := make(Object, 0, len(object))
	for _, member := range object {
		if _, ok := arrayIndex(member.Key); ok {
			ordered = append(ordered, member)
		}
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		left, _ := arrayIndex(ordered[i].Key)
		right, _ := arrayIndex(ordered[j].Key)
		return left < right
	})
	for _, member := range object {
		if _, ok := arrayIndex(member.Key); !ok {
			ordered = append(ordered, member)
		}
	}
	return ordered
}

// arrayIndex reports whether key is a canonical array index (0 to 2^32-2).
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, false
		}
	}
	index, err := strconv.ParseUint(key, 10, 64)
	if err != nil || index >= math.MaxUint32 {
		return 0, false
	}
	return index, true
}

func writeFloat(out *strings.Builder, value float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		out.WriteString("null")
		return
	}
	out.WriteString(Number(value))
}

const hexDigits = "0123456789abcdef"

// writeString quotes s as JSON.stringify does: only ", \ and control
// characters are escaped.
func writeString(out *strings.Builder, s string) {
	out.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == '"':
			out.WriteString(`\"`)
		case r == '\\':
			out.WriteString(`\\`)
		case r == '\b':
			out.WriteString(`\b`)
		case r == '\f':
			out.WriteString(`\f`)
		case r == '\n':
			out.WriteString(`\n`)
		case r == '\r':
			out.WriteString(`\r`)
		case r == '\t':
			out.WriteString(`\t`)
		case r < 0x20:
			out.WriteString(`\u00`)
			out.WriteByte(hexDigits[r>>4])
			out.WriteByte(hexDigits[r&0xf])
		default:
			out.WriteString(s[i : i+size])
		}
		i += size
	}
	out.WriteByte('"')
}

// Number formats a number as JavaScript's String(number) does.
func Number(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == 0:
		return "0"
	}
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	// The shortest digits that round-trip, as ECMAScript requires: "d.ddde±x".
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(formatted, "e")
	exponent, _ := strconv.Atoi(exponentText)
	digits := strings.TrimRight(strings.Replace(mantissa, ".", "", 1), "0")
	if digits == "" {
		digits = "0"
	}
	k := len(digits)
	n := exponent + 1 // the decimal point's position relative to the digits
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	exponentPart := "e+" + strconv.Itoa(e)
	if e < 0 {
		exponentPart = "e-" + strconv.Itoa(-e)
	}
	if k == 1 {
		return sign + digits + exponentPart
	}
	return sign + digits[:1] + "." + digits[1:] + exponentPart
}

// String is JavaScript's String(value) for the values JSON can hold.
func String(value any) string {
	switch value := value.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(value)
	case string:
		return value
	case float64:
		return Number(value)
	case json.Number:
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil {
			return string(value)
		}
		return Number(number)
	case Object:
		return "[object Object]"
	case []any:
		parts := make([]string, len(value))
		for i, item := range value {
			if item != nil {
				parts[i] = String(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(value)
	}
}
