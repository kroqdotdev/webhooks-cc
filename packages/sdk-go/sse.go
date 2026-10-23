package webhookscc

import (
	"bufio"
	"errors"
	"io"
	"strings"
)

// maxSSEBytes caps one line and one event's data. Request events carry the
// whole captured request, and an email reaches 10 MiB before JSON escaping.
var maxSSEBytes = 64 << 20

var errSSETooLarge = errors.New("webhooks.cc: stream event larger than 64 MiB")

// sseFrame is one server-sent event. Comments (": ...") come through as
// frames with event "comment", which is how the server's keepalives show up.
type sseFrame struct {
	event string
	data  string
}

// sseReader reads frames from an event stream.
type sseReader struct {
	reader *bufio.Reader
	// onLine is called for every line read, keepalives included.
	onLine func()
	event  string
	data   []string
	size   int
}

func newSSEReader(r io.Reader, onLine func()) *sseReader {
	return &sseReader{reader: bufio.NewReaderSize(r, 64<<10), onLine: onLine, event: "message"}
}

// next returns the next frame, or the read error (io.EOF at the end).
func (s *sseReader) next() (sseFrame, error) {
	for {
		line, err := s.readLine()
		if errors.Is(err, errSSETooLarge) {
			return sseFrame{}, err
		}
		if err != nil && (err != io.EOF || line == "") {
			if err == io.EOF && len(s.data) > 0 {
				return s.flush(), nil
			}
			return sseFrame{}, err
		}
		if s.onLine != nil {
			s.onLine()
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			if len(s.data) > 0 {
				return s.flush(), nil
			}
			s.event = "message"
			continue
		}
		if strings.HasPrefix(line, ":") {
			return sseFrame{event: "comment", data: strings.TrimPrefix(line[1:], " ")}, nil
		}
		name, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch name {
		case "event":
			s.event = value
		case "data":
			if s.size += len(value) + 1; s.size > maxSSEBytes {
				return sseFrame{}, errSSETooLarge
			}
			s.data = append(s.data, value)
		}
	}
}

func (s *sseReader) flush() sseFrame {
	frame := sseFrame{event: s.event, data: strings.Join(s.data, "\n")}
	s.event = "message"
	s.data = nil
	s.size = 0
	return frame
}

// readLine reads up to and including the next newline, refusing a line
// longer than maxSSEBytes instead of buffering it whole.
func (s *sseReader) readLine() (string, error) {
	var line []byte
	for {
		chunk, err := s.reader.ReadSlice('\n')
		if len(line)+len(chunk) > maxSSEBytes {
			return "", errSSETooLarge
		}
		line = append(line, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return string(line), err
	}
}
