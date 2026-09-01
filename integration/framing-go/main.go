// Command framing-go is a test-only JSON-lines adapter for the shared framing
// fixture. It deliberately exposes only payload/frame hex and stable codes.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/bsv8/bitcoin-libp2p/streamio"
)

type request struct {
	Payloads             []string `json:"payloads"`
	Frames               []string `json:"frames"`
	Chunks               []string `json:"chunks"`
	Input                string   `json:"input"`
	MaxInboundFrameBytes int      `json:"maxInboundFrameBytes"`
}

type response struct {
	Event    string   `json:"event"`
	Frames   []string `json:"frames,omitempty"`
	Payloads []string `json:"payloads,omitempty"`
	Code     string   `json:"code,omitempty"`
}

func main() {
	mode := "encode"
	if len(os.Args) == 3 && os.Args[1] == "-mode" {
		mode = os.Args[2]
	}
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(err)
	}

	switch mode {
	case "encode":
		encode(input)
	case "decode":
		decode(input)
	case "invalid":
		decode(request{Chunks: []string{input.Input}, MaxInboundFrameBytes: input.MaxInboundFrameBytes})
	default:
		fatal(fmt.Errorf("unsupported mode %q", mode))
	}
}

func encode(input request) {
	frames := make([]string, 0, len(input.Payloads))
	for _, value := range input.Payloads {
		payload, err := hex.DecodeString(value)
		if err != nil {
			fatal(err)
		}
		var stream bytes.Buffer
		framer, err := streamio.NewUvarintFramer(&stream)
		if err != nil {
			fatal(err)
		}
		if err := framer.WriteFrame(payload); err != nil {
			fatal(err)
		}
		frames = append(frames, hex.EncodeToString(stream.Bytes()))
	}
	emit(response{Event: "encoded", Frames: frames})
}

func decode(input request) {
	var stream bytes.Buffer
	for _, value := range input.Chunks {
		chunk, err := hex.DecodeString(value)
		if err != nil {
			fatal(err)
		}
		_, _ = stream.Write(chunk)
	}
	max := input.MaxInboundFrameBytes
	var options []streamio.UvarintFramerOption
	if max != 0 {
		options = append(options, streamio.WithMaxInboundFrameBytes(max))
	}
	framer, err := streamio.NewUvarintFramer(&stream, options...)
	if err != nil {
		fatal(err)
	}
	payloads := make([]string, 0)
	for {
		payload, err := framer.ReadFrame()
		if err == io.EOF {
			emit(response{Event: "decoded", Payloads: payloads})
			return
		}
		if err != nil {
			emit(response{Event: "error", Code: classify(err)})
			return
		}
		payloads = append(payloads, hex.EncodeToString(payload))
	}
}

func classify(err error) string {
	switch {
	case errors.Is(err, streamio.ErrFramePrefix):
		return "ERR_FRAME_PREFIX"
	case errors.Is(err, streamio.ErrFrameTooLarge):
		return "ERR_FRAME_TOO_LARGE"
	case errors.Is(err, streamio.ErrFrameTruncated):
		return "ERR_FRAME_TRUNCATED"
	case errors.Is(err, streamio.ErrFrameStream):
		return "ERR_FRAME_STREAM"
	default:
		return "UNKNOWN"
	}
}

func emit(value response) {
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
