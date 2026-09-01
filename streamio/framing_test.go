package streamio

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

type framingFixture struct {
	FixedVectors   []fixtureVector  `json:"fixedVectors"`
	PayloadVectors []payloadVector  `json:"payloadVectors"`
	InvalidCases   []invalidFixture `json:"invalidCases"`
	LimitCases     []limitFixture   `json:"limitCases"`
}

type fixtureVector struct {
	Name              string `json:"name"`
	PayloadByteLength int    `json:"payloadByteLength"`
	PayloadHex        string `json:"payloadHex"`
	PayloadPattern    string `json:"payloadPattern"`
	PrefixHex         string `json:"prefixHex"`
}

type payloadVector struct {
	Name       string `json:"name"`
	PayloadHex string `json:"payloadHex"`
}

type invalidFixture struct {
	Name     string `json:"name"`
	InputHex string `json:"inputHex"`
	Code     string `json:"code"`
}

type limitFixture struct {
	Name                 string `json:"name"`
	MaxInboundFrameBytes int    `json:"maxInboundFrameBytes"`
	FrameName            string `json:"frameName"`
	InputHex             string `json:"inputHex"`
	Code                 string `json:"code"`
}

func TestUvarintFramerUsesSharedFixture(t *testing.T) {
	fixture := readFixture(t)
	for _, vector := range fixture.FixedVectors {
		payload := fixturePayload(t, vector.PayloadHex, vector.PayloadPattern, vector.PayloadByteLength)
		var encodedPrefix [binary.MaxVarintLen64]byte
		prefixLength := binary.PutUvarint(encodedPrefix[:], uint64(len(payload)))
		if got := hex.EncodeToString(encodedPrefix[:prefixLength]); got != vector.PrefixHex {
			t.Errorf("%s: prefix = %s, want %s", vector.Name, got, vector.PrefixHex)
		}

		var stream bytes.Buffer
		framer, err := NewUvarintFramer(&stream)
		if err != nil {
			t.Fatalf("%s: NewUvarintFramer: %v", vector.Name, err)
		}
		if err := framer.WriteFrame(payload); err != nil {
			t.Fatalf("%s: WriteFrame: %v", vector.Name, err)
		}
		if !bytes.HasPrefix(stream.Bytes(), encodedPrefix[:prefixLength]) {
			t.Errorf("%s: encoded frame has unexpected prefix %x", vector.Name, stream.Bytes()[:prefixLength])
		}

		decoded, err := NewUvarintFramer(&readWriter{Reader: bytes.NewBuffer(append([]byte(nil), stream.Bytes()...)), Writer: io.Discard})
		if err != nil {
			t.Fatalf("%s: decoder construction: %v", vector.Name, err)
		}
		got, err := decoded.ReadFrame()
		if err != nil {
			t.Fatalf("%s: ReadFrame: %v", vector.Name, err)
		}
		if !bytes.Equal(got, payload) {
			t.Errorf("%s: decoded payload differs", vector.Name)
		}
	}
}

