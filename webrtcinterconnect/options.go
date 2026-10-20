package webrtcinterconnect

import (
	"context"
	"fmt"
	"time"
)

// Defaults mirror the TypeScript SDK.
const (
	DefaultConnectionTimeout           = 30 * time.Second
	DefaultSignalLifetime              = 120 * time.Second
	DefaultMaxEarlySignals             = 1024
	DefaultMaxEarlySignalsPerConn      = 32
	DefaultMaxSignalBytes              = 256 * 1024
	DefaultDataChannelMaxMessageBytes  = 16 * 1024
	DefaultDataChannelMaxBufferedBytes = 2 * 1024 * 1024
)

// DataChannelLabel is the single DataChannel label used by the interconnect.
const DataChannelLabel = "bitcoin-libp2p-webrtc"

// ICEServer mirrors the browser RTCIceServer shape without exposing pion types.
type ICEServer struct {
	URLs       []string
	Username   string
	Credential string
}

// Options configures an interconnect transport.
type Options struct {
	// Signaling is required; it moves envelopes through the caller's message service.
	Signaling SignalAdapter

	// ICEServers are passed to pion; the SDK never hardcodes STUN or TURN.
	ICEServers []ICEServer

	// ConnectionTimeout bounds offer/answer/ICE setup. Default 30s.
	ConnectionTimeout time.Duration

	// SignalLifetime sets Envelope.ExpiresAtMs for local signals. Default 120s.
	SignalLifetime time.Duration

	// MaxEarlySignals bounds globally buffered pre-offer ICE signals. Default 1024.
	MaxEarlySignals int

	// MaxSignalBytes bounds the JSON-encoded signal payload. Default 256 KiB.
	MaxSignalBytes int

	// DataChannelMaxMessageBytes chunks writes to the DataChannel. Default 16 KiB.
	DataChannelMaxMessageBytes int

	// DataChannelMaxBufferedBytes pauses writes above this local buffer. Default 2 MiB.
	DataChannelMaxBufferedBytes int

	// IncludeLoopbackCandidates enables loopback ICE candidates (tests only).
	IncludeLoopbackCandidates bool
}

func (o Options) withDefaults() (Options, error) {
	if o.Signaling == nil {
		return o, interconnectError(CodeNotConfigured, StageValidate, "WebRTC interconnect signaling adapter is required", nil)
	}
	if o.ConnectionTimeout <= 0 {
		o.ConnectionTimeout = DefaultConnectionTimeout
	}
	if o.SignalLifetime <= 0 {
		o.SignalLifetime = DefaultSignalLifetime
	}
	if o.MaxEarlySignals <= 0 {
		o.MaxEarlySignals = DefaultMaxEarlySignals
	}
	if o.MaxSignalBytes <= 0 {
		o.MaxSignalBytes = DefaultMaxSignalBytes
	}
	if o.DataChannelMaxMessageBytes <= 0 {
		o.DataChannelMaxMessageBytes = DefaultDataChannelMaxMessageBytes
	}
	if o.DataChannelMaxBufferedBytes <= 0 {
		o.DataChannelMaxBufferedBytes = DefaultDataChannelMaxBufferedBytes
	}
	if o.MaxSignalBytes <= 0 || o.DataChannelMaxMessageBytes <= 0 {
		return o, interconnectError(CodeNotConfigured, StageValidate, "WebRTC interconnect limits must be positive", nil)
	}
	return o, nil
}

// maxEarlySignalsPerConnection mirrors min(32, MaxEarlySignals) in the TS SDK.
func (o Options) maxEarlySignalsPerConnection() int {
	value := DefaultMaxEarlySignalsPerConn
	if o.MaxEarlySignals < value {
		value = o.MaxEarlySignals
	}
	if value < 1 {
		value = 1
	}
	return value
}

func (o Options) String() string {
	return fmt.Sprintf("webrtcinterconnect(options: timeout=%s lifetime=%s)", o.ConnectionTimeout, o.SignalLifetime)
}

var _ = context.Background
