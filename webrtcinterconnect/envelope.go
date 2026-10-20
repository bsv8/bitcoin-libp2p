package webrtcinterconnect

import (
	"context"
	"encoding/json"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// SignalType enumerates the WebRTC interconnect signal payloads. Values are
// the exact JSON strings used by the TypeScript SDK.
type SignalType string

// Signal types.
const (
	SignalOffer           SignalType = "offer"
	SignalAnswer          SignalType = "answer"
	SignalICECandidate    SignalType = "ice-candidate"
	SignalEndOfCandidates SignalType = "end-of-candidates"
	SignalClose           SignalType = "close"
)

// Role identifies the WebRTC signaling role of a session.
type Role string

// Roles.
const (
	RoleInitiator Role = "initiator"
	RoleResponder Role = "responder"
)

// ICECandidate mirrors the browser RTCIceCandidateInit JSON shape.
type ICECandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// Signal is one WebRTC signaling payload.
type Signal struct {
	Type      SignalType    `json:"type"`
	SDP       string        `json:"sdp,omitempty"`
	Candidate *ICECandidate `json:"candidate,omitempty"`
	Reason    string        `json:"reason,omitempty"`
}

// Envelope is the routing metadata plus signal payload exchanged through the
// caller-provided signaling adapter. Field names match the TypeScript SDK.
type Envelope struct {
	ConnectionID string `json:"connectionId"`
	AttemptID    string `json:"attemptId"`
	From         string `json:"from"`
	To           string `json:"to"`
	Sequence     int64  `json:"sequence"`
	ExpiresAtMs  int64  `json:"expiresAtMs"`
	Signal       Signal `json:"signal"`
}

// MaxSafeInteger mirrors JavaScript Number.MAX_SAFE_INTEGER. Sequence values
// must stay inside the same range so both languages validate identically.
const MaxSafeInteger = int64(1)<<53 - 1

// ValidateEnvelope applies the shared envelope rules. maxSignalBytes limits
// the JSON-encoded signal payload; the TypeScript SDK uses the same limit.
func ValidateEnvelope(envelope Envelope, maxSignalBytes int) error {
	if maxSignalBytes <= 0 {
		return interconnectError(CodeSignal, StageSignal, "maxSignalBytes must be a positive integer", nil)
	}
	if err := validateIdentifier(envelope.ConnectionID, "connectionId"); err != nil {
		return err
	}
	if err := validateIdentifier(envelope.AttemptID, "attemptId"); err != nil {
		return err
	}
	if _, err := peer.Decode(envelope.From); err != nil {
		return interconnectError(CodeAddress, StageValidate, "WebRTC interconnect peer id is invalid", err)
	}
	if _, err := peer.Decode(envelope.To); err != nil {
		return interconnectError(CodeAddress, StageValidate, "WebRTC interconnect peer id is invalid", err)
	}
	if envelope.Sequence < 0 || envelope.Sequence > MaxSafeInteger {
		return interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal sequence or expiry is invalid", nil)
	}
	if envelope.ExpiresAtMs <= time.Now().UnixMilli() {
		return interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal has expired", nil)
	}
	encoded, err := json.Marshal(envelope.Signal)
	if err != nil {
		return interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal payload is invalid", err)
	}
	if len(encoded) > maxSignalBytes {
		return interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal exceeds the configured size limit", nil)
	}
	switch envelope.Signal.Type {
	case SignalOffer, SignalAnswer:
		if envelope.Signal.SDP == "" {
			return interconnectError(CodeSignal, StageSignal, "WebRTC SDP is invalid", nil)
		}
	case SignalICECandidate:
		if err := validateICECandidate(envelope.Signal.Candidate); err != nil {
			return err
		}
	case SignalClose:
		// Any reason string (including empty) is valid.
	case SignalEndOfCandidates:
		// No payload.
	default:
		return interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal type is invalid", nil)
	}
	return nil
}

// MarshalEnvelope validates and serializes an envelope.
func MarshalEnvelope(envelope Envelope, maxSignalBytes int) ([]byte, error) {
	if err := ValidateEnvelope(envelope, maxSignalBytes); err != nil {
		return nil, err
	}
	return json.Marshal(envelope)
}

// ParseEnvelope parses and validates an envelope.
func ParseEnvelope(data []byte, maxSignalBytes int) (Envelope, error) {
	var envelope Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Envelope{}, interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal envelope is invalid", err)
	}
	if err := ValidateEnvelope(envelope, maxSignalBytes); err != nil {
		return Envelope{}, err
	}
	return envelope, nil
}

func validateIdentifier(value, field string) error {
	if value == "" || len(value) > 128 {
		return interconnectError(CodeSignal, StageSignal, field+" is invalid", nil)
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return interconnectError(CodeSignal, StageSignal, field+" is invalid", nil)
		}
	}
	return nil
}

func validateICECandidate(candidate *ICECandidate) error {
	// A missing candidate is allowed (the TypeScript SDK ignores it). Any
	// present candidate string is accepted by the shared envelope rules.
	_ = candidate
	return nil
}

// newEnvelope builds a locally originated envelope with the next sequence.
func newEnvelope(s *session, signal Signal) Envelope {
	now := time.Now()
	return Envelope{
		ConnectionID: s.connectionID,
		AttemptID:    s.attemptID,
		From:         s.localPeer.String(),
		To:           s.remotePeer.String(),
		Sequence:     s.nextSequence(),
		ExpiresAtMs:  now.Add(s.t.options.SignalLifetime).UnixMilli(),
		Signal:       signal,
	}
}

// sendEnvelope validates and sends an envelope through the adapter.
func (s *session) sendEnvelope(ctx context.Context, envelope Envelope) error {
	if err := ValidateEnvelope(envelope, s.t.options.MaxSignalBytes); err != nil {
		return err
	}
	if err := s.t.options.Signaling.Send(ctx, envelope); err != nil {
		return interconnectError(CodeSignal, StageSignal, "WebRTC interconnect signal could not be sent", err)
	}
	return nil
}