func TestReadFrameCopiesPayloadOwnership(t *testing.T) {
	input := []byte{0x03, 0x01, 0x02, 0x03, 0x00}
	reader := bytes.NewReader(input)
	framer, err := NewUvarintFramer(&readWriter{Reader: reader, Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	first, err := framer.ReadFrame()
	if err != nil {
		t.Fatal(err)
	}
	second, err := framer.ReadFrame()
	if err != nil {
		t.Fatal(err)
	}
	input[1] = 0xff
	if !bytes.Equal(first, []byte{1, 2, 3}) {
		t.Fatalf("first payload was aliased: %x", first)
	}
	if second == nil || len(second) != 0 {
		t.Fatalf("zero-length payload = %v, want an empty payload", second)
	}
}

func TestReadFrameClassifiesSharedInvalidCases(t *testing.T) {
	fixture := readFixture(t)
	for _, invalid := range fixture.InvalidCases {
		t.Run(invalid.Name, func(t *testing.T) {
			input := decodeHex(t, invalid.InputHex)
			framer, err := NewUvarintFramer(&readWriter{Reader: bytes.NewReader(input), Writer: io.Discard})
			if err != nil {
				t.Fatal(err)
			}
			_, err = framer.ReadFrame()
			if invalid.Code == "ERR_FRAME_PREFIX" && !errors.Is(err, ErrFramePrefix) {
				t.Fatalf("error = %v, want ErrFramePrefix", err)
			}
			if invalid.Code == "ERR_FRAME_TRUNCATED" && !errors.Is(err, ErrFrameTruncated) {
				t.Fatalf("error = %v, want ErrFrameTruncated", err)
			}
		})
	}
}

func TestReadFrameRejectsTooLargeBeforePayloadRead(t *testing.T) {
	fixture := readFixture(t)
	for _, limit := range fixture.LimitCases {
		if limit.Code == "" {
			continue
		}
		t.Run(limit.Name, func(t *testing.T) {
			reader := &requestTrackingReader{reader: bytes.NewReader(decodeHex(t, limit.InputHex))}
			framer, err := NewUvarintFramer(&readWriter{Reader: reader, Writer: io.Discard}, WithMaxInboundFrameBytes(limit.MaxInboundFrameBytes))
			if err != nil {
				t.Fatal(err)
			}
			_, err = framer.ReadFrame()
			if !errors.Is(err, ErrFrameTooLarge) {
				t.Fatalf("error = %v, want ErrFrameTooLarge", err)
			}
			if reader.maxRequest > 1 {
				t.Fatalf("payload read was attempted with request size %d", reader.maxRequest)
			}
		})
	}
}

func TestReadFrameReturnsCleanEOFOnlyBeforePrefix(t *testing.T) {
	framer, err := NewUvarintFramer(&readWriter{Reader: bytes.NewReader(nil), Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	_, err = framer.ReadFrame()
	if !errors.Is(err, io.EOF) || errors.Is(err, ErrFrameTruncated) {
		t.Fatalf("clean EOF error = %v", err)
	}
}

func TestWriteFrameHandlesShortWrites(t *testing.T) {
	payload := []byte{0x00, 0xff, 0x80, 0x01}
	writer := &shortWriter{maxBytes: 1}
	framer, err := NewUvarintFramer(struct {
		io.Reader
		io.Writer
	}{Reader: bytes.NewReader(nil), Writer: writer})
	if err != nil {
		t.Fatal(err)
	}
	if err := framer.WriteFrame(payload); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(writer.data, append([]byte{byte(len(payload))}, payload...)) {
		t.Fatalf("short-write output = %x", writer.data)
	}
}

func TestConcurrentWriteFramesDoNotInterleave(t *testing.T) {
	writer := &lockedWriter{}
	framer, err := NewUvarintFramer(struct {
		io.Reader
		io.Writer
	}{Reader: bytes.NewReader(nil), Writer: writer})
	if err != nil {
		t.Fatal(err)
	}

	const count = 64
	var group sync.WaitGroup
	group.Add(count)
	for index := 0; index < count; index++ {
		index := index
		go func() {
			defer group.Done()
			payload := []byte{byte(index), byte(index >> 8), 0, 0xff}
			if err := framer.WriteFrame(payload); err != nil {
				t.Errorf("WriteFrame(%d): %v", index, err)
			}
		}()
	}
	group.Wait()

	reader, err := NewUvarintFramer(&readWriter{Reader: bytes.NewReader(writer.Bytes()), Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool, count)
	for index := 0; index < count; index++ {
		payload, err := reader.ReadFrame()
		if err != nil {
			t.Fatalf("ReadFrame(%d): %v", index, err)
		}
		seen[string(payload)] = true
	}
	if len(seen) != count {
		t.Fatalf("decoded %d distinct frames, want %d", len(seen), count)
	}
}

func TestErrorsIsMatchesStableCategoryAndCause(t *testing.T) {
	underlying := errors.New("reader failed")
	framer, err := NewUvarintFramer(&readWriter{Reader: &errorReader{err: underlying}, Writer: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	_, err = framer.ReadFrame()
	if !errors.Is(err, ErrFrameStream) || !errors.Is(err, underlying) {
		t.Fatalf("read error = %v, stable/cause match failed", err)
	}

	writerError := errors.New("writer failed")
	writerFramer, err := NewUvarintFramer(struct {
		io.Reader
		io.Writer
	}{Reader: bytes.NewReader(nil), Writer: &errorWriter{err: writerError}})
	if err != nil {
		t.Fatal(err)
	}
	if err := writerFramer.WriteFrame([]byte{1}); !errors.Is(err, ErrFrameStream) || !errors.Is(err, writerError) {
		t.Fatalf("write error = %v, stable/cause match failed", err)
	}
}

func readFixture(t *testing.T) framingFixture {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(source), "..", "testdata", "uvarint-framing-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture framingFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func fixturePayload(t *testing.T, payloadHex, pattern string, length int) []byte {
	t.Helper()
	if payloadHex != "" {
		payload := decodeHex(t, payloadHex)
		if len(payload) != length {
			t.Fatalf("payload length = %d, want %d", len(payload), length)
		}
		return payload
	}
	payload := make([]byte, length)
	if pattern == "incrementing-byte" {
		for index := range payload {
			payload[index] = byte(index)
		}
	}
	return payload
}

func decodeHex(t *testing.T, value string) []byte {
	t.Helper()
	payload, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("invalid fixture hex %q: %v", value, err)
	}
	return payload
}

type requestTrackingReader struct {
	reader     io.Reader
	maxRequest int
}

type readWriter struct {
	io.Reader
	io.Writer
}

func (reader *requestTrackingReader) Read(data []byte) (int, error) {
	if len(data) > reader.maxRequest {
		reader.maxRequest = len(data)
	}
	return reader.reader.Read(data)
}

type shortWriter struct {
	data     []byte
	maxBytes int
}

func (writer *shortWriter) Write(data []byte) (int, error) {
	count := len(data)
	if count > writer.maxBytes {
		count = writer.maxBytes
	}
	writer.data = append(writer.data, data[:count]...)
	return count, nil
}

type lockedWriter struct {
	mu   sync.Mutex
	data []byte
}

func (writer *lockedWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.data = append(writer.data, data...)
	return len(data), nil
}

func (writer *lockedWriter) Bytes() []byte {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return append([]byte(nil), writer.data...)
}

type errorReader struct{ err error }

func (reader *errorReader) Read([]byte) (int, error) { return 0, reader.err }

type errorWriter struct{ err error }

func (writer *errorWriter) Write([]byte) (int, error) { return 0, writer.err }
