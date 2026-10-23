package webhookscc

import (
	"errors"
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
