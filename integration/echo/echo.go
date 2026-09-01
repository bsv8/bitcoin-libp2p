// Package echo is a test-only raw byte protocol. It is never registered by
// either SDK host assembler.
package echo

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/bsv8/bitcoin-libp2p/streamio"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
)

const ProtocolID protocol.ID = "/bitcoin-libp2p/test/echo/1.0.0"

// FramingProtocolID is a test-only protocol profile that explicitly opts into
// bitcoin-libp2p uvarint framing. The production SDK does not register it.
const FramingProtocolID protocol.ID = "/bitcoin-libp2p/test/uvarint-framing/1.0.0"

const MaxPayload = 1 << 20

// Install attaches only the test echo handler to a caller-owned host.
func Install(h host.Host) {
	h.SetStreamHandler(ProtocolID, func(stream network.Stream) {
		go func() {
			defer stream.Close()
			payload, err := io.ReadAll(io.LimitReader(stream, MaxPayload+1))
			if err != nil || len(payload) > MaxPayload {
				_ = stream.Reset()
				return
			}
			_, _ = stream.Write(payload)
			_ = stream.CloseWrite()
		}()
	})
}

// InstallFraming attaches a test handler whose payload boundary is supplied by
// streamio. The handler does not interpret the payload bytes.
func InstallFraming(h host.Host) {
	h.SetStreamHandler(FramingProtocolID, func(stream network.Stream) {
		go func() {
			defer stream.Close()
			framer, err := streamio.NewUvarintFramer(stream)
			if err != nil {
				_ = stream.Reset()
				return
			}
			for {
				payload, err := framer.ReadFrame()
				if err == io.EOF {
					break
				}
				if err != nil {
					_ = stream.Reset()
					return
				}
				if err := framer.WriteFrame(payload); err != nil {
					_ = stream.Reset()
					return
				}
			}
			_ = stream.CloseWrite()
		}()
	})
}

// FramingRoundTrip exchanges several payloads on one stream without using EOF
// as an individual message boundary. EOF is sent only after the final frame.
func FramingRoundTrip(ctx context.Context, h host.Host, id peer.ID, payloads [][]byte) ([][]byte, error) {
	if len(payloads) == 0 {
		return nil, fmt.Errorf("at least one framed payload is required")
	}
	stream, err := h.NewStream(ctx, id, FramingProtocolID)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	framer, err := streamio.NewUvarintFramer(stream)
	if err != nil {
		return nil, err
	}
	for _, payload := range payloads {
		if err := framer.WriteFrame(payload); err != nil {
			return nil, err
		}
	}
	if err := stream.CloseWrite(); err != nil {
		return nil, err
	}
	responses := make([][]byte, 0, len(payloads))
	for {
		payload, err := framer.ReadFrame()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		responses = append(responses, payload)
	}
	if len(responses) != len(payloads) {
		return nil, fmt.Errorf("framing response count %d does not match %d", len(responses), len(payloads))
	}
	for index := range payloads {
		if !bytes.Equal(responses[index], payloads[index]) {
			return nil, fmt.Errorf("framing response %d does not match payload", index)
		}
	}
	return responses, nil
}

func RoundTrip(ctx context.Context, h host.Host, id peer.ID, payload []byte) ([]byte, error) {
	if len(payload) == 0 || len(payload) > MaxPayload {
		return nil, fmt.Errorf("echo payload must be 1..%d bytes", MaxPayload)
	}
	stream, err := h.NewStream(ctx, id, ProtocolID)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	if _, err := stream.Write(payload); err != nil {
		return nil, err
	}
	if err := stream.CloseWrite(); err != nil {
		return nil, err
	}
	response, err := io.ReadAll(io.LimitReader(stream, MaxPayload+1))
	if err != nil {
		return nil, err
	}
	if len(response) != len(payload) {
		return nil, fmt.Errorf("echo response length %d does not match %d", len(response), len(payload))
	}
	return response, nil
}
