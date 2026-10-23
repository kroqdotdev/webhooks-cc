package jsonx

import (
	"encoding/json"
	"math"
	"testing"
)

func TestNumberMatchesJavaScript(t *testing.T) {
	cases := map[float64]string{
		0:                    "0",
		math.Copysign(0, -1): "0",
		1:                    "1",
		-1.5:                 "-1.5",
		100:                  "100",
		123.456:              "123.456",
		0.30000000000000004:  "0.30000000000000004",
		0.000001:             "0.000001",
		0.0000001:            "1e-7",
		1.5e-7:               "1.5e-7",
		1e20:                 "100000000000000000000",
		1e21:                 "1e+21",
		1.2345e21:            "1.2345e+21",
		9007199254740992:     "9007199254740992",
		5e-324:               "5e-324",
		math.MaxFloat64:      "1.7976931348623157e+308",
		12345678901234567890: "12345678901234567000",
		-0.00001234:          "-0.00001234",
	}
	for input, want := range cases {
		if got := Number(input); got != want {
			t.Errorf("Number(%v) = %q, want %q", input, got, want)
		}
	}
	if got := Number(math.NaN()); got != "NaN" {
		t.Errorf("Number(NaN) = %q", got)
	}
}

func TestRoundTripKeepsOrderAndText(t *testing.T) {
	input := `{"b":1,"a":{"z":[1,2.5,"x<y>&z",null,true]},"note":"café ✓  ","esc":"q\"\\\n\u0001"}`
	value, err := Parse([]byte(input))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Stringify(value)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"b\":1,\"a\":{\"z\":[1,2.5,\"x<y>&z\",null,true]},\"note\":\"café ✓  \",\"esc\":\"q\\\"\\\\\\n\\u0001\"}"
	if got != want {
		t.Errorf("Stringify(Parse(x)) =\n%s\nwant\n%s", got, want)
	}
}

func TestObjectsEnumerateLikeJavaScript(t *testing.T) {
	// A repeated key keeps its first position and its last value; array-index
	// keys come first, ascending.
	value, err := Parse([]byte(`{"b":1,"10":2,"a":3,"2":4,"b":5,"01":6}`))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := Stringify(value)
	if want := `{"2":4,"10":2,"b":5,"a":3,"01":6}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestStringifyOtherValues(t *testing.T) {
	type payload struct {
		Name string `json:"name"`
		HTML string `json:"html"`
	}
	cases := []struct {
		value any
		want  string
	}{
		{map[string]any{"b": 1, "a": []any{int64(2), uint8(3)}}, `{"a":[2,3],"b":1}`},
		{payload{Name: "Acme", HTML: "<b>&</b>"}, `{"name":"Acme","html":"<b>&</b>"}`},
		{json.RawMessage("{ \"a\" : 1 }"), `{"a":1}`},
		{math.Inf(1), "null"},
		{json.Number("1.50"), "1.5"},
	}
	for _, c := range cases {
		got, err := Stringify(c.value)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("Stringify(%#v) = %s, want %s", c.value, got, c.want)
		}
	}
}

func TestString(t *testing.T) {
	cases := []struct {
		value any
		want  string
	}{
		{nil, "null"},
		{true, "true"},
		{float64(10), "10"},
		{"x", "x"},
		{[]any{float64(1), nil, "a"}, "1,,a"},
	}
	for _, c := range cases {
		if got := String(c.value); got != c.want {
			t.Errorf("String(%#v) = %q, want %q", c.value, got, c.want)
		}
	}
}
