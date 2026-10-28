package webhookscc

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestBackoffDelayDoublesUpToACap(t *testing.T) {
	cases := []struct {
		base    time.Duration
		attempt int
		want    time.Duration
	}{
		{time.Second, 1, time.Second},
		{time.Second, 2, 2 * time.Second},
		{time.Second, 5, 16 * time.Second},
		{time.Second, 6, 30 * time.Second},
		{time.Second, 500, 30 * time.Second}, // no overflow
		{time.Minute, 3, time.Minute},        // a longer base is kept
		{time.Millisecond, 3, 4 * time.Millisecond},
	}
	for _, c := range cases {
		if got := backoffDelay(c.base, c.attempt); got != c.want {
			t.Errorf("backoffDelay(%s, %d) = %s, want %s", c.base, c.attempt, got, c.want)
		}
	}
}

func TestSSEReaderRefusesOversizedLinesAndEvents(t *testing.T) {
	previous := maxSSEBytes
	maxSSEBytes = 100
	defer func() { maxSSEBytes = previous }()

	read := func(stream string) (sseFrame, error) {
		return newSSEReader(strings.NewReader(stream), nil).next()
	}
	if frame, err := read("event: request\ndata: " + strings.Repeat("x", 50) + "\n\n"); err != nil || len(frame.data) != 50 {
		t.Errorf("a small event: %v, %v", frame, err)
	}
	if _, err := read("data: " + strings.Repeat("x", 200)); !errors.Is(err, errSSETooLarge) {
		t.Errorf("an unterminated long line: %v", err)
	}
	many := strings.Repeat("data: "+strings.Repeat("x", 40)+"\n", 5) + "\n"
	if _, err := read(many); !errors.Is(err, errSSETooLarge) {
		t.Errorf("an event of many lines: %v", err)
	}
}

// Header numbers read as parseInt reads them: ASCII digits after JavaScript's
// whitespace, with the header's bytes taken as Latin-1.
func TestHeaderDigitsSkipJavaScriptWhitespace(t *testing.T) {
	cases := map[string]string{
		"7":      "7",
		" \t7s":  "7",
		"\xa07":  "7", // a no-break space
		"\x857":  "",  // U+0085 is not whitespace to JavaScript
		"\x1c7":  "",
		"\u0663": "", // an Arabic-Indic digit
		"seven":  "",
		"12, 3":  "12",
		"":       "",
	}
	for value, want := range cases {
		header := http.Header{"Retry-After": {value}}
		got, ok := headerDigits(header, "Retry-After")
		if got != want || ok != (want != "") {
			t.Errorf("headerDigits(%q) = %q, %v; want %q", value, got, ok, want)
		}
	}
}

func TestConnectionNeverPrintsItsClaimToken(t *testing.T) {
	conn := &Connection{registrationID: "reg_1", claimToken: "clm_secret"}
	sandbox := &Sandbox{registrationID: "reg_2", claimToken: "clm_secret"}
	for _, value := range []any{conn, sandbox} {
		for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
			if got := fmt.Sprintf(format, value); strings.Contains(got, "clm_") {
				t.Fatalf("%s printed the claim token: %s", format, got)
			}
		}
	}
}
