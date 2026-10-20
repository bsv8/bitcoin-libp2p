// Package webrtcinterconnect implements the Go side of the external-signaling
// WebRTC interconnect defined by bitcoin-libp2p V1.4.
//
// The package is protocol-neutral: callers provide a signaling adapter that
// transports opaque envelopes over their own message service. The transport
// turns a WebRTC DataChannel into a standard libp2p connection through the
// host upgrader (Noise + Yamux).
package webrtcinterconnect

import (
	"errors"
	"fmt"
)

// ErrorStage identifies where an interconnect error happened.
type ErrorStage string

// Error stages; values match the TypeScript SDK.
const (
	StageValidate     ErrorStage = "validate"
	StageSignal       ErrorStage = "signal"
	StageDial         ErrorStage = "dial"
	StageConnect      ErrorStage = "connect"
	StageAuthenticate ErrorStage = "authenticate"
	StageShutdown     ErrorStage = "shutdown"
)

// ErrorCode is a stable interconnect error identifier.
type ErrorCode string

// Stable error codes; values match the TypeScript SDK.
const (
	CodeAddress       ErrorCode = "ERR_WEBRTC_INTERCONNECT_ADDRESS"
	CodeSignal        ErrorCode = "ERR_WEBRTC_INTERCONNECT_SIGNAL"
	CodeTimeout       ErrorCode = "ERR_WEBRTC_INTERCONNECT_TIMEOUT"
	CodeDial          ErrorCode = "ERR_WEBRTC_INTERCONNECT_DIAL"
	CodeAuth          ErrorCode = "ERR_WEBRTC_INTERCONNECT_AUTH"
	CodeNotConfigured ErrorCode = "ERR_WEBRTC_INTERCONNECT_NOT_CONFIGURED"
	CodeShutdown      ErrorCode = "ERR_WEBRTC_INTERCONNECT_SHUTDOWN"
)

// Error is a classified interconnect error.
type Error struct {
	Code    ErrorCode
	Stage   ErrorStage
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Cause != nil {
		return fmt.Sprintf("%s (%s/%s): %v", e.Message, e.Code, e.Stage, e.Cause)
	}
	return fmt.Sprintf("%s (%s/%s)", e.Message, e.Code, e.Stage)
}

// Unwrap exposes the cause for errors.Is/errors.As.
func (e *Error) Unwrap() error { return e.Cause }

func interconnectError(code ErrorCode, stage ErrorStage, message string, cause error) *Error {
	return &Error{Code: code, Stage: stage, Message: message, Cause: cause}
}

// ErrorCodeOf returns the stable code of an interconnect error, or
// "ERR_WEBRTC_INTERCONNECT_UNKNOWN" for any other error.
func ErrorCodeOf(err error) ErrorCode {
	var interconnect *Error
	if errors.As(err, &interconnect) {
		return interconnect.Code
	}
	return "ERR_WEBRTC_INTERCONNECT_UNKNOWN"
}

// ErrorStageOf returns the stage of an interconnect error, or an empty string.
func ErrorStageOf(err error) ErrorStage {
	var interconnect *Error
	if errors.As(err, &interconnect) {
		return interconnect.Stage
	}
	return ""
}
