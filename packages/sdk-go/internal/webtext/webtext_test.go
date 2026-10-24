package webtext

import (
	"slices"
	"testing"
)

func TestFormParamsMatchURLSearchParams(t *testing.T) {
	got := FormParams("?a=1&&b&c=x+y%2Bz&a=%zz%4&d=%E2%82&e=%F0%9F%98%80=")
	want := [][2]string{{"a", "1"}, {"b", ""}, {"c", "x y+z"}, {"a", "%zz%4"}, {"d", "�"}, {"e", "😀="}}
	if !slices.Equal(got, want) {
		t.Errorf("FormParams = %q\nwant %q", got, want)
	}
}

func TestDecodeUTF8ReplacesLikeTextDecoder(t *testing.T) {
	cases := map[string]string{
		"plain":                   "plain",
		"a\xff\xfeb\xed\xa0\x80c": "a��b���c",
		"\xe2\x82":                "�",
		"\xf0\x9f\x98":            "�",
		"\xf0\x9f\x98\x80\xc3":    "😀�",
		"\xe0\x80\xaf":            "���",
	}
	for input, want := range cases {
		if got := DecodeUTF8([]byte(input)); got != want {
			t.Errorf("DecodeUTF8(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestJSTrimTrimsWhatJavaScriptTrims(t *testing.T) {
	cases := map[string]string{
		" \ufeffa\u3000":     "a",
		"\u0085a\u0085":      "\u0085a\u0085", // TrimSpace would take these
		"\x1ca\x1c":          "\x1ca\x1c",
		"\t\v\f\r\n a\u00a0": "a",
	}
	for in, want := range cases {
		if got := JSTrim(in); got != want {
			t.Errorf("JSTrim(%q) = %q; want %q", in, got, want)
		}
	}
}
