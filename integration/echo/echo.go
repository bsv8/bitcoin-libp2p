// Package echo is a test-only raw byte protocol. It is never registered by
// either SDK host assembler.
package echo

import (
	"context"
	"fmt"
	"io"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
)

const ProtocolID protocol.ID = "/bitcoin-libp2p/test/echo/1.0.0"

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
